"""Supabase へのアクセスをまとめたモジュール。"""

from __future__ import annotations

from functools import lru_cache
from typing import Callable

from supabase import Client, create_client

from app import config

# PostgREST はデフォルトで1リクエスト最大1000行しか返さないので、ページングして全件取る
PAGE_SIZE = 1000
# 大量データを一度に送るとリクエストが巨大になるので分割する
UPSERT_CHUNK = 500


@lru_cache(maxsize=1)
def get_client() -> Client:
    if not config.SUPABASE_URL or not config.SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_KEY が設定されていません")
    return create_client(config.SUPABASE_URL, config.SUPABASE_KEY)


def upsert(client: Client, table: str, rows: list[dict], on_conflict: str) -> int:
    for i in range(0, len(rows), UPSERT_CHUNK):
        client.table(table).upsert(rows[i:i + UPSERT_CHUNK], on_conflict=on_conflict).execute()
    return len(rows)


def fetch_all(build_query: Callable[[], object]) -> list[dict]:
    """
    build_query は毎回新しいクエリビルダーを返す関数
    （例: lambda: client.table("events").select("*").order("id")）。
    ページングの順序を安定させるため、呼び出し側で order を付けること。
    """
    rows: list[dict] = []
    start = 0
    while True:
        page = build_query().range(start, start + PAGE_SIZE - 1).execute().data or []
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        start += PAGE_SIZE
