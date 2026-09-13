"""Retry helper for transient infrastructure failures (DB / network).

Wrapped job functions become self-healing: a dropped/stale Postgres
connection (e.g. Neon killing idle SSL connections) or a transient
Qdrant/network error is retried with exponential backoff instead of
failing the RQ job and leaving documents stuck at "processing".
"""

import functools
import logging
import time
from typing import Callable, Type, TypeVar

from sqlalchemy.exc import DBAPIError

log = logging.getLogger("athenaeum.retry")

T = TypeVar("T")


def retry_on_errors(
    attempts: int = 3,
    delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: tuple[type[Exception], ...] = (DBAPIError,),
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        def wrapper(*args, **kwargs) -> T:
            last: Exception | None = None
            for i in range(attempts):
                try:
                    return func(*args, **kwargs)
                except exceptions as exc:
                    last = exc
                    if i < attempts - 1:
                        wait = delay * (backoff**i)
                        log.warning(
                            "Transient error in %s (attempt %d/%d), retrying in %.1fs: %s",
                            func.__name__,
                            i + 1,
                            attempts,
                            wait,
                            exc,
                        )
                        time.sleep(wait)
            assert last is not None
            raise last

        return wrapper

    return decorator