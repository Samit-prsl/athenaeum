import logging
from typing import BinaryIO

import boto3
from boto3.s3.transfer import TransferConfig

from config import settings

log = logging.getLogger("athenaeum.storage")

_client = None

# Keep transfer buffering bounded on memory-constrained hosts.
_TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=8 * 1024 * 1024,
    multipart_chunksize=8 * 1024 * 1024,
    max_concurrency=1,
    io_chunksize=256 * 1024,
)


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=settings.SUPABASE_S3_ENDPOINT,
            region_name=settings.SUPABASE_S3_REGION,
            aws_access_key_id=settings.SUPABASE_S3_ACCESS_KEY,
            aws_secret_access_key=settings.SUPABASE_S3_SECRET_KEY,
        )
    return _client


def build_key(user_id: str, doc_id: str) -> str:
    return f"{user_id}/{doc_id}.pdf"


def upload_fileobj(key: str, fileobj: BinaryIO) -> None:
    _get_client().upload_fileobj(
        Fileobj=fileobj,
        Bucket=settings.SUPABASE_S3_BUCKET,
        Key=key,
        ExtraArgs={"ContentType": "application/pdf"},
        Config=_TRANSFER_CONFIG,
    )


def download_to_path(key: str, path: str) -> None:
    _get_client().download_file(
        Bucket=settings.SUPABASE_S3_BUCKET,
        Key=key,
        Filename=path,
        Config=_TRANSFER_CONFIG,
    )


def delete_object(key: str) -> None:
    _get_client().delete_object(Bucket=settings.SUPABASE_S3_BUCKET, Key=key)