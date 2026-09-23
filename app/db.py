"""Postgres（Neon）へのアクセスをまとめたモジュール。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg.types.numeric import FloatLoader
from psycopg_pool import ConnectionPool

from app import config

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "db" / "schema.sql"

# numeric 列を Decimal ではなく float で受け取る（JSON化・計算をそのまま行えるように）
psycopg.adapters.register_loader("numeric", FloatLoader)

CONNECT_KWARGS = {"autocommit": True, "row_factory": dict_row}


@lru_cache(maxsize=1)
def get_pool() -> ConnectionPool:
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL が設定されていません")
    # Neon は使われていないと計算資源を止めて接続を切るので、
    # min_size=0 で接続を持ち続けず、取り出すたびに生存確認する
    return ConnectionPool(
        config.DATABASE_URL,
        min_size=0,
        max_size=4,
        max_idle=60,
        kwargs=CONNECT_KWARGS,
        check=ConnectionPool.check_connection,
        open=True,
    )


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, **CONNECT_KWARGS)


def init_schema(conn: psycopg.Connection) -> None:
    """db/schema.sql を適用する（何度実行しても安全）。"""
    conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))


def _adapt(value):
    return Jsonb(value) if isinstance(value, (dict, list)) else value


def upsert(conn: psycopg.Connection, table: str, rows: list[dict], conflict: tuple[str, ...]) -> int:
    """INSERT ... ON CONFLICT (conflict) DO UPDATE で行を書き込む。"""
    if not rows:
        return 0
    cols = list(rows[0].keys())
    updates = [c for c in cols if c not in conflict]
    query = sql.SQL("insert into {table} ({cols}) values ({vals}) "
                    "on conflict ({conflict}) do update set {updates}").format(
        table=sql.Identifier(table),
        cols=sql.SQL(", ").join(map(sql.Identifier, cols)),
        vals=sql.SQL(", ").join(sql.Placeholder() * len(cols)),
        conflict=sql.SQL(", ").join(map(sql.Identifier, conflict)),
        updates=sql.SQL(", ").join(
            sql.SQL("{c} = excluded.{c}").format(c=sql.Identifier(c)) for c in updates),
    )
    with conn.cursor() as cur:
        cur.executemany(query, [[_adapt(r[c]) for c in cols] for r in rows])
    return len(rows)
