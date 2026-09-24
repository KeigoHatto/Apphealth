"""
Render 上で動かすバックエンド API。

  POST /webhook/health-export   Health Auto Export からの自動送信（Bearerトークン認証）
  POST /api/import/zip          手動エクスポートZIPのアップロード取り込み
  GET/POST/PUT/DELETE /api/events  日々のイベント手入力
  GET  /api/metrics/...         日次データ
  GET  /api/workouts/...        ワークアウト
  GET  /api/analysis/...        分析結果
  GET  /                        ダッシュボード（static/）

/webhook と /healthz 以外は Basic 認証で保護する（BASIC_AUTH_* が設定されている場合）。
"""

from __future__ import annotations

import base64
import binascii
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from psycopg import sql
from pydantic import BaseModel, Field, field_validator

from app import analysis, config, db, importer

logger = logging.getLogger("apphealth")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # 起動時にテーブルを作成（既にあれば何もしない）。DBに繋がらなくてもアプリ自体は起動させる
    if config.DATABASE_URL:
        try:
            with db.get_pool().connection() as conn:
                db.init_schema(conn)
        except Exception:
            logger.exception("スキーマの適用に失敗しました")
    yield


app = FastAPI(title="Health × Events", lifespan=lifespan)

STATIC_DIR = Path(__file__).parent / "static"
PUBLIC_PATHS = ("/webhook/", "/healthz")
MAX_ZIP_BYTES = 200 * 1024 * 1024


# ---------------------------------------------------------------- 認証

@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if not config.BASIC_AUTH_PASSWORD or request.url.path.startswith(PUBLIC_PATHS):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    if header.lower().startswith("basic "):
        try:
            user, _, password = base64.b64decode(header[6:]).decode().partition(":")
        except (binascii.Error, UnicodeDecodeError):
            user, password = "", ""
        user_ok = secrets.compare_digest(user.encode(), config.BASIC_AUTH_USER.encode())
        pass_ok = secrets.compare_digest(password.encode(), config.BASIC_AUTH_PASSWORD.encode())
        if user_ok and pass_ok:
            return await call_next(request)
    return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="health"'})


def require_webhook_token(request: Request) -> None:
    if not config.WEBHOOK_TOKEN:
        raise HTTPException(503, "WEBHOOK_TOKEN が設定されていません")
    header = request.headers.get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else request.headers.get("x-api-key", "")
    if not secrets.compare_digest(token.encode(), config.WEBHOOK_TOKEN.encode()):
        raise HTTPException(401, "invalid token")


def get_db():
    with db.get_pool().connection() as conn:
        yield conn


# ---------------------------------------------------------------- 取り込み

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/webhook/health-export", dependencies=[Depends(require_webhook_token)])
async def webhook_health_export(request: Request, conn=Depends(get_db)):
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(400, "JSON を解釈できませんでした")
    counts = importer.import_payload(conn, payload)
    logger.info("webhook imported: %s", counts)
    return {"imported": counts}


@app.post("/api/import/zip")
async def import_zip(file: UploadFile = File(...), conn=Depends(get_db)):
    if file.size is not None and file.size > MAX_ZIP_BYTES:
        raise HTTPException(413, "ファイルが大きすぎます")
    try:
        counts = importer.import_zip(conn, file.file)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    return {"imported": counts}


# ---------------------------------------------------------------- イベント

class EventIn(BaseModel):
    date: date
    category: str = Field(min_length=1, max_length=50)
    note: str | None = Field(default=None, max_length=2000)
    intensity: int | None = Field(default=None, ge=1, le=5)

    @field_validator("category")
    @classmethod
    def normalize_category(cls, v: str) -> str:
        v = v.strip().lower()
        if not v:
            raise ValueError("category は必須です")
        return v


def _where(clauses: list[tuple[str, object]]) -> tuple[sql.Composable, list]:
    """[("date >= %s", value), ...] から値が None でない条件だけで WHERE 句を作る。"""
    active = [(c, v) for c, v in clauses if v is not None]
    if not active:
        return sql.SQL(""), []
    return sql.SQL(" where ") + sql.SQL(" and ").join(sql.SQL(c) for c, _ in active), [v for _, v in active]


@app.get("/api/events")
def list_events(start: date | None = None, end: date | None = None,
                category: str | None = None, conn=Depends(get_db)):
    where, params = _where([("date >= %s", start), ("date <= %s", end), ("category = %s", category)])
    query = sql.SQL("select id, date, category, note, intensity, created_at from events{} "
                    "order by date desc, id desc").format(where)
    return conn.execute(query, params).fetchall()


@app.post("/api/events", status_code=201)
def create_event(event: EventIn, conn=Depends(get_db)):
    return conn.execute(
        "insert into events (date, category, note, intensity) values (%s, %s, %s, %s) "
        "returning id, date, category, note, intensity, created_at",
        (event.date, event.category, event.note, event.intensity),
    ).fetchone()


