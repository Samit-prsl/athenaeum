import queues.rag_jobs  # noqa: F401  (register job functions for RQ)
from redis import Redis
from rq import Queue

from config import settings
from services.vectorstore import get_embeddings

QUEUES = ["default"]


def _connection() -> Redis:
    if settings.REDIS_URL:
        return Redis.from_url(settings.REDIS_URL)
    return Redis(
        host=settings.REDIS_HOST,
        port=settings.REDIS_PORT,
    )


def _preload_embeddings() -> None:
    try:
        get_embeddings()
    except Exception as exc:  # pragma: no cover - worker startup
        print(f"Warning: failed to preload embeddings: {exc}", flush=True)


def main() -> None:
    queues = [Queue(name, connection=_connection()) for name in QUEUES]

    if settings.RQ_WORKER_MODE == "simple":
        # Single in-process worker: the module-level embedding model and Qdrant
        # client caches persist across all jobs, so they are loaded once instead
        # of once per job (spawn) or inherited unsafely (fork + torch segfaults).
        from rq.worker import SimpleWorker

        _preload_embeddings()
        worker = SimpleWorker(queues, connection=queues[0].connection)
    elif settings.RQ_WORKER_MODE == "spawn":
        from rq.worker import SpawnWorker

        worker = SpawnWorker(queues, connection=queues[0].connection)
    else:
        from rq.worker import Worker

        worker = Worker(queues, connection=queues[0].connection)

    worker.work()


if __name__ == "__main__":
    main()