"""Viva (voice oral exam) orchestrator.

Runs an in-process multi-agent pipeline on top of the existing Groq client:

- **Examiner** agent generates each question grounded in the user's indexed
  documents (Qdrant context) and never repeats a prior question.
- **Evaluator** agent scores the transcribed spoken answer each turn and
  records the score/missed points/feedback on the turn row.
- **Reporter** agent writes the improvement report (strengths, weaknesses,
  revision plan, summary) once the last question is answered.

The only external seams are `_agent_complete()` (LLM) and `_context_str()`
(Qdrant retrieval) so the state machine can be smoke-tested without network.
"""

import base64
import json
import logging
import re
from datetime import datetime, timezone

from config import settings
from services import rag
from services.voice import synthesize_speech, transcribe_audio
from system_prompt import (
    VIVA_EVALUATOR_PROMPT,
    VIVA_EXAMINER_PROMPT,
    VIVA_REPORTER_PROMPT,
)

log = logging.getLogger("athenaeum.viva")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# --------------------------------------------------------------------------- #
# Seams (easy to patch in smoke tests)
# --------------------------------------------------------------------------- #
def _context_str(query: str, user_id: str, document_ids: list[str] | None, k: int) -> str:
    return rag._retrieve_context(query, user_id, document_ids, k)


def _agent_complete(system_prompt: str, user_message: str) -> str:
    return rag._complete(system_prompt, user_message, json_mode=True)


def _coerce_json(content: str, what: str) -> dict:
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        match = re.search(r"\{.*\}", content or "", re.DOTALL)
        if not match:
            raise ValueError(f"Viva {what} returned invalid JSON: {content}")
        try:
            data = json.loads(match.group(0))
        except (json.JSONDecodeError, TypeError):
            raise ValueError(f"Viva {what} returned invalid JSON: {content}")
    if not isinstance(data, dict):
        raise ValueError(f"Viva {what} returned a non-object payload")
    return data


def _model_json(system_prompt: str, user_message: str, what: str) -> dict:
    return _coerce_json(_agent_complete(system_prompt, user_message), what)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _document_ids(session) -> list[str]:
    try:
        ids = json.loads(session.selected_docs or "[]")
    except (json.JSONDecodeError, TypeError):
        ids = []
    return [str(i) for i in ids if not isinstance(i, dict)]


def _turns(db, session_id: str):
    from models import VivaTurn as VivaTurnRow

    return (
        db.query(VivaTurnRow)
        .filter(VivaTurnRow.session_id == session_id)
        .order_by(VivaTurnRow.created_at.asc())
        .all()
    )


def _prior_qa(turns) -> str:
    parts = ["Questions already asked (do NOT repeat):"]
    for i, turn in enumerate(turns, 1):
        answer = turn.answer_text or "(not answered yet)"
        parts.append(f"{i}. Q: {turn.question}")
        parts.append(f"   A: {answer[:200]}")
    return "\n".join(parts)


def _transcript(turns) -> str:
    parts = []
    for i, turn in enumerate(turns, 1):
        try:
            evaluation = json.loads(turn.evaluation or "{}")
        except (json.JSONDecodeError, TypeError):
            evaluation = {}
        score = evaluation.get("score", "?")
        feedback = evaluation.get("feedback", "")
        parts.append(f"Q{i}: {turn.question}")
        parts.append(f"A{i}: {turn.answer_text}")
        parts.append(f"Score: {score}/10. Feedback: {feedback}")
    return "\n".join(parts)


def _question_payload(turn, index: int, total: int) -> dict:
    audio = synthesize_speech(turn.question)
    return {
        "question": turn.question,
        "question_audio": base64.b64encode(audio).decode("ascii"),
        "turn_index": index,
        "total_questions": total,
        "page": turn.page or None,
    }


def _next_question(db, session) -> tuple[str, str]:
    turns = _turns(db, session.id)
    answered = [t for t in turns if t.answer_text]
    context = _context_str(
        session.topic, session.user_id, _document_ids(session), settings.VIVA_K_CONTEXT
    )
    if not context:
        raise ValueError(
            "No indexed documents found for this topic. Upload and index a PDF first."
        )
    prompt = VIVA_EXAMINER_PROMPT(
        context,
        session.topic,
        session.difficulty,
        _prior_qa(turns),
        len(answered),
        session.num_questions,
    )
    data = _model_json(
        prompt,
        f"Generate question {len(answered) + 1} for the viva on '{session.topic}'.",
        "examiner",
    )
    question = str(data.get("question") or "").strip()
    if not question:
        raise ValueError("Examiner returned an empty question")
    return question, str(data.get("page") or "")


