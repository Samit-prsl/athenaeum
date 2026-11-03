import os
from typing import Iterator

from langchain_core.documents import Document
from pypdf import PdfReader


def iter_pdf_pages(reader: PdfReader, name: str | None = None) -> Iterator[Document]:
    """Yield one Document per non-empty page without materialising the whole PDF."""
    total_pages = len(reader.pages)
    source = name or getattr(reader, "name", None) or "document.pdf"

    for index, page in enumerate(reader.pages):
        text = (page.extract_text() or "").strip()
        if not text:
            continue

        label = (
            str(page.page_number) if getattr(page, "page_number", None) is not None else str(index + 1)
        )
        yield Document(
            page_content=text,
            metadata={
                "source": os.path.basename(source),
                "page": index + 1,
                "page_label": label,
                "total_pages": total_pages,
            },
        )
