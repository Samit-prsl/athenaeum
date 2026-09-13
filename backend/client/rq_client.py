from redis import Redis
from rq import Queue

from config import settings


def _connection() -> Redis:
    if settings.REDIS_URL:
        return Redis.from_url(settings.REDIS_URL)
    return Redis(host=settings.REDIS_HOST, port=settings.REDIS_PORT)


def enqueue_job(function, *args, **kwargs):
    return Queue(connection=_connection()).enqueue(
        function,
        *args,
        job_timeout=settings.JOB_TIMEOUT,
        result_ttl=settings.JOB_RESULT_TTL,
        **kwargs,
    )


def fetch_job(job_id: str):
    return Queue(connection=_connection()).fetch_job(job_id)