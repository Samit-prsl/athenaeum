FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    FASTEMBED_CACHE_PATH=/app/.fastembed-cache \
    OMP_NUM_THREADS=1 \
    ORT_NUM_THREADS=1 \
    MALLOC_ARENA_MAX=2

WORKDIR /app

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . .

RUN python scripts/download_embedding_model.py

CMD ["python", "main.py"]