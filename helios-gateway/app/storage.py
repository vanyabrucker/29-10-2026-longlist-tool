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
