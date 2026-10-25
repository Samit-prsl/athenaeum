import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config import settings
from services.embeddings import get_embeddings


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def main() -> None:
    embeddings = get_embeddings()
    query = embeddings.embed_query("How do plants make energy?")
    documents = embeddings.embed_documents(
        [
            "Chloroplasts perform photosynthesis and convert light into chemical energy.",
            "The stock market rallied on strong earnings reports.",
        ]
    )

    assert len(query) == settings.EMBEDDING_DIM, len(query)
    assert all(len(doc) == settings.EMBEDDING_DIM for doc in documents)

    relevant = _cosine(query, documents[0])
    irrelevant = _cosine(query, documents[1])
    assert relevant > irrelevant, (relevant, irrelevant)

    print(
        f"model={settings.EMBEDDING_MODEL} dim={len(query)} "
        f"relevant={relevant:.4f} irrelevant={irrelevant:.4f}"
    )


if __name__ == "__main__":
    main()
