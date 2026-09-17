"""Self-contained smoke test for the viva state machine.

Runs start_viva -> run_turn (x3) against an in-memory SQLite database with
the LLM, voice, and Qdrant retrieval seams stubbed out, so it needs no keys,
no Qdrant, and no network.

Run:  ./venv/bin/python scripts/viva_smoke.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import services.db
from services import viva


# --------------------------------------------------------------------------- #
# Stubs
# --------------------------------------------------------------------------- #
def _stub_context(query, user_id, document_ids, k):
    return (
        "Page Content : Photosynthesis happens in the chloroplast. "
        "Page Number : 3, File location : bio.pdf"
    )


def _stub_model(prompt, message):
    if "examiner agent" in prompt:
        return json.dumps(
            {
                "question": "Which organelle performs photosynthesis?",
                "page": "3",
            }
        )
    if "evaluation agent" in prompt:
        return json.dumps(
            {
                "score": 8,
                "missed_points": ["The role of chlorophyll"],
                "feedback": "Solid answer, elaborate on chlorophyll next time.",
            }
        )
    if "reporting agent" in prompt:
        return json.dumps(
            {
                "strengths": ["Recalls the site of photosynthesis confidently."],
                "weaknesses": ["Gaps around the light vs dark reactions."],
                "recommended_revisions": ["Revise photosynthesis page 4-6 in 'bio.pdf'."],
                "summary": "Good grasp of the basics with room to deepen detail.",
            }
        )
    raise AssertionError(f"Unexpected prompt: {prompt[:80]}")


def _stub_tts(text):
    return bytes(range(128)) * 4  # pretend WAV bytes


def _stub_stt(audio_bytes, mime):
    return "Photosynthesis happens in the chloroplast."


def main() -> None:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    import models  # noqa: F401  (register tables)

    models.Base.metadata.create_all(bind=engine)
    services.db.SessionLocal = sessionmaker(
        bind=engine, autoflush=False, autocommit=False
    )

    viva._context_str = _stub_context
    viva._agent_complete = _stub_model
    viva.synthesize_speech = _stub_tts  # type: ignore[assignment]
    viva.transcribe_audio = _stub_stt  # type: ignore[assignment]

    started = viva.start_viva(
        user_id="u-smoke",
        topic="photosynthesis",
        num_questions=3,
        difficulty="medium",
        document_ids=["doc-1"],
    )
    assert "session_id" in started, started
    assert started["question"]["question"].strip(), "first question must not be empty"
    assert started["question"]["question_audio"], "TTS audio should be generated"
    assert started["question"]["turn_index"] == 1, "starts at question 1"
    session_id = started["session_id"]
    print(f"[1/4] started session {session_id} Q{started['question']['turn_index']}/{started['question']['total_questions']}")

    audio = b"\x00" * 1024
    done = False
    turns = 0
    while not done:
        turns += 1
        result = viva.run_turn("u-smoke", session_id, audio, "audio/webm")
        assert result["transcript"], "transcript should be returned"
        assert result["feedback"], "evaluator feedback should be returned"
        if result["done"]:
            done = True
            report = result["report"]
            assert report["overall_score"] == 80.0, report
            assert report["strengths"] and report["weaknesses"], report
            print(f"[2/4] completed after {turns} turns, score={report['overall_score']}")
        else:
            assert result["question"], "next question expected"
            print(f"      answered Q{turns}: next is Q{result['question']['turn_index']}/{result['question']['total_questions']}")

    # Verify persistence via ORM.
    db = services.db.SessionLocal()
    try:
        from models import VivaSession as VivaSessionRow
        from models import VivaTurn as VivaTurnRow

        session = db.query(VivaSessionRow).filter_by(id=session_id).one()
        assert session.status == "completed", session.status
        assert session.score == 80.0
        assert session.completed_at is not None
        assert session.report is not None
        turns_in_db = (
            db.query(VivaTurnRow)
            .filter(VivaTurnRow.session_id == session_id)
            .order_by(VivaTurnRow.created_at.asc())
            .all()
        )
        assert len(turns_in_db) == 3, len(turns_in_db)
        assert all(t.answer_text for t in turns_in_db), "all turns should be answered"
        assert all(t.evaluation for t in turns_in_db), "all turns should be evaluated"
        print(f"[3/4] persisted 3 turns + report; status={session.status} score={session.score}")
    finally:
        db.close()

    # Ownership guard: a different user must be rejected.
    try:
        viva.run_turn("u-other", session_id, audio, "audio/webm")
        raise AssertionError("other user should not access this session")
    except ValueError:
        print("[4/4] cross-user access blocked")

    print("\nVIVA SMOKE OK")


if __name__ == "__main__":
    main()