def _finish(db, session, answered_turns) -> dict:
    scores = []
    for turn in answered_turns:
        try:
            evaluation = json.loads(turn.evaluation or "{}")
        except (json.JSONDecodeError, TypeError):
            evaluation = {}
        score = evaluation.get("score")
        if isinstance(score, (int, float)) and not isinstance(score, bool):
            scores.append(float(score))
    computed = round((sum(scores) / len(scores)) * 10, 1) if scores else 0.0

    prompt = VIVA_REPORTER_PROMPT(session.topic, _transcript(answered_turns), computed)
    data = _model_json(
        prompt, f"Write the improvement report for the viva on '{session.topic}'.", "reporter"
    )
    report = {
        "overall_score": computed,
        "strengths": [str(s) for s in (data.get("strengths") or [])],
        "weaknesses": [str(s) for s in (data.get("weaknesses") or [])],
        "recommended_revisions": [str(s) for s in (data.get("recommended_revisions") or [])],
        "summary": str(data.get("summary") or ""),
    }

    session.report = json.dumps(report)
    session.score = computed
    session.status = "completed"
    session.completed_at = _utcnow()
    db.commit()
    return report


# --------------------------------------------------------------------------- #
# Public API used by server.py
# --------------------------------------------------------------------------- #
def start_viva(
    user_id: str,
    topic: str,
    num_questions: int,
    difficulty: str,
    document_ids: list[str] | None = None,
) -> dict:
    from models import VivaSession as VivaSessionRow
    from models import VivaTurn as VivaTurnRow
    from services.db import SessionLocal

    db = SessionLocal()
    try:
        context = _context_str(
            topic, user_id, document_ids, settings.VIVA_K_CONTEXT
        )
        if not context:
            raise ValueError(
                "No indexed documents found for this topic. Upload and index a PDF first."
            )

        session = VivaSessionRow(
            user_id=user_id,
            topic=topic,
            num_questions=num_questions,
            difficulty=difficulty,
            selected_docs=json.dumps(document_ids or []),
            status="active",
        )
        db.add(session)
        db.commit()
        db.refresh(session)

        question, page = _next_question(db, session)
        turn = VivaTurnRow(session_id=session.id, question=question, page=page or "")
        db.add(turn)
        db.commit()

        return {
            "session_id": session.id,
            "question": _question_payload(turn, 1, num_questions),
        }
    finally:
        db.close()


def run_turn(user_id: str, session_id: str, audio_bytes: bytes, mime: str) -> dict:
    from models import VivaSession as VivaSessionRow
    from models import VivaTurn as VivaTurnRow
    from services.db import SessionLocal

    db = SessionLocal()
    try:
        session = (
            db.query(VivaSessionRow).filter(VivaSessionRow.id == session_id).first()
        )
        if session is None or session.user_id != user_id:
            raise ValueError("Viva session not found")
        if session.status != "active":
            raise ValueError("This viva has already finished")

        transcript = transcribe_audio(audio_bytes, mime)

        turns = _turns(db, session.id)
        current = next((t for t in turns if not t.answer_text), None)
        if current is None:
            current = VivaTurnRow(session_id=session.id, question="[acknowledged]", page="")
            db.add(current)
            db.commit()

        context = _context_str(current.question, user_id, _document_ids(session), k=4)
        if not transcript:
            evaluation = {
                "score": 0,
                "missed_points": ["The answer was not heard."],
                "feedback": "I did not hear an answer. Take a moment and try the next question.",
            }
        else:
            eval_prompt = VIVA_EVALUATOR_PROMPT(
                current.question, transcript, context, session.topic
            )
            evaluation = _model_json(
                eval_prompt, "Evaluate this viva answer.", "evaluator"
            )

        current.answer_text = transcript
        current.evaluation = json.dumps(evaluation)
        db.commit()

        answered = [t for t in _turns(db, session.id) if t.answer_text]
        feedback = evaluation.get("feedback") or ""

        if len(answered) >= session.num_questions:
            report = _finish(db, session, answered)
            return {
                "done": True,
                "transcript": transcript,
                "feedback": feedback,
                "report": report,
            }

        question, page = _next_question(db, session)
        turn = VivaTurnRow(session_id=session.id, question=question, page=page or "")
        db.add(turn)
        db.commit()

        return {
            "done": False,
            "transcript": transcript,
            "feedback": feedback,
            "question": _question_payload(turn, len(answered) + 1, session.num_questions),
        }
    finally:
        db.close()