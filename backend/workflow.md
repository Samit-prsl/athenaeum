# Athenaeum — Codebase Workflow & Guide

---

## Table of contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data model](#3-data-model)
4. [Request-lifecycle walkthroughs](#4-request-lifecycle-walkthroughs)
5. [How to run](#5-how-to-run)
6. [Gotchas discovered during development](#6-gotchas-discovered-during-development)
7. [hot points](#7-hot-points)
8. [Troubleshooting cheat sheet](#8-troubleshooting-cheat-sheet)

---

## 1. Overview

Athenaeum is a full-stack RAG (Retrieval-Augmented Generation) backend for a
student study agent. Users upload multiple PDFs, and the system answers
questions, generates quizzes, and creates summaries grounded entirely in the
uploaded content with page-level citations.

| Component | Technology | Role |
|-----------|-----------|------|
| API | FastAPI | REST endpoints, auth, request validation |
| Task queue | RQ + Redis | Async job processing (ingestion + LLM calls) |
| Vector store | Qdrant | Per-user collections, similarity search |
| Relational DB | SQLite + SQLAlchemy | Users + document metadata |
| Embeddings | `all-MiniLM-L6-v2` (384-dim) | Sentence-level dense vectors |
| LLM | Gemini 3.6 Flash (OpenAI-compatible) | Grounded generation |
| PDF parser | pypdf | Page-level text extraction |

Key design decision: **every user gets their own Qdrant collection**
(`rag_{user_id}`), so document isolation requires zero runtime filtering at
the user boundary.

---

## 2. Architecture

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                      FastAPI (port 8000)                │
                  │  server.py — routes, auth guard, request validation    │
                  └───────────────┬───────────────────────┬───────────────┘
                                  │                       │
           enqueue_job()          │  register/login/docs   │  enqueue_job()
         ┌────────────────────────▼──────────┐   ┌───────▼──────────────┐
         │         Redis (RQ queue)           │   │   SQLite (users,    │
         │  server.py → queues/rag_jobs.py    │   │   documents)        │
         └───────────────────────┬────────────┘   └─────────────────────┘
                                 │
                         SimpleWorker (in-process, model preloaded)
                     ┌───────────▼──────────────────────────────────────┐
                     │ worker.py → queues/rag_jobs.py                  │
                     │                                                │
                     │  ingest_document:                               │
                     │    pypdf → LangChain Document → Qdrant upsert   │
                     │                                                │
                     │  answer / quiz / summary:                       │
                     │    Qdrant similarity_search (top-k)             │
                     │    → system prompt → Gemini → plain text / JSON  │
                     └─────────────────────────────────────────────────┘
```

### File responsibilities

```
main.py                       uvicorn entrypoint
server.py                     FastAPI app, all route handlers, auth guard
config.py                     env-driven settings singleton
models.py                     SQLAlchemy User, Document
schemas.py                    Pydantic request/response contracts
system_prompt.py              ANSWER / QUIZ / SUMMARY prompt builders
worker.py                     RQ worker entrypoint (simple / spawn / fork)
client/rq_client.py           enqueue_job(), fetch_job()
queues/rag_jobs.py            ingest_document, answer_question, generate_quiz, generate_summary
services/db.py                SQLAlchemy engine, session, init_db
services/security.py          bcrypt hash/verify, JWT sign/decode
services/pdf.py               pypdf page-level parser
services/vectorstore.py       Qdrant collection CRUD, search, delete
```

---

## 3. Data model

### SQLite — `users` table

| Column | Type | Notes |
|--------|------|-------|
| id | UUID (36-char string) | PK, generated on create |
| email | VARCHAR(320) | unique, indexed |
| password_hash | VARCHAR(255) | bcrypt hash |
| name | VARCHAR(255) | display name |
| created_at | DATETIME | UTC, on create |

*File: `models.py:18-29`*

### SQLite — `documents` table

| Column | Type | Notes |
|--------|------|-------|
| id | UUID (36-char string) | PK, used as Qdrant `doc_id` |
| user_id | UUID (FK → users.id) | indexed |
| filename | VARCHAR(512) | original upload name |
| storage_path | VARCHAR(1024) | `uploads/{user_id}/{doc_id}.pdf` |
| total_pages | INT | populated after ingest |
| status | VARCHAR(32) | `processing` → `ready` or `failed` |
| error | VARCHAR(1024) | nullable, error message on failure |
| created_at | DATETIME | UTC, on create |

*File: `models.py:32-46`*

### Document status state machine

```
  ┌────────────┐   ingest succeeds   ┌────────┐
  │ processing │ ────────────────────→│ ready  │
  └────────────┘                     └────────┘
        │
        │  ingest fails (exception)
        ▼
  ┌────────┐
  │ failed │  (error column populated)
  └────────┘
```

Status is set by `ingest_document` in `queues/rag_jobs.py:69-93`. On
re-upload of the same doc, old points are deleted first (idempotent),
then new points are added — so the status always resolves to `ready` if
parsing succeeds.

### Qdrant payload schema (per point)

Every vector stored in Qdrant has this payload structure (produced by
`QdrantVectorStore.add_documents()`):

```
{
  "page_content": "<full page text>",
  "metadata": {
    "user_id":    "<owner UUID>",
    "doc_id":     "<document row UUID>",
    "source":     "<original filename, e.g. photosynthesis.pdf>",
    "page":       <1-based int>,
    "page_label": "<string page label from PDF>",
    "total_pages": <int>
  }
}
```

The `metadata` nesting is a `langchain-qdrant` convention — the
`content_payload_key` defaults to `page_content` and
`metadata_payload_key` to `metadata`. This is critical for Qdrant
filtering: field paths use dotted notation (`metadata.doc_id`) not
top-level `doc_id`.

*File: `services/vectorstore.py:50-59` (add), `:81-119` (search), `:62-78`
(delete)*

---

## 4. Request-lifecycle walkthroughs

### 4.1 Register + login (JWT lifecycle)

```
Client                          FastAPI                    SQLite
  │                               │                          │
  │  POST /auth/register          │                          │
  │  {email, password, name}      │                          │
  │ ─────────────────────────────→│                          │
  │                               │  SELECT (email check)    │
  │                               │─────────────────────────→│
  │                               │  409 if exists            │
  │                               │                          │
  │                               │  bcrypt.hashpw(password) │
  │                               │  INSERT user             │
  │                               │─────────────────────────→│
  │                               │                          │
  │                               │  _create_token(user_id,  │
  │                               │    "access",  30min)     │
  │                               │  _create_token(user_id,  │
  │                               │    "refresh", 7 days)    │
  │  201 {access_token, ...}      │                          │
  │←──────────────────────────────│                          │
```

**Auth guard** (`server.py:71-91`): every protected route declares
`current_user: User = Depends(get_current_user)`. That dependency reads
the `Authorization: Bearer <token>` header via
`OAuth2PasswordBearer(tokenUrl="auth/login")`, decodes the JWT, validates
type is `"access"`, and loads the user from SQLite. If anything fails, it
raises a 401 with `WWW-Authenticate: Bearer` — and Swagger's "Authorize"
button works automatically because of the `tokenUrl` parameter.

**Refresh** (`POST /auth/refresh`): accepts `{refresh_token}` body, decodes
the `refresh`-typed token, issues a new access token. No rotation —
stateless and simple.

*Files: `services/security.py:22-48`, `server.py:112-158`*

### 4.2 PDF upload → ingestion pipeline

```
Client                          FastAPI                    Redis/RQ        Worker           Qdrant
  │                               │                         │               │                  │
  │  POST /documents              │                         │               │                  │
  │  files[]                      │                         │               │                  │
  │ ─────────────────────────────→│                         │               │                  │
  │                               │ validate: .pdf only,    │               │                  │
  │                               │ size ≤ 50MB             │               │                  │
  │                               │                         │               │                  │
  │                               │ save to uploads/        │               │                  │
  │                               │   {user_id}/{doc_id}.pdf│               │                  │
  │                               │                         │               │                  │
  │                               │ INSERT document         │               │                  │
  │                               │   status="processing"   │               │                  │
  │                               │                         │               │                  │
  │                               │ enqueue_job(             │               │                  │
  │                               │   ingest_document,      │               │                  │
  │                               │   user_id, doc_id)      │               │                  │
  │                               │────────────────────────→│               │                  │
  │  202 {uploads: [{job_id}]}    │                         │               │                  │
  │←──────────────────────────────│                         │               │                  │
  │                               │                         │  (in-process) │                  │
  │                               │                         │──────────────→│                  │
  │                               │                         │               │ load_pdf_pages() │
  │                               │                         │               │ pypdf: per-page  │
  │                               │                         │               │   text extraction│
  │                               │                         │               │                  │
  │                               │                         │               │ enrich metadata: │
  │                               │                         │               │  doc_id, source, │
  │                               │                         │               │  page_label      │
  │                               │                         │               │                  │
  │                               │                         │               │ ensure_collection│
  │                               │                         │               │─────────────────→│
  │                               │                         │               │                  │
  │                               │                         │               │ delete old points│
  │                               │                         │               │   (idempotent)   │
  │                               │                         │               │─────────────────→│
  │                               │                         │               │                  │
  │                               │                         │               │ add_documents()  │
  │                               │                         │               │  (embed → upsert)│
  │                               │                         │               │─────────────────→│
  │                               │                         │               │                  │
  │                               │                         │               │ UPDATE document: │
  │                               │                         │               │  status="ready", │
  │                               │                         │               │  total_pages=N   │
```

**Why async?** A 6-page PDF takes ~3s for text extraction and
embedding, plus model load at worker startup (~3s). A 50-page
PDF with heavy embedding could take 15-30s. Returning synchronously
would block the client. The 202 + `job_id` pattern lets the frontend
poll `GET /jobs/{job_id}` at its own pace.

**Page-level chunking** (`services/pdf.py:7-32`): each page becomes one
LangChain `Document`. This is a deliberate choice over sliding-window
chunking — page boundaries provide:
- Natural citation anchors (page numbers)
- Coherent semantic units (each page is a self-contained section)
- No cross-page text splitting artifacts
The tradeoff is that very long pages get less granular retrieval, but
for textbooks this is acceptable.

**Idempotent re-indexing** (`queues/rag_jobs.py:76-77`):
`delete_documents(user_id, doc_id)` removes all points with matching
`metadata.doc_id`, then `add_documents()` inserts fresh vectors. This
means re-uploading the same PDF simply replaces the old index.

### 4.3 Chat / quiz / summary flow

```
Client                          FastAPI                    Redis/RQ        Worker
  │                               │                         │               │
  │  POST /chat                   │                         │               │
  │  {question, document_ids?:[]} │                         │               │
  │ ─────────────────────────────→│                         │               │
  │                               │ get_current_user        │               │
  │                               │ enqueue_job(             │               │
  │                               │   answer_question,      │               │
  │                               │   user_id, question,    │               │
  │                               │   document_ids)         │               │
  │                               │────────────────────────→│               │
  │  202 {job_id}                 │                         │               │
  │←──────────────────────────────│                         │               │
  │                               │                         │  (in-process) │
  │                               │                         │──────────────→│
  │                               │                         │               │
  │                               │                         │  _retrieve_context():
  │                               │                         │    search(user_id, query, k=4,
  │                               │                         │      document_ids)
  │                               │                         │    → Qdrant query_points()
  │                               │                         │      with cosine similarity
  │                               │                         │    → top-k LangChain Documents
  │                               │                         │
  │                               │                         │  build RAG_SYSTEM_PROMPT:
  │                               │                         │    context = "Page Content: ...,
  │                               │                         │    Page Number: ..., File: ..."
  │                               │                         │
  │                               │                         │  _complete(prompt, question):
  │                               │                         │    OpenAI(Gemini).chat.completions
  │                               │                         │    → plain text with citations
  │                               │                         │
  │  GET /jobs/{job_id}           │                         │               │
  │ ─────────────────────────────→│                         │               │
  │  {status:"finished",          │                         │               │
  │   result:"Summary: ..."}      │                         │               │
```

**Quiz** (`queues/rag_jobs.py:106-131`): same flow but `response_format:
json_object` is passed to Gemini. The system prompt demands exact JSON
structure. If the model returns malformed JSON, a regex fallback
(`re.search(r"\{.*\}", content, re.DOTALL)`) extracts the outermost
JSON object for a second parse attempt.

**Summary** (`queues/rag_jobs.py:134-143`): same as chat but with a
different prompt that structures output as `## Summary / ## Key Points /
## Sources` with page citations per bullet.

**k-value tuning**: chat uses `k=4` (concise, fast), quiz uses
`k=max(6, num_questions * 2)` (more context for generation), summary
uses `k=8` (broader coverage).

### 4.4 Deletion flow

```
DELETE /documents/{doc_id}
  │
  ├─ verify ownership (row.user_id == current_user.id)
  ├─ delete_documents(user_id, doc_id)
  │    └─ Qdrant FilterSelector(filter=metadata.doc_id == doc_id)
  │       └─ removes all matching points
  ├─ os.remove(storage_path)
  ├─ db.delete(row) + db.commit()
  └─ 204 No Content
```

The Qdrant filter uses the dotted path `metadata.doc_id` because
`langchain-qdrant` stores metadata under a nested `metadata` key in the
payload. Using bare `doc_id` at the top level would silently match
nothing.

---

## 5. How to run

```bash
cd ~/Desktop/Open\ Source/athenaeum

# Terminal 1 — start the worker
./venv/bin/python worker.py

# Terminal 2 — start the API
./venv/bin/python main.py

# Open http://localhost:8000/docs for Swagger UI
```

### Environment variables (`.env`)

| Variable | Purpose | Default |
|----------|---------|---------|
| `GEMINI_API_KEY` | LLM API key | required |
| `BASE_URL` | Gemini OpenAI-compat endpoint | required |
| `MODEL_NAME` | LLM model identifier | `gemini-3.6-flash` |
| `JWT_SECRET` | HMAC key for JWT signing | required (generate with `secrets.token_urlsafe(64)`) |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Access token TTL | `30` |
| `REFRESH_TOKEN_EXPIRE_DAYS` | Refresh token TTL | `7` |
| `QDRANT_URL` | Qdrant server | `http://localhost:6333` |
| `EMBEDDING_MODEL` | HuggingFace model name | `sentence-transformers/all-MiniLM-L6-v2` |
| `EMBEDDING_DIM` | Vector dimension | `384` |
| `REDIS_HOST` | Redis server | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `UPLOAD_DIR` | PDF file storage | `uploads` |
| `DATABASE_URL` | SQLAlchemy connection string | `sqlite:///./athenaeum.db` |
| `MAX_UPLOAD_MB` | Per-file upload cap | `50` |
| `JOB_TIMEOUT` | RQ job timeout (seconds) | `900` |
| `JOB_RESULT_TTL` | How long results persist (seconds) | `86400` |

---

## 6. Gotchas discovered during development

These are real bugs encountered and fixed during the build — excellent
interview material because they show debugging depth.

### 6.1 rq 2.12 API drift

**Symptom:** `ingest_document() got an unexpected keyword argument 'timeout'`

**Root cause:** RQ 2.12 renamed the job-level timeout parameter from
`timeout` to `job_timeout` in `Queue.enqueue()` (via `parse_args`).
Passing `timeout=900` puts it into `kwargs` instead of being captured as
a job option, so it's forwarded to the function.

**Fix:** `client/rq_client.py` changed `timeout=` → `job_timeout=`.

### 6.2 macOS fork crash with SpawnWorker

**Symptom:** `objc[PID]: +[NSNumber initialize] may have been in progress
in another thread when fork() was called. Crashing instead.`

**Root cause:** RQ's default `Worker` uses `os.fork()` to spawn work-horse
processes. On macOS, Objective-C runtime classes (used by libdispatch,
which Python touches via the `socket`/`io` libraries) require safe
fork semantics. When a Redis pubsub thread holds ObjC state at fork
time, the child crashes with `SIGABRT`.

**Fix:** Switched to `SpawnWorker` (`worker.py:4,17`) which uses
`os.spawnv()` to re-execute a fresh Python process per job. No fork
occurs, so the ObjC state is never copied. The tradeoff is that the
embedding model reloads per job (~2s first call, <1s cached).

> **Superseded by §6.6:** revisited later because re-exec per job meant
> re-loading the embedding model every time (~10s/job with the HF Hub
> network check). The current worker mode is `simple`
> (`rq.SimpleWorker`): jobs run in-process on a preloaded model — safe
> on macOS (no fork) and avoids per-job model load.

### 6.3 langchain-qdrant 1.1.0 constructor change

**Symptom:** `QdrantVectorStore.__init__() got an unexpected keyword argument 'url'`

**Root cause:** `langchain-qdrant` 1.1.0 changed its constructor to accept
a `client: QdrantClient` instance instead of `url=` / `collection_name=`
directly.

**Fix:** `services/vectorstore.py:54-58` now passes
`client=QdrantClient(url=...)` instead of `url=settings.QDRANT_URL`.

### 6.4 qdrant-client 1.19 method renames

**Symptoms:**
- `query_points()` rejected `with_vector=False` as unknown kwarg
- `scroll()` rejected `filter=` as unknown kwarg

**Root cause:** qdrant-client 1.19 changed the parameter names to
`query_filter` and `scroll_filter` respectively, and removed the
`with_vector` keyword from `query_points`.

**Fix:** `services/vectorstore.py:105-111` uses `query_filter=` (no
`with_vector`). Tests updated to use `scroll_filter=`.

> **Note (6.4 follow-up):** qdrant-client ≥1.19 also requires explicit
> **payload indexes** for field filters. `delete()` by `metadata.doc_id`
> without an index raises
> `QdrantException: Index required but not found for metadata.doc_id`.
> `services/vectorstore.py` now creates keyword payload indexes on
> `metadata.doc_id` and `metadata.user_id` via `_ensure_payload_indexes()`
> (called from `ensure_collection()` and `delete_documents()`). Without
> this, the *second* upload of a document (which deletes old points first)
> fails while the first succeeds — see §6.6.

### 6.5 Nested payload filter trap

**Symptom:** `DELETE /documents/{id}` returned 204 but points remained
in Qdrant. Scoped chat still answered from the "deleted" document.

**Root cause:** `langchain-qdrant` stores metadata under a nested
`metadata` key in the payload, so `Filter(key="doc_id", ...)` matches
nothing — the field is actually at `metadata.doc_id`. Search worked
because the worker picks up new code per job (SpawnWorker), but the
API server was still running the old `delete_documents` code (never
restarted after the fix). Direct Qdrant deletion via
`FilterSelector(filter=Filter(key="metadata.doc_id", ...))` works
correctly.

**Lesson:** In RQ + FastAPI setups, restarting only the worker does NOT
refresh imported code in the API process. Both must be restarted when
shared modules change.

### 6.6 Slow document vector embedding (the "it's still slow" saga)

**Symptom:** every PDF ingestion took ~10s+ even for a small 6-page PDF,
dominated by embedding warm-up, not by the actual encoding.
Uploads appeared "stuck" well after the model had already been
used before.

**What we measured (cold path breakdown):**
| Stage | Cost |
|-------|------|
| HF Hub unauthenticated network check (`whoami` / token probe) | ~7s |
| `import torch` + `transformers` + `sentence-transformers` | ~3s |
| Actual `encode()` of a few pages | ~0.1s |

So ~99% of the per-job time was model re-loading; the encode itself was
negligible. Three compounding root causes:

1. **`RQ_WORKER_MODE=spawn`**: `config.py` defaulted to `"spawn"`, so the
   worker re-exec'd a fresh process *per job* — model import, HF cache
   load, and the unauthenticated HF Hub network check ran on **every
   job**, not just the first.
2. **HF Hub offline probe**: even after fixing the worker, the
   unauthenticated HF Hub check fires on import unless explicitly
   disabled.
3. **mismatched infrastructure**: the restarted API was enqueuing to
   cloud Upstash Redis while the long-running worker still listened on
   local Docker Redis (`localhost:6379`) — jobs were "stuck" with zero
   workers actually watching the right queue.

**Fixes applied:**

* `RQ_WORKER_MODE = simple` in `.env`, and `worker.py` now uses
  `rq.SimpleWorker` (in-process, no re-exec) **and pre-loads**
  `get_embeddings()` before `worker.work()`:
  ```python
  if settings.RQ_WORKER_MODE == "simple":
      _preload_embeddings()
      SimpleWorker(queues, connection=rq_conn).work()
  ```
  Result: `Loading weights` appears exactly **once** in the worker log,
  and subsequent jobs reuse the warm model (~0.1s instead of ~10s).
* `HF_HUB_OFFLINE = 1` in `.env` → kills the ~7s network check on import.
* `SSL_CERT_FILE` set to the venv `certifi` CA bundle —
  cloud Upstash Redis (rediss/TLS) requires a real CA chain, otherwise
  the worker can't connect at all.
* Restart **both** API and worker so shared modules pick up the new code.

**Why `SimpleWorker` and not fork?** We tried the obvious fast path
first: keep the default fork-based `Worker` (which shares the preloaded
model via copy-on-write) and preload. On macOS with PyTorch this
**segfaults** (torch + ObjC forking safety — see §6.2, exit status 11),
because torch's threading primitives are not fork-safe. Fork +
preloaded model was fast but crashed; `SpawnWorker` was safe but
re-loaded per job. `SimpleWorker` avoids the fork entirely (jobs run
in-process) and lets a single model instance serve every job.

**Second-order bug it exposed:** re-uploading a PDF (which deletes old
points by `metadata.doc_id` first) hit
`Index required but not found for metadata.doc_id` in `add_documents()`.
Qdrant needs an explicit payload index to filter on a nested field
(§6.4 follow-up); fixed with `_ensure_payload_indexes()` creating
keyword indexes on `metadata.doc_id` / `metadata.user_id` at collection
creation **and** before every delete.

**Result after the fixes:** cold worker start still pays the ~3s
import, but every subsequent ingestion job runs embedding at ~0.1s.
End-to-end smoke test (upload → poll → searchable): first upload
~4.5s, second upload ~6s incl. queue/poll overhead, jobs finish in
~3s. Verification: `pgrep` the worker PID, grep the worker log for a
single `Loading weights`, and query Qdrant for both docs by new+old
`doc_id`.

**Lesson:** profile the cold path once (per-job model load vs encode
time), then verify the running processes match the config you think is
deployed — a stale worker on the wrong Redis is the classic "fix didn't
work" report.

### 6.7 Postgres (Neon) drops the pooled connection — "processing is slow again"

**Symptom:** after switching `DATABASE_URL` from local SQLite to a cloud
Neon Postgres instance, an ingestion job failed immediately at the
document lookup and every re-upload looked "slow again":

```
sqlalchemy.exc.OperationalError: (psycopg2.OperationalError)
SSL connection has been closed unexpectedly
[SQL: SELECT documents.id, ... FROM documents WHERE documents.id = %(pk_1)s]
```

**Root cause:** the worker runs long-lived in-process
(`RQ_WORKER_MODE=simple`, §6.6), so the SQLAlchemy engine pool holds
connections open for hours. Neon terminates idle SSL connections, and
the pool hands out the now-dead connection on the next job because no
liveness check was enabled (`pool_pre_ping` defaults to `False`).
SQLite never exposed this (local file, no server-side idle kill — but
it *did* hit its own `database is locked` variant, §6 / troubleshooting).

Two compounding bugs made the impact worse:

1. **`db.get()` ran outside the `try/finally`** in `ingest_document`
   (`queues/rag_jobs.py`). When the dead connection raised, the
   exception propagated uncaught: the `Session` leaked, the document
   was never marked `failed`, and it stayed stuck at `processing`
   forever.
2. **No retry.** The only remedy was re-uploading the same PDF, which
   re-ran the full parse → embed → Qdrant pipeline — i.e. "document
   processing is taking time again".

**Fixes applied:**

* `services/db.py` now enables `pool_pre_ping=True` on the engine, so
  every pooled connection gets a cheap `SELECT 1` health check before
  use; stale connections are discarded and transparently replaced. For
  Postgres URLs it also sets `pool_recycle=300` (proactively drop
  connections older than Neon's idle cutoff) and
  `connect_args={"connect_timeout": 15}` so a hung socket fails fast
  instead of blocking a job for up to `JOB_TIMEOUT` (900s). SQLite keeps
  its `timeout=30` / `check_same_thread` connect args.
* New util `services/retry.py`: `retry_on_errors()` decorator (defaults:
  3 attempts, 1s initial delay, ×2 backoff) that catches
  `sqlalchemy.exc.DBAPIError` (wraps driver failures like the psycopg2
  `OperationalError`) and retries with a logged warning. Applied via
  `@retry_on_errors()` to `ingest_document`; since each attempt creates a
  fresh `Session`, a transient DB drop self-heals.
* `ingest_document` (`queues/rag_jobs.py`) moved `SessionLocal()` /
  `db.get()` **inside** `try/finally` so the session is always closed;
  `row` is initialised to `None` before the block and the failure branch
  only marks the document `failed` when a row was actually fetched. The
  "mark failed" commit is guarded in its own `try/except` so a fully
  down DB logs the warning instead of masking the original exception
  (and the original error is still re-raised for RQ).

**Result:** a job that hits a dropped connection now reconnects
transparently (pre-ping) and, if it still trips, retries from a fresh
session up to 3 times instead of failing. Documents no longer get stuck
at `processing`, so re-uploading a PDF to "fix" it is no longer
necessary — the underlying slowness that re-upload exposed is gone.

**Remaining alternatives:** for a fully stateless/dep-free path you could
also dedupe uploads by content hash (skip parse + embed when an identical
file is already indexed) — intentionally not implemented here, this fix is
scoped to DB resilience only.

**Verify:** restart **both** API and worker (shared module changes);
upload a PDF and poll `GET /documents` — expect `ready` on the first
pass. To reproduce the failure mode, let the worker idle past Neon's
idle-connection cutoff, then enqueue a job; the worker log should show
the pre-ping reconnect (no `SSL connection has been closed` error in the
failure path).

---

## 7. hot points

Each section: **what the concept is** → **how this codebase implements
it** → **why this choice** → **tradeoffs / what you'd improve**.

### 7.1 RAG fundamentals

**What:** Retrieval-Augmented Generation grounds LLM responses in
retrieved documents instead of relying on training data. The pipeline
is: embed query → retrieve top-k similar chunks → inject them into a
system prompt → LLM generates a grounded response.

**Implementation:** `services/vectorstore.py:81-119` performs cosine
similarity search via `QdrantClient.query_points()` using
`all-MiniLM-L6-v2` embeddings (384-dim). Retrieved documents are joined
into a context string (`queues/rag_jobs.py:27-39`) with explicit page
number and source file labels. The system prompt
(`system_prompt.py:1-37`) constrains the LLM to only use this context.

**Why:** For a student study tool, grounding in uploaded PDFs prevents
hallucination. Page-level citations (enforced by prompt rules) let
students verify answers in the source material.

**Tradeoffs:**
- *Page-level chunks* are coarser than 256-token overlapping chunks.
  For textbooks, this is usually better (each page is a coherent
  section), but very long pages degrade precision.
- *Dense-only search* (no BM25/sparse) means exact keyword matches
  (e.g., "NADP+") could be missed if the embedding doesn't capture
  them. A hybrid search approach would fix this.
- *Top-k=4 for chat* is conservative; increasing to 6-8 improves
  recall but adds prompt tokens and cost.

**Improvement ideas:** hybrid search (BM25 + dense), RAGAS evaluation
framework, chunk overlap for long pages, query rewriting.

### 7.2 Async job queue design

**What:** Long-running operations (PDF ingestion, LLM calls) are
offloaded to background workers via a message queue, keeping the API
responsive.

**Implementation:** RQ (Redis Queue) handles job dispatch.
`client/rq_client.py:11-18` enqueues functions with args serialized to
Redis. `worker.py` runs a `SimpleWorker` that dequeues jobs and executes
them in fresh processes. Results are stored in Redis with configurable
TTL (`JOB_RESULT_TTL = 86400` = 1 day). Clients poll via
`GET /jobs/{job_id}` (`server.py:313-324`).

**Why RQ over Celery:** RQ is simpler (no broker configuration,
no separate `celeryconfig.py`, no concept of exchanges/routing keys).
For a project of this size, RQ provides everything needed with less
complexity. Celery is better for: multiple queue priorities, rate
limiting, periodic tasks (beat), retry policies, and teams already
familiar with its ecosystem.

**Tradeoffs:**
- *Polling* (client hits `/jobs/{id}` every 3s) wastes bandwidth
  compared to WebSockets or SSE (Server-Sent Events) which would push
  results. For a student app this is acceptable.
- *No retry policy*: failed jobs don't automatically retry. A
  configurable retry count (RQ supports `Retry(max=3)`) would help with
  transient LLM API failures.
- *No job ownership check*: any authenticated user can poll any
  `job_id`. In production, jobs should be tied to users via Redis keys.

**Improvement ideas:** SSE for live result streaming, RQ `Retry()`
for LLM failures, job-user association, dead letter queue for
permanent failures.

### 7.3 JWT authentication design

**What:** Stateless token-based auth using JSON Web Tokens. The server
issues signed tokens at login; clients include them in the
`Authorization` header for subsequent requests.

**Implementation:**
- `services/security.py:9-10`: `bcrypt.hashpw()` with automatic salt
  for password storage
- `services/security.py:22-30`: JWT creation with payload
  `{sub: user_id, type: "access"|"refresh", iat, exp}`
- `services/security.py:33-38`: access = 30min, refresh = 7 days
- `server.py:65,71-91`: `OAuth2PasswordBearer(tokenUrl="auth/login")`
  extracts the Bearer token; `get_current_user` dependency decodes it
  and loads the user
- `server.py:131-140`: login uses `OAuth2PasswordRequestForm` (username
  field = email) so Swagger's "Authorize" button works out of the box

**Why this design:**
- *Access + refresh split*: short-lived access tokens limit exposure
  window; long-lived refresh tokens let users stay logged in without
  re-entering credentials
- *`type` claim in payload*: prevents refresh tokens from being used
  as access tokens (checked in `security.py:46-47`)
- *HS256 algorithm*: symmetric signing is sufficient when the API is
  the sole issuer (no need for asymmetric RS256)

**Tradeoffs / what's missing:**
- *No refresh token rotation*: a stolen refresh token stays valid for
  7 days. Rotation (each use issues a new refresh and invalidates the
  old one) requires a DB table to track valid refresh tokens.
- *No token revocation/blacklisting*: if a user changes their
  password, old access tokens remain valid until expiry. A Redis
  blacklist with TTL matching the token expiry fixes this.
- *Stateless refresh*: convenient but cannot revoke. For production,
  store refresh tokens in DB and delete on logout/password change.
- *No rate limiting on auth endpoints*: brute-force protection
  (e.g., slowapi) should be added.

### 7.4 Multi-tenancy and data isolation

**What:** Each user's data must be fully isolated — user A cannot
query or see user B's documents.

**Implementation:** Every user gets their own Qdrant collection named
`rag_{user_id}` (`services/vectorstore.py:28-29`). Collection creation
is lazy — created on first upload (`ensure_collection()`,
`:36-47`). All search, add, and delete operations are scoped to the
user's collection by construction. No user-ID filter is needed in
Qdrant queries (though `metadata.user_id` is stored for future needs).

**Why per-user collections over single-collection-with-filter:**
- *Zero filter overhead at query time*: search hits only the user's
  data, no skipped points
- *Complete isolation*: even a bug in filter logic can't leak data
  across users (collection boundary is the isolation mechanism)
- *Independent scaling*: collections can be moved, backed up, or
  deleted independently

**Tradeoffs:**
- *Collection sprawl*: 10,000 users = 10,000 Qdrant collections.
  Qdrant handles this well (collections are lightweight), but monitoring
  and backup become per-user concerns.
- *Alternative — single collection + user_id filter*: simpler
  infrastructure but adds per-query filter cost and relies entirely on
  filter correctness for security.

**Improvement ideas:** collection archival for inactive users,
soft-delete with TTL, per-user rate limits on Qdrant operations.

### 7.5 Embeddings and vector operations

**What:** Converting text to dense numerical vectors for similarity
search. "all-MiniLM-L6-v2" produces 384-dimensional vectors from
sentences, optimized for semantic similarity.

**Implementation:**
- `services/vectorstore.py:21-25`: `HuggingFaceEmbeddings` is lazily
  initialized once per process (singleton pattern)
- `services/vectorstore.py:92`: `embed_query()` converts the user's
  question to a 384-dim vector
- `services/vectorstore.py:105-111`: `QdrantClient.query_points()`
  performs approximate nearest neighbor (ANN) search with cosine
  distance
- `services/vectorstore.py:36-47`: collection created with
  `VectorParams(size=384, distance=Distance.COSINE)`

**Why MiniLM-L6-v2:**
- Small (80MB) and fast (~50ms per embedding on CPU)
- Good balance of quality/speed for student content
- 384 dimensions keeps storage and search efficient

**Model load lifecycle under SimpleWorker:**
The worker loads the embedding model **once** at startup
(`_preload_embeddings()` in `worker.py`) and serves every job
in-process via `rq.SimpleWorker`. First call pays the model import +
cache load (~3s with `HF_HUB_OFFLINE=1`); every subsequent embedding is
<100ms. See §6.6 for why fork (fast, but segfaults with PyTorch on
macOS) and SpawnWorker (safe, but reloads per job) were rejected.

**Improvement ideas:**
- Switch to `Worker` (fork) on Linux with `OBJC_DISABLE_INITIALIZE_FORK_SAFETY`-style
  workarounds to avoid the in-process model (SimpleWorker serializes
  jobs; concurrent processing needs multiple worker processes)
- Use ONNX-optimized embeddings for faster CPU inference
- Cache the embedding model in shared memory for multi-worker setups
- Use Qdrant's built-in payload indexes on `metadata.doc_id` for
  faster filtered search

### 7.6 Prompt engineering for grounded generation

**What:** Structuring the LLM prompt to maximize factual accuracy and
enforce output format constraints.

**Implementation (`system_prompt.py`):**

Three prompt builders share a common pattern:

1. **Hard grounding rules** (lines 9-11 in ANSWER prompt):
   "Use only the retrieved context. Do not use outside knowledge. Do
   not hallucinate."
2. **Citation enforcement** (lines 14-16): "Always provide the relevant
   PDF page number(s). Use the provided Page Number from the context.
   Never invent a page number."
3. **Context injection** (line 32-33): RETRIEVED CONTEXT block with
   explicit `Page Content`, `Page Number`, `File location` per chunk
4. **Structured output** (lines 21-30): enforced Summary/Answer/Source
   format

**Quiz prompt** (`system_prompt.py:40-76`): additionally uses
`response_format: json_object` in the Gemini API call to force JSON
output, with a regex fallback for malformed responses
(`queues/rag_jobs.py:122-131`).

**Why this matters for interviews:**
- RAG is only as good as the prompt — a naive "answer this question"
  prompt without grounding instructions will hallucinate
- Page citation enforcement requires the prompt to include the page
  numbers in the context string itself (not just the vector store)
- JSON-mode enforcement is a practical pattern for structured
  extraction from LLMs

**Improvement ideas:** few-shot examples in the prompt, chain-of-thought
for complex questions, prompt versioning/A/B testing.

### 7.7 Vector store deletion and idempotency

**What:** When a user deletes or re-uploads a document, all its points
must be removed from Qdrant without affecting other documents in the
same collection.

**Implementation:**
- `services/vectorstore.py:62-78`: `delete_documents()` builds a
  `Filter(must=[FieldCondition(key="metadata.doc_id",
  match=MatchValue(value=document_id))])` and passes it to
  `client.delete(points_selector=FilterSelector(filter=...))`
- `queues/rag_jobs.py:76-77`: before adding new points, old points are
  deleted by `doc_id` — making re-upload idempotent

**The dotted-path trap:** Qdrant's nested payload structure means the
filter key must be `metadata.doc_id`, not `doc_id`. Using the wrong
path silently matches zero points — the delete returns 204 but nothing
is removed. This was discovered during testing and is the hardest class
of bug to catch: no error, no failure, just no effect.

### 7.8 SQLite concurrency considerations

**What:** SQLite uses file-level locking for writes; concurrent access
from multiple processes can cause `database is locked` errors.

**Implementation:**
- `services/db.py:6-8`: `connect_args={"check_same_thread": False,
  "timeout": 30}` — the timeout makes SQLite wait up to 30s for a
  write lock before raising
- The API process and the RQ worker process both access the same
  SQLite file: API writes rows on upload; worker updates status on
  ingest completion
- RQ's default worker uses a single process (no thread pool), so
  concurrent writes are rare

**Why not Postgres:** For a single-user/student-project deployment,
SQLite is zero-config. The `timeout=30` handles the rare contention
from the API + worker writing within the same second.

**When to migrate:** Multiple concurrent API processes (uvicorn
workers > 1), or when deployment targets production with multiple
users uploading simultaneously.

### 7.9 Scaling considerations

| Bottleneck | Current | Production fix |
|-----------|---------|---------------|
| SQLite writes | Single-file, ~30s timeout | Postgres/MySQL + connection pooling |
| Qdrant collections | 1 per user (lightweight) | Shard across nodes when >50K collections |
| Model load per job | SimpleWorker preloads once, jobs serialized in-process | Multiple SimpleWorker processes, or fork on Linux (segfaults on macOS with torch) |
| LLM latency | Synchronous call blocks worker | Multiple workers, streaming responses |
| No job retry | Failed jobs stay failed | RQ `Retry(max=3, interval=[10, 30, 60])` |
| Polling overhead | Client polls every 3s | SSE/WebSocket push on job completion |
| File storage | Local disk | S3/object storage |
| Auth revocation | No blacklisting | Redis token blacklist with TTL |

### 7.10 Security considerations

| Aspect | Current state | Production hardening |
|--------|--------------|---------------------|
| Password hashing | bcrypt (cost 10 default) | Increase to cost 12+ |
| JWT secret | In `.env` file | Use KMS/secrets manager |
| Refresh tokens | Stateless, no revocation | Store in DB, rotate on use |
| Rate limiting | None | slowapi or API gateway |
| File upload | .pdf check + 50MB limit | Magic-byte validation, virus scan |
| CORS | `allow_origins=["*"]` | Restrict to frontend domain |
| SQL injection | Safe (SQLAlchemy ORM + parameterized) | Same |
| Path traversal | `os.path.basename()` strips dirs | Same |
| Job ownership | Any user can poll any job_id | Tie jobs to user_id in Redis |
| API key in `.env` | Gitignored | Rotate regularly |

---

## 8. Troubleshooting cheat sheet

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `GET /jobs/{id}` returns `status: failed`, `error: TypeError: ... unexpected keyword argument 'timeout'` | Old rq_client code running | Restart API process |
| `GET /jobs/{id}` returns `status: failed`, `error: SIGABRT / objc ... fork` | macOS fork crash in fork mode | Set `RQ_WORKER_MODE=simple` (or `spawn`) in `.env` |
| `GET /jobs/{id}` returns `status: finished`, `result: "No documents have been indexed yet"` | Qdrant filter returned 0 points — wrong field path in filter | Check `metadata.doc_id` not `doc_id` |
| Ingest succeeds but `GET /documents` still shows `processing` | Worker crashed before the DB update, or old API code | Check worker log; restart API + worker |
| `DELETE /documents/{id}` returns 204 but points remain | API running old code with wrong filter path | Restart API |
| Upload returns 422 "Only PDF files are allowed" | File extension missing or non-.pdf | Rename file with `.pdf` extension |
| `401 Unauthorized` on all protected endpoints | JWT expired or wrong token | Re-login, send fresh access token |
| `database is locked` error | SQLite contention from concurrent writes | Already mitigated with `timeout=30`; for persistent issues, migrate to Postgres |
| Worker log shows `HuggingFaceEmbeddings` download progress | First run, model downloading | Wait for completion (~80MB); subsequent runs use cache |
| Ingestion takes ~10s+ every job (heavy even for small PDFs) | `RQ_WORKER_MODE=spawn` re-execs per job → model + HF Hub check reloaded each time | Set `RQ_WORKER_MODE=simple` + `HF_HUB_OFFLINE=1`; restart worker; verify single `Loading weights` in log (§6.6) |
| Jobs "stuck" QUEUED though worker is running | Worker listening on a different Redis (e.g. Docker `localhost:6379`) than the API enqueues to (cloud Upstash) | Confirm `REDIS_URL` matches; restart API **and** worker; check `rq:queue:default` length |
| Second upload of the same PDF fails with `Index required but not found for metadata.doc_id` | Qdrant payload index missing for nested filter field | `_ensure_payload_indexes()` creates keyword indexes on `metadata.doc_id`/`metadata.user_id` at collection creation + before delete (§6.6) |
| Quiz returns raw text instead of JSON | LLM ignored `response_format: json_object` | Regex fallback extracts JSON; retry may work |
