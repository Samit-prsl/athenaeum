from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    name: str = Field(default="", max_length=255)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class AccessToken(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    name: str
    created_at: datetime


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    total_pages: int
    status: str
    error: Optional[str] = None
    created_at: datetime


class UploadItemOut(BaseModel):
    filename: str
    document_id: str


class UploadsOut(BaseModel):
    uploads: list[UploadItemOut]


class ChatRequest(BaseModel):
    question: str = Field(min_length=1)
    document_ids: Optional[list[str]] = None


class ChatOut(BaseModel):
    answer: str


class QuizRequest(BaseModel):
    topic: str = Field(min_length=1)
    num_questions: int = Field(default=5, ge=1, le=20)
    document_ids: Optional[list[str]] = None


class SummaryRequest(BaseModel):
    topic: str = Field(min_length=1)
    document_ids: Optional[list[str]] = None


class SummaryOut(BaseModel):
    summary: str


# --------------------------------------------------------------------------- #
# Viva (voice oral exam)
# --------------------------------------------------------------------------- #
class VivaStartRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=512)
    num_questions: int = Field(default=5, ge=1, le=20)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    document_ids: Optional[list[str]] = None


class VivaQuestionOut(BaseModel):
    question: str
    question_audio: str  # base64-encoded WAV bytes from TTS
    turn_index: int
    total_questions: int
    page: Optional[str] = None


class VivaStartOut(BaseModel):
    session_id: str
    question: VivaQuestionOut


class VivaEvaluation(BaseModel):
    score: int
    missed_points: list[str] = []
    feedback: str = ""


class VivaReportOut(BaseModel):
    overall_score: float
    strengths: list[str]
    weaknesses: list[str]
    recommended_revisions: list[str]
    summary: str


class VivaTurnResult(BaseModel):
    done: bool = False
    transcript: Optional[str] = None
    feedback: Optional[str] = None
    question: Optional[VivaQuestionOut] = None
    report: Optional[VivaReportOut] = None


class VivaSessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    topic: str
    num_questions: int
    difficulty: str
    status: str
    score: Optional[float] = None
    created_at: datetime
    completed_at: Optional[datetime] = None


class VivaTurnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    question: str
    page: str
    answer_text: str
    evaluation: Optional[VivaEvaluation] = None
    created_at: datetime


class VivaSessionDetailOut(BaseModel):
    id: str
    topic: str
    num_questions: int
    difficulty: str
    status: str
    score: Optional[float] = None
    report: Optional[VivaReportOut] = None
    created_at: datetime
    completed_at: Optional[datetime] = None
    turns: list[VivaTurnOut]