@app.put("/api/events/{event_id}")
def update_event(event_id: int, event: EventIn, conn=Depends(get_db)):
    row = conn.execute(
        "update events set date = %s, category = %s, note = %s, intensity = %s where id = %s "
        "returning id, date, category, note, intensity, created_at",
        (event.date, event.category, event.note, event.intensity, event_id),
    ).fetchone()
    if not row:
        raise HTTPException(404, "event not found")
    return row


@app.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int, conn=Depends(get_db)):
    conn.execute("delete from events where id = %s", (event_id,))
    return Response(status_code=204)


@app.get("/api/events/categories")
def event_categories(conn=Depends(get_db)):
    return conn.execute(
        "select category, count(*) as n from events group by category order by n desc, category"
    ).fetchall()


# ---------------------------------------------------------------- メトリクス

@app.get("/api/metrics/catalog")
def metric_catalog(conn=Depends(get_db)):
    rows = conn.execute("select * from metric_catalog order by metric_name").fetchall()
    sleep = [{"metric_name": name, "units": units, "n_rows": None,
              "first_date": None, "last_date": None}
             for name, (_, units) in analysis.SLEEP_METRICS.items()]
    return sleep + rows


def load_series(conn, metric: str, start: date | None = None,
                end: date | None = None) -> dict[date, float]:
    """
    指標を1日1値の {date: 値} にする。
    統計型（心拍など）は avg_value、シンプル型は qty を使い、同じ日に複数 source があれば平均する。
    """
    if metric in analysis.SLEEP_METRICS:
        column, _ = analysis.SLEEP_METRICS[metric]
        where, params = _where([("date >= %s", start), ("date <= %s", end)])
        query = sql.SQL("select date, avg({col}) as value from sleep_sessions{where} "
                        "group by date having avg({col}) is not null order by date").format(
            col=sql.Identifier(column), where=where)
    else:
        where, params = _where([("metric_name = %s", metric), ("date >= %s", start), ("date <= %s", end)])
        query = sql.SQL("select date, avg(coalesce(avg_value, qty)) as value from health_metrics{where} "
                        "group by date having avg(coalesce(avg_value, qty)) is not null "
                        "order by date").format(where=where)
    return {r["date"]: r["value"] for r in conn.execute(query, params)}


def _series_json(series: dict[date, float]) -> list[dict]:
    return [{"date": d.isoformat(), "value": v} for d, v in series.items()]


@app.get("/api/metrics/daily")
def metric_daily(metric: str, start: date | None = None, end: date | None = None,
                 conn=Depends(get_db)):
    return {"metric": metric, "series": _series_json(load_series(conn, metric, start, end))}


@app.get("/api/sleep")
def sleep_sessions(start: date | None = None, end: date | None = None, conn=Depends(get_db)):
    where, params = _where([("date >= %s", start), ("date <= %s", end)])
    query = sql.SQL("select date, source, sleep_start, sleep_end, total_sleep_hr, deep_hr, rem_hr, "
                    "core_hr, awake_hr from sleep_sessions{} order by date, id").format(where)
    return conn.execute(query, params).fetchall()


# ---------------------------------------------------------------- ワークアウト

# ワークアウト1件1行。date は開始時刻を APP_TIMEZONE の日付にしたもの。
# 時間は開始〜終了から計算できればそれを使う（duration の単位がバージョンで揺れるため）。
WORKOUTS_SUBQUERY = """
    select id, (start_time at time zone %(tz)s)::date as date,
           to_char(start_time at time zone %(tz)s, 'HH24:MI') as start_local,
           name, start_time, end_time,
           coalesce(extract(epoch from (end_time - start_time)) / 60, duration_min) as duration_min,
           distance_qty, distance_units, active_energy_qty, active_energy_units,
           avg_speed, speed_units, is_indoor
    from workouts
    where start_time is not null
"""


def _named(clauses: list[tuple[str, str, object]]) -> tuple[sql.Composable, dict]:
    """[("date >= %(start)s", "start", value), ...] から名前付きパラメータの WHERE 句を作る。"""
    active = [(c, k, v) for c, k, v in clauses if v is not None]
    if not active:
        return sql.SQL(""), {}
    return (sql.SQL(" where ") + sql.SQL(" and ").join(sql.SQL(c) for c, _, _ in active),
            {k: v for _, k, v in active})


@app.get("/api/workouts")
def list_workouts(start: date | None = None, end: date | None = None,
                  name: str | None = None, conn=Depends(get_db)):
    where, params = _named([("date >= %(start)s", "start", start), ("date <= %(end)s", "end", end),
                            ("name = %(name)s", "name", name)])
    query = sql.SQL("select * from (" + WORKOUTS_SUBQUERY + ") w{} order by start_time desc").format(where)
    return conn.execute(query, {"tz": config.APP_TIMEZONE, **params}).fetchall()


