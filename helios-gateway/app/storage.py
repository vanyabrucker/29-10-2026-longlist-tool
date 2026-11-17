"""Original source files in S3-compatible object storage."""

from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.config import settings


@lru_cache
def _client():
    s = settings()
    client = boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        region_name="us-east-1",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    try:
        client.head_bucket(Bucket=s.s3_bucket)
    except ClientError:
        client.create_bucket(Bucket=s.s3_bucket)
    return client


@lru_cache
def _probe_client(timeout: float):
    """A client that gives up quickly and never retries, for health checks."""
    s = settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint_url,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        region_name="us-east-1",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            connect_timeout=timeout,
            read_timeout=timeout,
            retries={"total_max_attempts": 1},
        ),
    )


def ping(timeout: float) -> None:
    """Raises unless storage answers within the timeout. A missing bucket is
    fine: the first upload creates it."""
    try:
        _probe_client(timeout).head_bucket(Bucket=settings().s3_bucket)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchBucket"):
            raise


def put(key: str, data: bytes, content_type: str | None) -> None:
    _client().put_object(
        Bucket=settings().s3_bucket,
        Key=key,
        Body=data,
        ContentType=content_type or "application/octet-stream",
    )


def get(key: str) -> bytes:
    obj = _client().get_object(Bucket=settings().s3_bucket, Key=key)
    return obj["Body"].read()
