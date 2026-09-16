# Athenaeum — Codebase Workflow & Guide

---

## Table of contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Data model](#3-data-model)
4. [Request-lifecycle walkthroughs](#4-request-lifecycle-walkthroughs)
5. [How to run](#5-how-to-run)
6. [Gotchas discovered during development](#6-gotchas-discovered-during-development)
7. [Hot points](#7-hot-points)
8. [Troubleshooting cheat sheet](#8-troubleshooting-cheat-sheet)

---

## 1. Overview

Athenaeum is a full-stack RAG (Retrieval-Augmented Generation) backend for a
student study agent. Users upload multiple PDFs, and the system answers
questions, generates quizzes, and creates summaries grounded entirely in the
uploaded content with page-level citations.

| Component | Technology | Role |
|-----------|-----------|------|
| API | FastAPI + uvicorn | REST endpoints, auth, request validation |
| Async work | FastAPI `BackgroundTasks` | Post-ingestion runs in-process after the upload response |
| Vector store | Qdrant | Per-user collections, similarity search |
| Relational DB | Postgres (Supabase) / SQLite fallback | Users + document metadata |
| File storage | Supabase S3 (`athenaeum` bucket) | Raw PDF objects; S3 object key in `documents.content` |
| Embeddings | HF Inference API — `HuggingFaceEndpointEmbeddings` (`all-MiniLM-L6-v2`, 384-dim) | Hosted server-side embedding; **no model loaded into app RAM** |
| LLM | Groq (`openai/gpt-oss-120b`, OpenAI-compatible) | Grounded generation |
| PDF parser | pypdf | Page-level text extraction |

Key design decisions:

- **Every user gets their own Qdrant collection** (`rag_{user_id}`), so
  document isolation requires zero runtime filtering at the user boundary.
- **No dedicated worker/queue.** Ingestion is a Starlette `BackgroundTask`
  that runs in the API process; chat/quiz/summary are synchronous. This keeps
  the deployment to a single process (important for small hosts), at the cost
  of true concurrency — see §6.1 and §7.2.
- **Embeddings are remote.** The only ML component that used to consume
  significant RAM (a local sentence-transformers model) now runs on
  HuggingFace's servers.

---

## 2. Architecture

```
                      ┌───────────────────────────────────────────────┐
                      │                FastAPI (uvicorn)               │
                      │   server.py — routes, auth guard, validation   │
                      │                                                │
                      │   BackgroundTasks ──► services/rag.py          │
                      │       ingest_document()                        │
                      └───┬───────────────┬───────────────┬───────────┘
                          │               │               │
                  SQLAlchemy ORM     QdrantClient     boto3 S3 client
                          │               │               │
                  ┌───────▼──────┐ ┌──────▼───────┐ ┌──────▼─────────┐
                  │ Postgres     │ │ Qdrant Cloud │ │ Supabase       │
                  │ (or SQLite)  │ │  rag_{uid}   │ │ Storage bucket │
                  │ users/docs   │ │  collections │ │  athenaeum     │
                  └──────────────┘ └──────────────┘ └────────────────┘
                          │               │
                          │        ┌──────▼─────────────────────────┐
                          │        │ HF Inference API (remote HTTP) │
                          │        │  all-MiniLM-L6-v2 → 384-dim    │
                          │        └────────────────────────────────┘
                          │
                   ┌──────▼──────────────────────────┐
                   │ Groq API (remote HTTP)          │
                   │  openai/gpt-oss-120b            │
                   └─────────────────────────────────┘
```

Everything runs in **one process** (`python main.py`). There is no Redis, no
RQ worker, and no separate job runner. Ingestion is dispatched as an in-process
background task after the upload handler returns.

### File responsibilities

```
main.py                       uvicorn entrypoint (reads PORT, default 8080)
server.py                     FastAPI app, all route handlers, auth guard, CORS
config.py                     env-driven settings singleton
models.py                     SQLAlchemy User, Document
schemas.py                    Pydantic request/response contracts
system_prompt.py              ANSWER / QUIZ / SUMMARY prompt builders
services/db.py                SQLAlchemy engine (Postgres/SQLite), session, init_db
services/security.py          bcrypt hash/verify, JWT sign/decode
services/pdf.py               pypdf page-level parser
services/vectorstore.py       Qdrant collection CRUD, search, delete, embeddings
services/storage.py           Supabase S3 upload/download/delete
services/retry.py             retry_on_errors() decorator for transient DB errors
services/rag.py               ingest_document, answer_question, generate_quiz, generate_summary
```

---

## 3. Data model

### `users` table

| Column | Type | Notes |
|--------|------|-------|
| id | UUID (36-char string) | PK, generated on create |
| email | VARCHAR(320) | unique, indexed |
| password_hash | VARCHAR(255) | bcrypt hash |
| name | VARCHAR(255) | display name |
| created_at | DATETIME | UTC, on create |

*File: `models.py:18-29`*

### `documents` table

| Column | Type | Notes |
|--------|------|-------|
| id | UUID (36-char string) | PK, used as Qdrant `doc_id` |
| user_id | UUID (FK → users.id) | indexed |
| filename | VARCHAR(512) | original upload name |
| content | LargeBinary | S3 object key `{user_id}/{doc_id}.pdf` (UTF-8 bytes) in the `athenaeum` bucket; raw PDF bytes are **not** stored in the DB |
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

Status is set at the end of `ingest_document` in
`services/rag.py:91-94` (ready) or the `except` branch
(`services/rag.py:101-109`, failed). On re-upload of the same doc, old
points are deleted first (idempotent), then new points are added — so the
status always resolves to `ready` if parsing succeeds.

The frontend polls `GET /documents` to observe the transition (there is no
per-job endpoint).

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

*File: `services/vectorstore.py:76-85` (add), `:111-149` (search),
`:88-108` (delete)*

---

## 4. Request-lifecycle walkthroughs

### 4.1 Register + login (JWT lifecycle)

```
Client                          FastAPI                    Postgres/SQLite
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

**Auth guard** (`server.py:70-90`): every protected route declares
`current_user: User = Depends(get_current_user)`. That dependency reads
the `Authorization: Bearer <token>` header via
`OAuth2PasswordBearer(tokenUrl="auth/login")`, decodes the JWT, validates
type is `"access"`, and loads the user from the DB. If anything fails, it
raises a 401 with `WWW-Authenticate: Bearer` — and Swagger's "Authorize"
button works automatically because of the `tokenUrl` parameter.

**Refresh** (`POST /auth/refresh`, `server.py:142-152`): accepts
`{refresh_token}` body, decodes the `refresh`-typed token, issues a new
access token. No rotation — stateless and simple. The frontend calls this
automatically on a 401 (`frontend/lib/api.ts:65-68,82-102`).

*Files: `services/security.py:9-48`, `server.py:111-157`*

### 4.2 PDF upload → ingestion (BackgroundTasks)

```
Client                          FastAPI                 S3        BackgroundTask        Qdrant
  │                               │                      │              │                 │
  │  POST /documents              │                      │              │                 │
  │  files[]                      │                      │              │                 │
  │ ─────────────────────────────→│                      │              │                 │
  │                               │ validate: .pdf only, │              │                 │
  │                               │ size ≤ MAX_UPLOAD_MB │              │                 │
  │                               │ INSERT document      │              │                 │
  │                               │   status=processing  │              │                 │
  │                               │ db.flush()           │              │                 │
  │                               │ PUT {uid}/{doc}.pdf →│              │                 │
  │                               │   athenaeum bucket   │              │                 │
  │                               │ content = S3 key     │              │                 │
  │                               │ db.commit()          │              │                 │
  │                               │ add_task(ingest_document, uid, doc) │                 │
  │  202 {uploads:[{filename,     │ ────────────────────────────────→───┘                 │
  │        document_id}]}         │                      │              │                 │
  │←──────────────────────────────│                      │              │                 │
  │                               │                      │  GET object  │                 │
  │                               │                      │←─────────────│                 │
  │                               │                      │              │ load_pdf_pages() │
  │                               │                      │              │ enrich metadata  │
  │                               │                      │              │ ensure_collection│
  │                               │                      │              │────────────────→│
  │                               │                      │              │ delete old points│
  │                               │                      │              │ (idempotent)     │
  │                               │                      │              │ add_documents()  │
  │                               │                      │              │  (remote embed)  │
  │                               │                      │              │────────────────→│
  │                               │                      │              │ UPDATE document: │
  │                               │                      │              │  status=ready,   │
  │                               │                      │              │  total_pages=N   │
  │  GET /documents               │                      │              │                 │
  │ ─────────────────────────────→│  (later poll shows status)            │                 │
```

**Endpoint behaviour** (`server.py:163-220`): for each file it validates the
`.pdf` extension and streams the body while enforcing `MAX_UPLOAD_MB`
(`settings.MAX_UPLOAD_MB * 1024 * 1024`, default **10 MB**). It inserts the
row and `flush()`es to obtain an id, uploads the bytes to S3, stores the key
in `content`, commits, then schedules `ingest_document` via
`background_tasks.add_task(...)`. The response is `202` with
`{uploads: [{filename, document_id}]}`.

**Why flush-then-upload-then-commit?** If the S3 PUT fails, the transaction
is rolled back and the endpoint returns 500 — so a partially-uploaded object
can't outlive its row while a committed row can't reference a missing key.

**Why a background task?** The upload response returns as soon as the object
is stored; parsing + remote embedding then run after the response, without
blocking the client. A 50-page PDF can take many seconds because each page
batch is a network round-trip to the HF Inference API.

**Page-level chunking** (`services/pdf.py:7-35`): each non-empty page becomes
one LangChain `Document`. This is a deliberate choice over sliding-window
chunking — page boundaries provide:
- Natural citation anchors (page numbers)
- Coherent semantic units (each page is a self-contained section)
- No cross-page text splitting artifacts

The tradeoff is that very long pages get less granular retrieval, but
for textbooks this is acceptable. Empty pages (no extractable text) are
skipped.

**Ingestion** (`services/rag.py:61-111`): wrapped in `@retry_on_errors()`
(§6.5). It loads the row, downloads the object by the key stored in
`row.content`, parses pages, stamps `user_id` / `doc_id` / `source` onto each
page's metadata, calls `delete_documents(user_id, doc_id)` (idempotent
re-index), then `add_documents()`, then sets `total_pages` and
`status="ready"`. Any exception marks the row `failed` with the error text
(guarded so a dead DB can't mask the original exception) and re-raises.

**Idempotent re-indexing** (`services/rag.py:88-89`):
`delete_documents(user_id, doc_id)` removes all points with matching
`metadata.doc_id`, then `add_documents()` inserts fresh vectors. This
means re-uploading the same PDF simply replaces the old index.

### 4.3 Chat / quiz / summary flow (synchronous)

These endpoints run **synchronously** in the request — they do not return a
job id and there is no `GET /jobs/{id}` endpoint.

```
Client                          FastAPI                         Worker internals
  │                               │                                 │
  │  POST /chat                   │                                 │
  │  {question, document_ids?:[]} │                                 │
  │ ─────────────────────────────→│                                 │
  │                               │ get_current_user                │
  │                               │ answer_question(...)            │
  │                               │                                 │
  │                               │  _retrieve_context():           │
  │                               │    search(user_id, query, k=4,  │
  │                               │      document_ids)              │
  │                               │    → embed_query (remote HF)    │
  │                               │    → Qdrant query_points()      │
  │                               │      cosine similarity → top-k  │
  │                               │                                 │
  │                               │  build RAG_SYSTEM_PROMPT:       │
  │                               │    context = "Page Content: ...,│
  │                               │    Page Number: ..., File: ..." │
  │                               │                                 │
  │                               │  _complete(prompt, question):   │
  │                               │    OpenAI(Groq).chat.completions│
  │                               │    → plain text with citations  │
  │                               │                                 │
  │  200 {answer: "..."}          │                                 │
  │←──────────────────────────────│                                 │
```

- **Chat** (`server.py:269-279` → `services/rag.py:114-119`): retrieve
  `k=4`, build `RAG_SYSTEM_PROMPT`, complete, return `{answer}`.
- **Quiz** (`server.py:282-292` → `services/rag.py:122-147`): retrieve
  `k=max(6, num_questions * 2)`, pass `response_format={"type":
  "json_object"}` to the model. If the model returns malformed JSON, a regex
  fallback (`re.search(r"\{.*\}", content, re.DOTALL)`) extracts the
  outermost object and retries the parse.
- **Summary** (`server.py:295-305` → `services/rag.py:150-159`): retrieve
  `k=8`, build `SUMMARY_SYSTEM_PROMPT`, return `{summary}`.

**LLM client** (`services/rag.py:21-58`): a singleton `OpenAI` client pointed
at `BASE_URL_GROQ` (`https://api.groq.com/openai/v1`) using
`MODEL_NAME_GROQ` (`openai/gpt-oss-120b`). The `GEMINI_*` / `BASE_URL` /
`MODEL_NAME` settings still exist in `config.py` but are **not used** by the
current RAG code — treat them as legacy.

**k-value tuning**: chat uses `k=4` (concise, fast), quiz uses
`k=max(6, num_questions * 2)` (more context for generation), summary
uses `k=8` (broader coverage).

**Empty-index guard**: if retrieval returns nothing (collection missing or no
matching docs), the functions short-circuit with "No documents have been
indexed yet. Upload a PDF first." instead of calling the LLM.

### 4.4 Deletion flow

```
DELETE /documents/{doc_id}
  │
  ├─ verify ownership (row.user_id == current_user.id)
  ├─ storage.delete_object(row.content)   # S3 `athenaeum` bucket
  ├─ delete_documents(user_id, doc_id)
  │    └─ Qdrant FilterSelector(filter=metadata.doc_id == doc_id)
  │       └─ removes all matching points
  ├─ db.delete(row) + db.commit()
  └─ 204 No Content
```

*File: `server.py:238-263`*

The Qdrant filter uses the dotted path `metadata.doc_id` because
`langchain-qdrant` stores metadata under a nested `metadata` key in the
payload. Using bare `doc_id` at the top level would silently match
nothing (§6.4).

---

## 5. How to run

### Local (single process — no worker)

```bash
cd backend

# create/activate venv and install deps (first time)
python -m venv venv
./venv/bin/pip install -r requirements.txt

# run the API (reads PORT, defaults to 8080; .env sets 8081)
./venv/bin/python main.py

# Open http://localhost:8081/docs for Swagger UI
```

There is no separate worker command — ingestion runs inside the API process as
a background task.

### Docker

```bash
cd backend
docker build -t athenaeum-api .
docker run --env-file .env -p 8081:8081 athenaeum-api
```

The image no longer downloads any model at build time (embeddings are remote).

### Environment variables (`.env`)

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | API port (read by `main.py`) | `8080` |
| `GROQ_API_KEY` | LLM API key (used) | required |
| `BASE_URL_GROQ` | Groq OpenAI-compat endpoint | `https://api.groq.com/openai/v1` |
| `MODEL_NAME_GROQ` | LLM model identifier | `openai/gpt-oss-120b` |
| `GEMINI_API_KEY` | Legacy — unused by current RAG code | — |
| `BASE_URL` | Legacy — unused | — |
| `MODEL_NAME` | Legacy — unused | — |
| `JWT_SECRET` | HMAC key for JWT signing | required (generate with `secrets.token_urlsafe(64)`) |
| `JWT_ALGORITHM` | JWT signing algorithm | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Access token TTL | `30` |
| `REFRESH_TOKEN_EXPIRE_DAYS` | Refresh token TTL | `7` |
| `QDRANT_URL` | Qdrant server | `http://localhost:6333` |
| `QDRANT_API_KEY` | Qdrant API key (cloud) | — |
| `EMBEDDING_MODEL` | HF model id used by the hosted Inference API | `sentence-transformers/all-MiniLM-L6-v2` |
| `EMBEDDING_DIM` | Vector dimension | `384` |
| `HF_TOKEN` | HuggingFace access token for the Inference API (required in prod; generate at https://huggingface.co/settings/tokens) | required |
| `DATABASE_URL` | SQLAlchemy connection string | `sqlite:///./athenaeum.db` |
| `MAX_UPLOAD_MB` | Per-file upload cap | `10` |
| `UPLOAD_DIR` | Legacy local PDF directory (unused) | `uploads` |
| `SUPABASE_S3_ENDPOINT` | Supabase S3-compatible endpoint (`https://{ref}.storage.supabase.co/storage/v1/s3`) | required |
| `SUPABASE_S3_REGION` | Region used for SigV4 signing | `ap-southeast-2` |
| `SUPABASE_S3_BUCKET` | Storage bucket for PDFs | `athenaeum` |
| `SUPABASE_S3_ACCESS_KEY` | S3 access key (Dashboard → Storage → Settings → S3 Access Keys) | required |
| `SUPABASE_S3_SECRET_KEY` | S3 secret key | required |

---

## 6. Gotchas discovered during development

These are real bugs encountered and fixed during the build — excellent
interview material because they show debugging depth.

### 6.1 From RQ + Redis to FastAPI BackgroundTasks (removed complexity)

The first version offloaded ingestion and LLM calls to **RQ (Redis Queue)**
workers (`worker.py`, `queues/rag_jobs.py`, `client/rq_client.py`). That
brought a class of operational problems disproportionate to the app's size:

- **`rq` API drift:** RQ 2.12 renamed the per-job timeout parameter from
  `timeout` to `job_timeout`; passing `timeout=900` leaked into the job
  kwargs and raised `unexpected keyword argument 'timeout'`.
- **macOS fork crash:** RQ's default `Worker` uses `os.fork()` to spawn
  work-horses. On macOS, ObjC/libdispatch state held at fork time made the
  child `SIGABRT` (`+[NSNumber initialize] may have been in progress in
  another thread when fork() was called`). `SpawnWorker` avoided the fork but
  re-exec'd a fresh process per job; `SimpleWorker` ran in-process but still
  needed a preloaded embedding model.
- **Two long-lived processes** (API + worker) meant shared modules had to be
  restarted in *both* places, and a worker pointing at the wrong Redis
  (local Docker vs cloud) silently left jobs `QUEUED` forever.

Since embeddings are now remote (no model to preload) and a queue wasn't
needed for correctness, the worker layer was deleted entirely in favour of
Starlette's `BackgroundTasks`. Net result: one process, no Redis dependency,
no fork concerns. The tradeoff is that ingestion shares the API process and
its event loop/threadpool — acceptable for this scale, but see §7.2.

> **Lesson:** infrastructure should be proportional to the workload. A
> single-process background task is often the right call until you genuinely
> need retries, priorities, or horizontal worker scaling.

### 6.2 Retained: langchain-qdrant 1.1.0 constructor change

**Symptom:** `QdrantVectorStore.__init__() got an unexpected keyword argument 'url'`

**Root cause:** `langchain-qdrant` 1.1.0 changed its constructor to accept
a `client: QdrantClient` instance instead of `url=` / `collection_name=`
directly.

**Fix:** `services/vectorstore.py:80-84` now passes
`client=QdrantClient(url=...)` (the shared `_client()` singleton) instead of
`url=settings.QDRANT_URL`.

### 6.3 Retained: qdrant-client 1.19 method renames

**Symptoms:**
- `query_points()` rejected `with_vector=False` as unknown kwarg
- `scroll()` rejected `filter=` as unknown kwarg

**Root cause:** qdrant-client 1.19 changed the parameter names to
`query_filter` and `scroll_filter` respectively, and removed the
`with_vector` keyword from `query_points`.

**Fix:** `services/vectorstore.py:135-141` uses `query_filter=` (no
`with_vector`).

### 6.4 Retained: nested payload filter trap

**Symptom:** `DELETE /documents/{id}` returned 204 but points remained
in Qdrant. Scoped chat still answered from the "deleted" document.

**Root cause:** `langchain-qdrant` stores metadata under a nested
`metadata` key in the payload, so `Filter(key="doc_id", ...)` matches
nothing — the field is actually at `metadata.doc_id`. Direct Qdrant
deletion via `FilterSelector(filter=Filter(key="metadata.doc_id", ...))`
works correctly.

**Follow-up index requirement:** qdrant-client ≥1.19 requires explicit
**payload indexes** for field filters. `delete()` by `metadata.doc_id`
without an index raises
`QdrantException: Index required but not found for metadata.doc_id`.
`services/vectorstore.py` creates keyword payload indexes on
`metadata.doc_id` and `metadata.user_id` via `_ensure_payload_indexes()`
(called from `ensure_collection()` and `delete_documents()`). Without this,
the **second** upload of a document (which deletes old points first) fails
while the first succeeds.

**Lesson:** In RQ + FastAPI setups, restarting only one process does NOT
refresh imported code in the other. Both had to be restarted when shared
modules changed. (No longer applicable now that there is a single process.)

### 6.5 Retained: Postgres/Neon drops the pooled connection

**Symptom:** after switching `DATABASE_URL` from local SQLite to a cloud
Neon Postgres instance, an ingestion job failed at the document lookup:

```
sqlalchemy.exc.OperationalError: (psycopg2.OperationalError)
SSL connection has been closed unexpectedly
[SQL: SELECT documents.id, ... FROM documents WHERE documents.id = %(pk_1)s]
```

**Root cause:** the connection pool held connections open for hours; Neon
terminates idle SSL connections and the pool handed out a dead one because
no liveness check was enabled (`pool_pre_ping` defaults to `False`).

Two compounding bugs made the impact worse:

1. **`db.get()` ran outside the `try/finally`** in `ingest_document`. When
   the dead connection raised, the exception propagated uncaught: the
   `Session` leaked, the document was never marked `failed`, and it stayed
   stuck at `processing` forever.
2. **No retry.** The only remedy was re-uploading the same PDF.

**Fixes applied:**

* `services/db.py:6-12` enables `pool_pre_ping=True`, `pool_recycle=300`,
  and `connect_args={"connect_timeout": 15}` for Postgres URLs (SQLite keeps
  `timeout=30` / `check_same_thread`).
* New util `services/retry.py`: `retry_on_errors()` decorator (3 attempts,
  1s initial delay, ×2 backoff) catching `sqlalchemy.exc.DBAPIError`.
  Applied as `@retry_on_errors()` to `ingest_document`.
* `ingest_document` keeps `SessionLocal()` / `db.get()` **inside**
  `try/finally` so the session is always closed; the failure branch only
  marks the document `failed` when a row was actually fetched, and that
  commit is itself guarded.

**Result:** a dropped connection reconnects transparently (pre-ping) or
retries from a fresh session up to 3 times.

### 6.6 Retained: Supabase S3-compatible storage

**What changed:** PDF bytes moved out of the `documents.content`
LargeBinary column into a private Supabase Storage bucket (`athenaeum`).
The `content` column now stores the **S3 object key** (`{user_id}/{doc_id}.pdf`,
UTF-8 encoded) — the frontend API contract is unchanged, so no frontend
changes were needed.

**The three traps that shaped the implementation:**

1. **`create_all` does not migrate.** `init_db()` runs
   `Base.metadata.create_all()`, which creates tables but never alters
   existing ones. Adding a new column would have crashed on the live
   Postgres table with `column does not exist`. Hence reusing the existing
   `content` column for the key — zero migration. If you ever add a real
   column, you'll need an Alembic migration or a manual `ALTER TABLE`.

2. **endpoint_url ≠ AWS.** Supabase's S3-compatible API lives at
   `https://{project-ref}.storage.supabase.co/storage/v1/s3`. boto3
   needs `endpoint_url` set (it's not AWS), plus the **storage** access
   keys (Dashboard → Storage → Settings → S3 Access Keys), not the project
   API keys. `region_name` is only used for SigV4 signing.

3. **Ingestion must fetch from S3.** `ingest_document` (a background task)
   no longer has the PDF bytes in the DB row — it decodes the key from
   `row.content` and calls `download_object()`. If an object is deleted
   out-of-band (dashboard/CLI), ingestion marks the doc `failed`.

*File: `services/storage.py:25-44`*

### 6.7 Remote embeddings migration (fixing OOM on a 512MB host)

**Symptom:** the app OOM-crashed on a memory-constrained host (Render
512MB), especially on upload/ingest.

**Root cause:** `HuggingFaceEmbeddings(model_name="sentence-transformers/
all-MiniLM-L6-v2")` loaded the model into the app process. With `torch` +
`transformers` + weights this consumed **300-400MB+**, leaving no headroom.

**What we measured on the old local path (historical):**
| Stage | Cost |
|-------|------|
| HF Hub unauthenticated network check | ~7s |
| `import torch` + `transformers` + `sentence-transformers` | ~3s |
| Actual `encode()` of a few pages | ~0.1s |

**Fix:** switched `services/vectorstore.py` to
`HuggingFaceEndpointEmbeddings`, which sends embedding requests over HTTPS
to the HuggingFace Inference API — the model runs on HF's servers, **not in
the container**. `HF_TOKEN` authenticates the calls. The Dockerfile's
`snapshot_download` build step and `HF_HOME` env were removed, and
`torch`, `transformers`, `sentence-transformers`, `safetensors`,
`tokenizers`, `scikit-learn`, `scipy`, `joblib`, `sympy`, `networkx`,
`mpmath`, and `threadpoolctl` were dropped from `requirements.txt`.

**Verify:** `curl`/Python `embed_query("hello")` returns a 384-length
vector. In prod, confirm `HF_TOKEN` is set — a missing/invalid token yields
401/403 from `huggingface.co`.

**Tradeoffs:** remote embeddings add network latency (~200-500ms per batch,
plus provider cold start) and are subject to free-tier rate limits (429).
Mitigations: retry/backoff in `vectorstore.py`, smaller batches, or a
dedicated HF Inference Endpoint. See §7.5.

---

## 7. hot points

Each section: **what the concept is** → **how this codebase implements
it** → **why this choice** → **tradeoffs / what you'd improve**.

### 7.1 RAG fundamentals

**What:** Retrieval-Augmented Generation grounds LLM responses in
retrieved documents instead of relying on training data. The pipeline
is: embed query → retrieve top-k similar chunks → inject them into a
system prompt → LLM generates a grounded response.

**Implementation:** `services/vectorstore.py:111-149` performs cosine
similarity search via `QdrantClient.query_points()` using
`all-MiniLM-L6-v2` embeddings (384-dim, hosted on the HF Inference API).
Retrieved documents are joined into a context string
(`services/rag.py:31-43`) with explicit page number and source file labels.
The system prompt (`system_prompt.py:1-37`) constrains the LLM to only use
this context.

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

### 7.2 Background-task design (vs a real queue)

**What:** Long-running post-upload work (PDF ingestion) is offloaded so the
HTTP response isn't blocked.

**Implementation:** `server.py:216` schedules
`background_tasks.add_task(ingest_document, current_user.id, row.id)` on
Starlette's `BackgroundTasks`. The task runs in the API process after the
response is sent. Read endpoints (`/chat`, `/quiz`, `/summary`) are
synchronous and return their result directly.

**Why `BackgroundTasks` over RQ/Celery:**
- Zero extra infrastructure (no Redis, no worker process) — important for a
  small single-instance deployment.
- The task is fire-and-forget with no need for priorities, scheduling, or
  cross-process results, which is exactly what `BackgroundTasks` provides.
- It eliminated an entire class of bugs (fork safety on macOS, per-job model
  reload, two-process code-sync) that the previous RQ setup introduced
  (§6.1).

**Tradeoffs:**
- *No retries / no dead-letter queue*: a failed ingest marks the document
  `failed` but isn't automatically retried (there is a DB-level
  `retry_on_errors`, but not a job-level retry).
- *No concurrency control*: background tasks share the API process and its
  threadpool. A burst of large uploads competes with request handling. A real
  queue with dedicated workers scales better.
- *Not durable*: if the process restarts mid-ingest, the task is lost and the
  document is stuck at `processing` (re-upload to recover).
- *Status via polling*: the frontend polls `GET /documents` rather than a
  push channel.

**Improvement ideas:** move ingestion to RQ/Celery + a worker when upload
volume grows; add a reconciliation sweep that re-queues documents stuck at
`processing`; add job-level retries; expose an SSE/WebSocket status stream.

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
- `server.py:64,70-90`: `OAuth2PasswordBearer(tokenUrl="auth/login")`
  extracts the Bearer token; `get_current_user` dependency decodes it
  and loads the user
- `server.py:130-139`: login uses `OAuth2PasswordRequestForm` (username
  field = email) so Swagger's "Authorize" button works out of the box
- `frontend/lib/api.ts:65-102`: transparently refreshes on 401 and retries
  the original request once

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
- *No rate limiting on auth endpoints*: brute-force protection
  (e.g., slowapi) should be added.

### 7.4 Multi-tenancy and data isolation

**What:** Each user's data must be fully isolated — user A cannot
query or see user B's documents.

**Implementation:** Every user gets their own Qdrant collection named
`rag_{user_id}` (`services/vectorstore.py:34-35`). Collection creation
is lazy — created on first upload (`ensure_collection()`,
`services/vectorstore.py:61-73`). All search, add, and delete operations
are scoped to the user's collection by construction. No user-ID filter is
needed in Qdrant queries (though `metadata.user_id` is stored and indexed
for future needs).

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
- `services/vectorstore.py:23-31`: `HuggingFaceEndpointEmbeddings` is
  lazily initialized once per process (singleton pattern) and points at
  the HuggingFace Inference API — the model runs on HuggingFace's
  servers, **not** in the app process
- `services/vectorstore.py:122`: `embed_query()` converts the user's
  question to a 384-dim vector over HTTPS
- `services/vectorstore.py:135-141`: `QdrantClient.query_points()`
  performs approximate nearest neighbor (ANN) search with cosine
  distance
- `services/vectorstore.py:61-73`: collection created with
  `VectorParams(size=384, distance=Distance.COSINE)`

**Why MiniLM-L6-v2 (hosted):**
- Served by the HF Inference API, so **no weights and no `torch`
  runtime** in the container — critical on memory-constrained hosts
  (e.g. Render 512MB)
- Good balance of quality/speed for student content
- 384 dimensions keeps storage and search efficient and matches
  `EMBEDDING_DIM`

**Embedding lifecycle (remote):**
`get_embeddings()` returns a thin `HuggingFaceEndpointEmbeddings`
client authenticated with `HF_TOKEN`. There is **no model download, no
`HF_HOME` cache, no preload, and no in-process inference**. The first
call may pay a provider cold start; subsequent calls are network
round-trips (~200-500ms per batch). Ingestion runs as a Starlette
`BackgroundTask` in the API process (`server.py`), so remote calls
don't block the upload response.

**Memory note:** the previous design loaded
`sentence-transformers/all-MiniLM-L6-v2` (plus `torch` / `transformers`)
into RAM — the cause of OOM crashes on a 512MB host. Switching to the
hosted endpoint removed `torch`, `transformers`,
`sentence-transformers`, `safetensors`, `tokenizers`, `scikit-learn`,
`scipy`, `joblib`, `sympy`, `networkx`, `mpmath` and `threadpoolctl`
from `requirements.txt` (the Dockerfile's model `snapshot_download` step
was also dropped).

**Improvement ideas:**
- Add retry/backoff around the Inference API for transient 429/503s
- Batch or cache embeddings for repeated queries
- Use a dedicated HF Inference Endpoint for guaranteed throughput
- Use Qdrant's built-in payload indexes on `metadata.doc_id` for
  faster filtered search

### 7.6 Prompt engineering for grounded generation

**What:** Structuring the LLM prompt to maximize factual accuracy and
enforce output format constraints.

**Implementation (`system_prompt.py`):**

Three prompt builders share a common pattern:

1. **Hard grounding rules** (`system_prompt.py:8-11` in the ANSWER prompt):
   "Use only the retrieved context. Do not use outside knowledge. Do
   not hallucinate."
2. **Citation enforcement** (`system_prompt.py:14-16`): "Always provide the
   relevant PDF page number(s). Use the provided Page Number from the context.
   Never invent a page number."
3. **Context injection** (`system_prompt.py:32-33`): RETRIEVED CONTEXT block
   with explicit `Page Content`, `Page Number`, `File location` per chunk
4. **Structured output** (`system_prompt.py:21-30`): enforced
   Summary/Answer/Source format

**Quiz prompt** (`system_prompt.py:40-76`): additionally uses
`response_format: json_object` in the Groq API call to force JSON
output, with a regex fallback for malformed responses
(`services/rag.py:138-147`).

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
- `services/vectorstore.py:88-108`: `delete_documents()` builds a
  `Filter(must=[FieldCondition(key="metadata.doc_id",
  match=MatchValue(value=document_id))])` and passes it to
  `client.delete(points_selector=FilterSelector(filter=...))`
- `services/rag.py:88-89`: before adding new points, old points are
  deleted by `doc_id` — making re-upload idempotent

**The dotted-path trap:** Qdrant's nested payload structure means the
filter key must be `metadata.doc_id`, not `doc_id`. Using the wrong
path silently matches zero points — the delete returns 204 but nothing
is removed. This was discovered during testing and is the hardest class
of bug to catch: no error, no failure, just no effect (§6.4).

### 7.8 Database considerations (Postgres + SQLite fallback)

**What:** The app supports both a cloud Postgres (Supabase) in production
and SQLite for local dev, chosen from `DATABASE_URL` in `services/db.py:6-19`.

**Implementation:**
- **Postgres:** `pool_pre_ping=True` (health-check pooled connections),
  `pool_recycle=300` (drop connections older than 5 min, below typical
  cloud idle cutoffs), `connect_args={"connect_timeout": 15}` so a hung
  socket fails fast. Motivated by Neon/Supabase closing idle SSL
  connections (§6.5).
- **SQLite:** `connect_args={"check_same_thread": False, "timeout": 30}`
  for local dev.
- `init_db()` (`services/db.py:36-39`) calls `Base.metadata.create_all()`,
  which creates missing tables but **does not migrate** existing ones
  (§6.6).

**Why both:** zero-config local development while production uses a managed
Postgres.

**Tradeoffs:**
- `create_all()` is not a migration tool; schema changes need Alembic or a
  manual `ALTER TABLE`.
- `retry_on_errors()` only retries `DBAPIError`; other transient failures
  (e.g. Qdrant/HTTP) aren't covered.

### 7.9 Scaling considerations

| Bottleneck | Current | Production fix |
|-----------|---------|---------------|
| In-process ingestion | `BackgroundTasks` shares the API process; not durable | Move to RQ/Celery + dedicated worker(s) |
| SQLite writes | Single-file, ~30s timeout | Postgres + connection pooling (already the prod path) |
| Qdrant collections | 1 per user (lightweight) | Shard across nodes when >50K collections |
| Embedding latency | Remote HF Inference API round-trip per batch (no local model) | Batch/cache embeddings, or a dedicated HF Inference Endpoint |
| LLM latency | Synchronous call blocks the request | Streaming responses; multiple API instances |
| No ingest retry | Failed ingest stays `failed` | Job-level `Retry(max=3, ...)` + reconciliation sweep |
| Status updates | Client polls `GET /documents` | SSE/WebSocket push |
| File storage | Supabase S3 | Same (already externalised) |
| Auth revocation | No blacklisting | Redis token blacklist with TTL |

### 7.10 Security considerations

| Aspect | Current state | Production hardening |
|--------|--------------|---------------------|
| Password hashing | bcrypt (cost 10 default) | Increase to cost 12+ |
| JWT secret | In `.env` file | Use KMS/secrets manager |
| Refresh tokens | Stateless, no revocation | Store in DB, rotate on use |
| Rate limiting | None | slowapi or API gateway |
| File upload | .pdf check + `MAX_UPLOAD_MB` limit | Magic-byte validation, virus scan |
| CORS | Two explicit origins (`localhost:3000`, Vercel) | Keep in sync with deployed frontend |
| SQL injection | Safe (SQLAlchemy ORM + parameterized) | Same |
| Path traversal | `os.path.basename()` strips dirs | Same |
| Secrets in `.env` | Gitignored (`.env.*`, `.env`) | Rotate regularly |
| HF token | In `.env` / host env | Rotate; scope to inference only |

---

## 8. Troubleshooting cheat sheet

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `GET /documents` stuck at `processing` | Background task crashed, or process restarted mid-ingest | Check server log; re-upload the PDF (no automatic retry) |
| Ingest marks doc `failed` with `S3`/`download` error | Object missing from the `athenaeum` bucket | Confirm the key in `documents.content` exists in Supabase Storage |
| Ingest fails with 401/403 from `huggingface.co` | Missing or invalid `HF_TOKEN` | Set `HF_TOKEN` in `.env` (token from huggingface.co/settings/tokens) |
| Ingest fails with 429/timeout from the HF Inference API | Free-tier rate limit or provider cold start | Add retry/backoff in `vectorstore.py`, lower batch size, or use a dedicated HF Inference Endpoint |
| Ingest is slow / times out (even for small PDFs) | Remote HF Inference API round-trips, provider cold start, or rate limiting | Add retry/backoff + lower batch size in `vectorstore.py`; consider a dedicated HF Inference Endpoint (§7.5) |
| `GET /chat` returns "No documents have been indexed yet" | Qdrant filter returned 0 points — wrong field path, or docs not ready | Check `metadata.doc_id` not `doc_id`; ensure docs are `ready` (§6.4) |
| `DELETE /documents/{id}` returns 204 but points remain | Wrong filter path in delete | Confirm `metadata.doc_id` (`services/vectorstore.py:102-108`) |
| Second upload of the same PDF fails with `Index required but not found for metadata.doc_id` | Qdrant payload index missing for nested filter field | `_ensure_payload_indexes()` creates keyword indexes on `metadata.doc_id`/`metadata.user_id` at collection creation + before delete (§6.4) |
| `SSL connection has been closed unexpectedly` / `OperationalError` | Cloud Postgres (Neon/Supabase) closed an idle pooled connection | `pool_pre_ping`/`pool_recycle` handle it; `retry_on_errors` retries the ingest (§6.5) |
| Upload returns 422 "Only PDF files are allowed" | File extension missing or non-.pdf | Rename file with `.pdf` extension |
| Upload returns 413 | File exceeds `MAX_UPLOAD_MB` | Raise the limit or split the PDF |
| `401 Unauthorized` on all protected endpoints | JWT expired or wrong token | Re-login, send fresh access token (frontend auto-refreshes once) |
| Quiz returns raw text instead of JSON | LLM ignored `response_format: json_object` | Regex fallback extracts JSON; retry may work |
| `database is locked` error | SQLite contention (local dev only) | Already mitigated with `timeout=30`; use Postgres for persistent issues |
| LLM call fails / 401 from Groq | Wrong/missing `GROQ_API_KEY` or `BASE_URL_GROQ` | Verify Groq env vars (legacy Gemini vars are unused) |
