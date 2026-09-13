import os

from langchain_core.documents import Document
from pypdf import PdfReader


def load_pdf_pages(
    source: "str | bytes | os.PathLike | BinaryIO",
    name: str | None = None,
) -> tuple[list[Document], int]:
    reader = PdfReader(source)
    total_pages = len(reader.pages)
    documents: list[Document] = []

    for index, page in enumerate(reader.pages):
        text = (page.extract_text() or "").strip()
        if not text:
            continue

        label = (
            str(page.page_number) if getattr(page, "page_number", None) is not None else str(index + 1)
        )
        documents.append(
            Document(
                page_content=text,
                metadata={
                    "source": name or os.path.basename(str(source)),
                    "page": index + 1,
                    "page_label": label,
                    "total_pages": total_pages,
                },
            )
        )

    return documents, total_pages