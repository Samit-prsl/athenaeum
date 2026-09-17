# vivaAgent — Voice Viva Feature

## Overview

New **Viva** (voice oral exam) feature. The student picks a topic + documents,
and **Athena speaks questions out loud (TTS)**, the student records spoken
answers in the browser, **Whisper STT transcribes** them, a multi-agent
pipeline scores each turn as it happens, and once the last question is
answered a **report is generated** (overall score, strengths, weaknesses, and
a concrete revision plan). Every viva is saved so past reports can be reopened.

Everything reuses the existing **Groq** API key already configured in the
backend (chat, STT, and TTS all go through `BASE_URL_GROQ`). No new providers,
no new heavy dependencies.

## Multi-agent architecture

Three role-specialized agents share one in-process orchestrator
(`backend/services/viva.py`) — no external agent framework:

| Agent | Role | Where |
|-------|------|-------|
| **Examiner** | Generates each question, grounded in the user's indexed docs (Qdrant context), never repeats a prior question, adapts to difficulty | `services/viva.py:_next_question()` |
| **Evaluator** | Scores each spoken answer 0–10 against the ground-truth context; records missed points + constructive feedback on the turn | `services/viva.py:run_turn()` |
| **Reporter** | At session end, writes the improvement report from the full transcript (strengths, weaknesses, revision plan, summary) | `services/viva.py:_finish()` |

Prompts live in `backend/system_prompt.py` (`VIVA_EXAMINER_PROMPT`,
`VIVA_EVALUATOR_PROMPT`, `VIVA_REPORTER_PROMPT`). All three use Groq JSON-mode
with the same regex-fallback used by the quiz generator, so malformed model
output is handled.

The orchestrator exposes exactly two operations:

- `start_viva(user_id, topic, num_questions, difficulty, document_ids)` —
  ensures there is indexed context, creates the session row, generates + stores
  the **first** question, and returns it with TTS audio (base64 WAV).
- `run_turn(user_id, session_id, audio_bytes, mime)` — transcribes the answer,
  evaluates the current turn, then either returns the **next question + audio**
  or, once all questions are answered, marks the session `completed` and runs
  the **reporter** to build + persist the report.

## Backend changes

| File | Change |
|------|--------|
| `config.py` | Added `GROQ_STT_MODEL` (`whisper-large-v3-turbo`), `GROQ_TTS_MODEL` (`canopylabs/orpheus-v1-english`), `GROQ_TTS_VOICE` (`tara`), `VIVA_K_CONTEXT` (retrieval depth) |
| `models.py` | New tables `viva_sessions` + `viva_turns` (new tables only — safe with `create_all`, no columns added to existing tables so no migration needed). `User.viva_sessions` relationship added |
| `schemas.py` | `VivaStartRequest/Out`, `VivaQuestionOut`, `VivaEvaluation`, `VivaReportOut`, `VivaTurnResult`, `VivaSessionOut`, `VivaTurnOut`, `VivaSessionDetailOut` |
| `services/voice.py` | **New** — Groq STT (`/audio/transcriptions`, Whisper) + TTS (`/audio/speech`, Orpheus) wrappers over the existing OpenAI-compatible client |
| `system_prompt.py` | Added the three viva agent prompt builders |
| `services/viva.py` | **New** — the multi-agent orchestrator + state machine described above |
| `server.py` | 5 new routes (below); all guarded by `get_current_user` with ownership checks |

### New endpoints

- `POST /viva/start` — body `{topic, num_questions, difficulty, document_ids?}` → `{session_id, question:{question, question_audio, turn_index, total_questions, page}}`
- `POST /viva/turn` — multipart `session_id` + `audio` file → either `{done:false, transcript, feedback, question}` or `{done:true, transcript, feedback, report}`
- `GET /viva/sessions` — history list (topic, score, status, date)
- `GET /viva/sessions/{id}` — full report + Q&A transcript (ownership checked)
- `DELETE /viva/sessions/{id}` — remove a session (cascade deletes turns)

### Data model

