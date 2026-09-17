import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from config import settings
from models import User
from schemas import (
    AccessToken,
    ChatOut,
    ChatRequest,
    DocumentOut,
    QuizRequest,
    RefreshRequest,
    SummaryOut,
    SummaryRequest,
    TokenPair,
    UploadItemOut,
    UploadsOut,
    UserOut,
    RegisterRequest,
    VivaSessionDetailOut,
    VivaSessionOut,
    VivaStartOut,
    VivaStartRequest,
    VivaTurnResult,
)
from services.db import get_db, init_db
from services.rag import answer_question, generate_quiz, generate_summary, ingest_document
from services.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from services.storage import build_key, delete_object, upload_object
from services.vectorstore import delete_documents


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Athenaeum", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", 'https://athenaeum-study.vercel.app'],
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
    background_tasks: BackgroundTasks,
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

        data = b"".join(chunks)
        row = DocumentRow(
            user_id=current_user.id,
            filename=original,
            status="processing",
        )
        db.add(row)
        db.flush()

        key = build_key(current_user.id, row.id)
        try:
            upload_object(key, data)
        except Exception:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to store file '{original}' in object storage",
            )
        row.content = key.encode()

        db.commit()
        db.refresh(row)
        background_tasks.add_task(ingest_document, current_user.id, row.id)

        items.append(UploadItemOut(filename=original, document_id=row.id))

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

    if row.content:
        try:
            delete_object(row.content.decode())
        except UnicodeDecodeError:
            pass

    delete_documents(current_user.id, document_id)

    db.delete(row)
    db.commit()


# --------------------------------------------------------------------------- #
# Query
# --------------------------------------------------------------------------- #
@app.post("/chat", response_model=ChatOut)
def chat(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
) -> ChatOut:
    answer = answer_question(
        current_user.id,
        payload.question,
        payload.document_ids,
    )
    return ChatOut(answer=answer)


@app.post("/quiz")
def quiz(
    payload: QuizRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    return generate_quiz(
        current_user.id,
        payload.topic,
        payload.num_questions,
        payload.document_ids,
    )


@app.post("/summary", response_model=SummaryOut)
def summary(
    payload: SummaryRequest,
    current_user: User = Depends(get_current_user),
) -> SummaryOut:
    result = generate_summary(
        current_user.id,
        payload.topic,
        payload.document_ids,
    )
    return SummaryOut(summary=result)


# --------------------------------------------------------------------------- #
# Viva (voice oral exam)
# --------------------------------------------------------------------------- #
@app.post("/viva/start", response_model=VivaStartOut)
def start_viva(
    payload: VivaStartRequest,
    current_user: User = Depends(get_current_user),
) -> VivaStartOut:
    from services.viva import start_viva as run_viva

    try:
        return run_viva(
            current_user.id,
            payload.topic,
            payload.num_questions,
            payload.difficulty,
            payload.document_ids,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


@app.post("/viva/turn", response_model=VivaTurnResult)
def submit_viva_turn(
    session_id: str = Form(...),
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
) -> VivaTurnResult:
    from services.viva import run_turn

    try:
        return run_turn(
            current_user.id,
            session_id,
            audio.file.read(),
            audio.content_type or "audio/webm",
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc


@app.get("/viva/sessions", response_model=list[VivaSessionOut])
def list_viva_sessions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from models import VivaSession as VivaSessionRow

    return (
        db.query(VivaSessionRow)
        .filter(VivaSessionRow.user_id == current_user.id)
        .order_by(VivaSessionRow.created_at.desc())
        .all()
    )


@app.get("/viva/sessions/{session_id}", response_model=VivaSessionDetailOut)
def get_viva_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    import json as json_module

    from models import VivaSession as VivaSessionRow
    from models import VivaTurn as VivaTurnRow

    session = (
        db.query(VivaSessionRow)
        .filter(
            VivaSessionRow.id == session_id,
            VivaSessionRow.user_id == current_user.id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Viva session not found"
        )

    def load_json(raw):
        try:
            return json_module.loads(raw)
        except (TypeError, json_module.JSONDecodeError):
            return None

    turns = (
        db.query(VivaTurnRow)
        .filter(VivaTurnRow.session_id == session_id)
        .order_by(VivaTurnRow.created_at.asc())
        .all()
    )
    return {
        "id": session.id,
        "topic": session.topic,
        "num_questions": session.num_questions,
        "difficulty": session.difficulty,
        "status": session.status,
        "score": session.score,
        "report": load_json(session.report),
        "created_at": session.created_at,
        "completed_at": session.completed_at,
        "turns": [
            {
                "question": turn.question,
                "page": turn.page,
                "answer_text": turn.answer_text,
                "evaluation": load_json(turn.evaluation),
                "created_at": turn.created_at,
            }
            for turn in turns
        ],
    }


@app.delete("/viva/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_viva_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from models import VivaSession as VivaSessionRow

    session = (
        db.query(VivaSessionRow)
        .filter(
            VivaSessionRow.id == session_id,
            VivaSessionRow.user_id == current_user.id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Viva session not found"
        )
    db.delete(session)
    db.commit()