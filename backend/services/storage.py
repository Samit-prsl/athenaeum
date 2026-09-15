import logging

import boto3

from config import settings

log = logging.getLogger("athenaeum.storage")

_client = None


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


def upload_object(key: str, body: bytes) -> None:
    _get_client().put_object(
        Bucket=settings.SUPABASE_S3_BUCKET,
        Key=key,
        Body=body,
        ContentType="application/pdf",
    )


def download_object(key: str) -> bytes:
    response = _get_client().get_object(Bucket=settings.SUPABASE_S3_BUCKET, Key=key)
    return response["Body"].read()


def delete_object(key: str) -> None:
    _get_client().delete_object(Bucket=settings.SUPABASE_S3_BUCKET, Key=key)