@app.get("/api/workouts/types")
def workout_types(conn=Depends(get_db)):
    query = ("select coalesce(name, 'Other') as name, count(*) as n, sum(duration_min) as total_min, "
             "max(date) as last_date from (" + WORKOUTS_SUBQUERY + ") w group by 1 order by n desc, name")
    return conn.execute(query, {"tz": config.APP_TIMEZONE}).fetchall()


def workout_minutes_by_date(conn, name: str | None = None) -> dict[date, float]:
    where, params = _named([("name = %(name)s", "name", name)])
    query = sql.SQL("select date, sum(duration_min) as minutes from (" + WORKOUTS_SUBQUERY + ") w{} "
                    "group by date").format(where)
    rows = conn.execute(query, {"tz": config.APP_TIMEZONE, **params})
    return {r["date"]: r["minutes"] or 0.0 for r in rows}


# ---------------------------------------------------------------- 分析

# 手入力イベントとワークアウトを「日付 + カテゴリ」の出来事として同じ形で扱う。
# ワークアウトのカテゴリは 'workout:<種類>'（例: workout:Outdoor Run）
OCCURRENCES_SUBQUERY = """
    select date, category, intensity, note, 'event' as kind from events
    union all
    select date, %(prefix)s || coalesce(name, 'Other'), null,
           round(duration_min)::int || '分', 'workout'
    from (""" + WORKOUTS_SUBQUERY + """) w
"""

Kind = Literal["event", "workout", "all"]


def load_occurrences(conn, category: str | None = None, kind: Kind = "all",
                     start: date | None = None, end: date | None = None) -> list[dict]:
    where, params = _named([
        ("category = %(category)s", "category", category),
        ("kind = %(kind)s", "kind", None if kind == "all" else kind),
        ("date >= %(start)s", "start", start),
        ("date <= %(end)s", "end", end),
    ])
    query = sql.SQL("select * from (" + OCCURRENCES_SUBQUERY + ") o{} order by date, category").format(where)
    return conn.execute(query, {"tz": config.APP_TIMEZONE, "prefix": analysis.WORKOUT_PREFIX,
                                **params}).fetchall()


@app.get("/api/occurrences")
def occurrences(start: date | None = None, end: date | None = None,
                category: str | None = None, kind: Kind = "all", conn=Depends(get_db)):
    return load_occurrences(conn, category, kind, start, end)


@app.get("/api/analysis/categories")
def analysis_categories(conn=Depends(get_db)):
    query = sql.SQL("select category, kind, count(*) as n from (" + OCCURRENCES_SUBQUERY + ") o "
                    "group by category, kind order by kind, n desc, category")
    return conn.execute(query, {"tz": config.APP_TIMEZONE, "prefix": analysis.WORKOUT_PREFIX}).fetchall()


@app.get("/api/analysis/event-impact")
def event_impact(metric: str, category: str,
                 window: int = Query(3, ge=1, le=14),
                 min_intensity: int | None = Query(None, ge=1, le=5),
                 conn=Depends(get_db)):
    events = analysis.filter_events(load_occurrences(conn, category), category, min_intensity)
    dates = analysis.event_dates(events)
    if dates:
        series = load_series(conn, metric, dates[0] - timedelta(days=window + 60),
                             dates[-1] + timedelta(days=window + 60))
    else:
        series = {}
    return {"metric": metric, "category": category,
            **analysis.event_impact(series, dates, window)}


@app.get("/api/analysis/category-comparison")
def category_comparison(metric: str, lag: int = Query(1, ge=0, le=14),
                        min_intensity: int | None = Query(None, ge=1, le=5),
                        kind: Kind = "event", conn=Depends(get_db)):
    events = analysis.filter_events(load_occurrences(conn, kind=kind), None, min_intensity)
    series = load_series(conn, metric)
    return {"metric": metric, "kind": kind, **analysis.category_comparison(series, events, lag)}


@app.get("/api/analysis/workout-dose")
def workout_dose(metric: str, lag: int = Query(1, ge=0, le=7), name: str | None = None,
                 conn=Depends(get_db)):
    """その日の運動時間と lag 日後の指標の関係。"""
    minutes = workout_minutes_by_date(conn, name)
    series = load_series(conn, metric)
    return {"metric": metric, "name": name, **analysis.workout_dose(series, minutes, lag)}


@app.exception_handler(RuntimeError)
async def runtime_error_handler(request: Request, exc: RuntimeError):
    logger.exception("runtime error")
    return JSONResponse(status_code=500, content={"detail": str(exc)})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