- `viva_sessions`: id, user_id, topic, num_questions, difficulty, selected_docs (JSON), status (`active`/`completed`), score (float), report (JSON), created_at, completed_at.
- `viva_turns`: id, session_id, question, page, answer_text, evaluation (JSON: score/missed_points/feedback), created_at.

## Frontend changes

| File | Change |
|------|--------|
| `lib/types.ts` | `VivaQuestion`, `VivaStart`, `VivaEvaluation`, `VivaReport`, `VivaTurnResult`, `VivaSession`, `VivaTurn`, `VivaSessionDetail` |
| `lib/api.ts` | `startViva`, `submitVivaAnswer`, `listVivaSessions`, `getVivaSession`, `deleteVivaSession` |
| `components/viva-view.tsx` | **New** — full Viva UI: setup form, live recording session, history list, report review |
| `app/page.tsx` | Added `Viva` nav item (`Mic` icon) + view render |

The live session uses the browser `MediaRecorder` API to capture spoken
answers (WebM/Opus, which Groq's Whisper endpoint accepts directly — no
ffmpeg dependency) and plays the returned base64 WAV via a blob URL. The mic
stream is torn down on stop/unmount. Turn-by-turn feedback is shown so the
student sees how they did before the next question plays.

## Guardrails

- **Empty-index guard**: `/viva/start` returns `400 "No indexed documents
  found for this topic..."` when Qdrant has no matching context (mirrors the
  existing chat/quiz/summary behaviour).
- **No-answer guard**: an empty/in-audible transcription is scored 0 with
  encouraging feedback instead of crashing the pipeline.
- **Ownership**: every session access is scoped to `user_id`; cross-user access
  is rejected (verified in the smoke test).
- **JSON robustness**: regex fallback parses model JSON even when json-mode is
  ignored.

## Verification performed

1. `backend/scripts/viva_smoke.py` — full state machine test with LLM/voice/
   Qdrant seams stubbed: start → 3 evaluated turns → report + completion,
   persistence, cross-user access blocked. **Passed.**
   Run it with: `cd backend && ./venv/bin/python scripts/viva_smoke.py`
2. Backend imports cleanly; `init_db()` creates the new tables on the
   configured Postgres DB (verified via SQLAlchemy inspect).
3. HTTP layer via FastAPI `TestClient`: register/auth → `GET /viva/sessions`
   (200 `[]`) → `POST /viva/start` empty-index guard (400), input validation
   (422), unauthenticated (401). **All passed.**
4. Frontend: `tsc --noEmit` clean, `pnpm build` (Next.js 16, Turbopack)
   compiles successfully.

## How to try it

1. Start the backend: `cd backend && ./venv/bin/python main.py` (port from
   `.env`).
2. Start the frontend: `cd frontend && pnpm dev`.
3. Log in, upload + index at least one PDF (`status` → `ready`).
4. Open **Viva**, enter a topic, pick questions/difficulty/docs, hit **Start
   the viva**, allow microphone access, answer each spoken question, then read
   the generated report under **Past vivas**.

## Config (all optional, sensible defaults)

| Env var | Default |
|---------|---------|
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` |
| `GROQ_TTS_MODEL` | `canopylabs/orpheus-v1-english` |
| `GROQ_TTS_VOICE` | `tara` |
| `VIVA_K_CONTEXT` | `6` (chunks retrieved per question) |

## Known limitations / next steps

- TTS voice is fixed via env; swapping voices is a one-line config change.
- Viva sessions are synchronous per turn (no WebSocket streaming); latency is
  dominated by STT/TTS/LLM round-trips, in line with the existing chat/quiz/
  summary behaviour.
- Sessions are keyed to the in-memory `active` state only on the server side;
  abandoning mid-viva leaves an `active` row. A small cleanup endpoint or a
  "resume/abandon" action for `active` sessions would be a natural follow-up.
- Report currently focuses on **overall score + strengths/weaknesses +
  revision plan**; per-question scores are already persisted on turns, so a
  richer per-question breakdown can be added to the UI without backend changes.