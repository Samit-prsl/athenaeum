import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import (
    Depends,
    FastAPI,
    File,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from client.rq_client import enqueue_job, fetch_job
from config import settings
from models import User
from queues.rag_jobs import answer_question, generate_quiz, generate_summary, ingest_document
from schemas import (
    AccessToken,
    ChatRequest,
    DocumentOut,
    JobOut,
    JobResultOut,
    QuizRequest,
    RefreshRequest,
    SummaryRequest,
    TokenPair,
    UploadItemOut,
    UploadsOut,
    UserOut,
    RegisterRequest,
)
from services.db import get_db, init_db
from services.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from services.vectorstore import delete_documents


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Athenaeum", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")


# --------------------------------------------------------------------------- #
# Auth helpers
# --------------------------------------------------------------------------- #
def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    try:
        payload = decode_token(token, "access")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = db.get(User, payload.get("sub"))
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer exists",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def _issue_tokens(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@app.get("/", status_code=status.HTTP_200_OK)
def health_check():
    return {"message": "success", "data": "server up and running!"}


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
@app.post("/auth/register", status_code=status.HTTP_201_CREATED, response_model=TokenPair)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    user = User(
        email=payload.email,
        password_hash=hash_password(payload.password),
        name=payload.name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _issue_tokens(user)


@app.post("/auth/login", response_model=TokenPair)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == form.username).first()
    if user is None or not verify_password(form.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _issue_tokens(user)


@app.post("/auth/refresh", response_model=AccessToken)
def refresh(payload: RefreshRequest):
    try:
        data = decode_token(payload.refresh_token, "refresh")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return AccessToken(access_token=create_access_token(data["sub"]))


@app.get("/auth/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return current_user


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
@app.post("/documents", status_code=status.HTTP_202_ACCEPTED, response_model=UploadsOut)
def upload_documents(
    files: list[UploadFile] = File(..., description="One or more PDF files"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadsOut:
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    items: list[UploadItemOut] = []

    for file in files:
        original = os.path.basename(file.filename or "")
        if not original.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Only PDF files are allowed, got '{original}'",
            )

        size = 0
        chunks: list[bytes] = []
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"File '{original}' exceeds {settings.MAX_UPLOAD_MB} MB",
                )
            chunks.append(chunk)

        from models import Document as DocumentRow

        row = DocumentRow(
            user_id=current_user.id,
            filename=original,
            content=b"".join(chunks),
            status="processing",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        try:
            job = enqueue_job(ingest_document, current_user.id, row.id)
        except Exception as exc:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to enqueue ingestion for '{original}': {exc}",
            ) from exc

        items.append(
            UploadItemOut(filename=original, document_id=row.id, job_id=job.id)
        )

    return UploadsOut(uploads=items)


@app.get("/documents", response_model=list[DocumentOut])
def list_documents(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from models import Document as DocumentRow

    return (
        db.query(DocumentRow)
        .filter(DocumentRow.user_id == current_user.id)
        .order_by(DocumentRow.created_at.desc())
        .all()
    )


@app.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_document(
    document_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from models import Document as DocumentRow

    row = (
        db.query(DocumentRow)
        .filter(DocumentRow.id == document_id, DocumentRow.user_id == current_user.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    delete_documents(current_user.id, document_id)

    db.delete(row)
    db.commit()


# --------------------------------------------------------------------------- #
# Query / jobs
# --------------------------------------------------------------------------- #
@app.post("/chat", status_code=status.HTTP_202_ACCEPTED, response_model=JobOut)
def chat(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
):
    job = enqueue_job(
        answer_question,
        current_user.id,
        payload.question,
        payload.document_ids,
    )
    return JobOut(job_id=job.id)


@app.post("/quiz", status_code=status.HTTP_202_ACCEPTED, response_model=JobOut)
def quiz(
    payload: QuizRequest,
    current_user: User = Depends(get_current_user),
):
    job = enqueue_job(
        generate_quiz,
        current_user.id,
        payload.topic,
        payload.num_questions,
        payload.document_ids,
    )
    return JobOut(job_id=job.id)


@app.post("/summary", status_code=status.HTTP_202_ACCEPTED, response_model=JobOut)
def summary(
    payload: SummaryRequest,
    current_user: User = Depends(get_current_user),
):
    job = enqueue_job(
        generate_summary,
        current_user.id,
        payload.topic,
        payload.document_ids,
    )
    return JobOut(job_id=job.id)


@app.get("/jobs/{job_id}", response_model=JobResultOut)
def get_job(job_id: str):
    job = fetch_job(job_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    return JobResultOut(
        job_id=job_id,
        status=job.get_status(),
        result=job.result,
        error=job.exc_info if job.is_failed else None,
    )