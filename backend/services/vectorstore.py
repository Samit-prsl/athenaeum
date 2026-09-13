from typing import Optional

from langchain_core.documents import Document
from langchain_huggingface import HuggingFaceEmbeddings
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    FilterSelector,
    MatchAny,
    MatchValue,
    VectorParams,
)

from config import settings

_embeddings: Optional[HuggingFaceEmbeddings] = None


def get_embeddings() -> HuggingFaceEmbeddings:
    global _embeddings
    if _embeddings is None:
        _embeddings = HuggingFaceEmbeddings(model_name=settings.EMBEDDING_MODEL)
    return _embeddings


def collection_name(user_id: str) -> str:
    return f"rag_{user_id}"


def _client() -> QdrantClient:
    kwargs: dict = {"url": settings.QDRANT_URL}
    if settings.QDRANT_API_KEY:
        kwargs["api_key"] = settings.QDRANT_API_KEY
    return QdrantClient(**kwargs)


def ensure_collection(user_id: str) -> str:
    client = _client()
    name = collection_name(user_id)
    if not client.collection_exists(name):
        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(
                size=settings.EMBEDDING_DIM,
                distance=Distance.COSINE,
            ),
        )
    return name


def add_documents(user_id: str, documents: list[Document]) -> None:
    ensure_collection(user_id)
    from langchain_qdrant import QdrantVectorStore

    store = QdrantVectorStore(
        client=_client(),
        collection_name=collection_name(user_id),
        embedding=get_embeddings(),
    )
    store.add_documents(documents)


def delete_documents(user_id: str, document_id: str = None) -> None:
    client = _client()
    name = collection_name(user_id)
    if not client.collection_exists(name):
        return

    if document_id is None:
        client.drop_collection(collection_name=name)
        return

    filter_ = Filter(
        must=[FieldCondition(key="metadata.doc_id", match=MatchValue(value=document_id))]
    )
    client.delete(
        collection_name=name,
        points_selector=FilterSelector(filter=filter_),
    )


def search(
    user_id: str,
    query: str,
    k: int = 4,
    document_ids: Optional[list[str]] = None,
) -> list[Document]:
    client = _client()
    name = collection_name(user_id)
    if not client.collection_exists(name):
        return []

    query_vector = get_embeddings().embed_query(query)

    filter_ = None
    if document_ids:
        filter_ = Filter(
            must=[
                FieldCondition(
                    key="metadata.doc_id",
                    match=MatchAny(any=list(document_ids)),
                )
            ]
        )

    points = client.query_points(
        collection_name=name,
        query=query_vector,
        limit=k,
        query_filter=filter_,
        with_payload=True,
    ).points

    results: list[Document] = []
    for point in points:
        payload = point.payload or {}
        page_content = payload.get("page_content") or ""
        metadata = payload.get("metadata") or {}
        results.append(Document(page_content=page_content, metadata=dict(metadata)))
    return results