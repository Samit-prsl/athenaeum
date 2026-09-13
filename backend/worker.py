import queues.rag_jobs  # noqa: F401  (register job functions for RQ)
from redis import Redis
from rq import Queue

from config import settings

QUEUES = ["default"]


def _connection() -> Redis:
    if settings.REDIS_URL:
        return Redis.from_url(settings.REDIS_URL)
    return Redis(
        host=settings.REDIS_HOST,
        port=settings.REDIS_PORT,
    )


def main() -> None:
    queues = [Queue(name, connection=_connection()) for name in QUEUES]
    if settings.RQ_WORKER_MODE == "fork":
        from rq.worker import Worker

        worker = Worker(queues, connection=queues[0].connection)
    else:
        from rq.worker import SpawnWorker

        worker = SpawnWorker(queues, connection=queues[0].connection)
    worker.work()


if __name__ == "__main__":
    main()