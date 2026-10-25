from threading import Lock
from typing import Iterable

from fastembed import TextEmbedding
from langchain_core.embeddings import Embeddings

from config import settings


class FastEmbeddings(Embeddings):
    def __init__(self, model_name: str, batch_size: int = 32) -> None:
        self._batch_size = batch_size
        self._lock = Lock()
        self._model = TextEmbedding(
            model_name=model_name,
            threads=1,
            enable_cpu_mem_arena=False,
        )

    def _embed(self, texts: list[str], batch_size: int) -> list[list[float]]:
        with self._lock:
            vectors: Iterable = self._model.embed(texts, batch_size=batch_size)
            return [vector.tolist() for vector in vectors]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._embed(list(texts), self._batch_size)

    def embed_query(self, text: str) -> list[float]:
        return self._embed([text], batch_size=1)[0]


_embeddings: FastEmbeddings | None = None
_embeddings_lock = Lock()


def get_embeddings() -> FastEmbeddings:
    global _embeddings
    if _embeddings is None:
        with _embeddings_lock:
            if _embeddings is None:
                _embeddings = FastEmbeddings(settings.EMBEDDING_MODEL)
    return _embeddings


def warmup_embeddings() -> None:
    get_embeddings().embed_query("warmup")
