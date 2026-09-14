from datetime import datetime
from typing import Optional

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