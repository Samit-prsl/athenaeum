import json
import logging
import re
from typing import Optional

from dotenv import load_dotenv
from openai import OpenAI

from config import settings
from services.retry import retry_on_errors
from services.vectorstore import search
from system_prompt import QUIZ_SYSTEM_PROMPT, RAG_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT

load_dotenv()

log = logging.getLogger("athenaeum.rag")

_llm: Optional[OpenAI] = None


def _get_llm() -> OpenAI:
    global _llm
    if _llm is None:
        _llm = OpenAI(
            api_key=settings.GROQ_API_KEY,
            base_url=settings.BASE_URL_GROQ
        )
    return _llm


def _retrieve_context(query: str, user_id: str, document_ids: Optional[list[str]], k: int) -> str:
    results = search(
        user_id=user_id,
        query=query,
        k=k,
        document_ids=document_ids,
    )
    return ("\n\n\n").join(
        [
            f"Page Content : {result.page_content}, Page Number : {result.metadata['page_label']}, File location : {result.metadata['source']}"
            for result in results
        ]
    )


def _complete(system_prompt: str, user_message: str, json_mode: bool = False) -> str:
    kwargs: dict = {
        "model": settings.MODEL_NAME_GROQ,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    response = _get_llm().chat.completions.create(**kwargs)
    return response.choices[0].message.content


@retry_on_errors()
def ingest_document(user_id: str, document_id: str) -> dict:
    import io

    from models import Document as DocumentRow
    from services.db import SessionLocal
    from services.pdf import load_pdf_pages
    from services.vectorstore import add_documents, delete_documents

    db = SessionLocal()
    row = None
    try:
        row = db.get(DocumentRow, document_id)
        if row is None:
            raise ValueError(f"Document {document_id} does not exist")

        if not row.content:
            raise ValueError(f"Document {document_id} has no stored content")

        stream = io.BytesIO(row.content)
        pages, total_pages = load_pdf_pages(stream, name=row.filename)
        for page_doc in pages:
            page_doc.metadata["user_id"] = user_id
            page_doc.metadata["doc_id"] = document_id
            page_doc.metadata["source"] = row.filename

        delete_documents(user_id, document_id)
        add_documents(user_id, pages)

        row.total_pages = total_pages
        row.status = "ready"
        row.error = None
        db.commit()

        return {
            "document_id": document_id,
            "total_pages": total_pages,
            "chunks_indexed": len(pages),
        }
    except Exception as exc:
        if row is not None:
            try:
                row.status = "failed"
                row.error = str(exc)
                db.commit()
            except Exception:
                log.exception("Failed to persist 'failed' status for document %s", document_id)
        raise
    finally:
        db.close()


def answer_question(user_id: str, question: str, document_ids: Optional[list[str]] = None) -> str:
    context = _retrieve_context(question, user_id, document_ids, k=4)
    if not context:
        return "No documents have been indexed yet. Upload a PDF first."
    system_prompt = RAG_SYSTEM_PROMPT(context, question)
    return _complete(system_prompt, question)


def generate_quiz(
    user_id: str,
    topic: str,
    num_questions: int = 5,
    document_ids: Optional[list[str]] = None,
) -> dict:
    context = _retrieve_context(topic, user_id, document_ids, k=max(6, num_questions * 2))
    if not context:
        return {
            "title": "No Content",
            "questions": [],
            "message": "No documents have been indexed yet. Upload a PDF first.",
        }
    system_prompt = QUIZ_SYSTEM_PROMPT(context, topic, num_questions)
    content = _complete(system_prompt, f"Generate a {num_questions}-question quiz about '{topic}'.", json_mode=True)

    try:
        return json.loads(content)
    except (json.JSONDecodeError, TypeError):
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except (json.JSONDecodeError, TypeError):
                raise ValueError(f"Model returned invalid JSON for quiz: {content}")
        raise ValueError(f"Model returned invalid JSON for quiz: {content}")


def generate_summary(
    user_id: str,
    topic: str,
    document_ids: Optional[list[str]] = None,
) -> str:
    context = _retrieve_context(topic, user_id, document_ids, k=8)
    if not context:
        return "No documents have been indexed yet. Upload a PDF first."
    system_prompt = SUMMARY_SYSTEM_PROMPT(context, topic)
    return _complete(system_prompt, f"Summarize the context about '{topic}'.")