import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


class Settings:
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    BASE_URL: str = os.getenv("BASE_URL", "")
    MODEL_NAME: str = os.getenv("MODEL_NAME", "gemini-3.6-flash")

    JWT_SECRET: str = os.getenv("JWT_SECRET", "change-me")
    ALGORITHM: str = os.getenv("JWT_ALGORITHM", "HS256")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "30"))
    REFRESH_TOKEN_EXPIRE_DAYS: int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

    QDRANT_URL: str = os.getenv("QDRANT_URL", "http://localhost:6333")
    QDRANT_API_KEY: str = os.getenv("QDRANT_API_KEY", "")
    EMBEDDING_MODEL: str = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    EMBEDDING_DIM: int = int(os.getenv("EMBEDDING_DIM", "384"))

    REDIS_URL: str = os.getenv("REDIS_URL", "")
    REDIS_HOST: str = os.getenv("REDIS_HOST", "localhost")
    REDIS_PORT: int = int(os.getenv("REDIS_PORT", "6379"))

    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "uploads")
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./athenaeum.db")
    MAX_UPLOAD_MB: int = int(os.getenv("MAX_UPLOAD_MB", "10"))

    JOB_TIMEOUT: int = int(os.getenv("JOB_TIMEOUT", "900"))
    JOB_RESULT_TTL: int = int(os.getenv("JOB_RESULT_TTL", "86400"))
    RQ_WORKER_MODE: str = os.getenv("RQ_WORKER_MODE", "spawn")


settings = Settings()