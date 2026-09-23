"""
Render 上で動かすバックエンド API。

  POST /webhook/health-export   Health Auto Export からの自動送信（Bearerトークン認証）
  POST /api/import/zip          手動エクスポートZIPのアップロード取り込み
  GET/POST/PUT/DELETE /api/events  日々のイベント手入力
  GET  /api/metrics/...         日次データ
  GET  /api/analysis/...        分析結果
  GET  /                        ダッシュボード（static/）

/webhook と /healthz 以外は Basic 認証で保護する（BASIC_AUTH_* が設定されている場合）。
"""

from __future__ import annotations

import base64
import binascii
import logging
import secrets
from datetime import date, timedelta
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from app import analysis, config, db, importer

logger = logging.getLogger("apphealth")

app = FastAPI(title="Health × Events")

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
    return db.get_client()


# ---------------------------------------------------------------- 取り込み

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/webhook/health-export", dependencies=[Depends(require_webhook_token)])
async def webhook_health_export(request: Request, client=Depends(get_db)):
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(400, "JSON を解釈できませんでした")
    counts = importer.import_payload(client, payload)
    logger.info("webhook imported: %s", counts)
    return {"imported": counts}


@app.post("/api/import/zip")
async def import_zip(file: UploadFile = File(...), client=Depends(get_db)):
    if file.size is not None and file.size > MAX_ZIP_BYTES:
        raise HTTPException(413, "ファイルが大きすぎます")
    try:
        counts = importer.import_zip(client, file.file)
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


def _event_row(event: EventIn) -> dict:
    return {**event.model_dump(), "date": event.date.isoformat()}


@app.get("/api/events")
def list_events(start: date | None = None, end: date | None = None,
                category: str | None = None, client=Depends(get_db)):
    def q():
        query = client.table("events").select("*")
        if start:
            query = query.gte("date", start.isoformat())
        if end:
            query = query.lte("date", end.isoformat())
        if category:
            query = query.eq("category", category)
        return query.order("date", desc=True).order("id", desc=True)
    return db.fetch_all(q)


@app.post("/api/events", status_code=201)
def create_event(event: EventIn, client=Depends(get_db)):
    return client.table("events").insert(_event_row(event)).execute().data[0]


@app.put("/api/events/{event_id}")
def update_event(event_id: int, event: EventIn, client=Depends(get_db)):
    data = client.table("events").update(_event_row(event)).eq("id", event_id).execute().data
    if not data:
        raise HTTPException(404, "event not found")
    return data[0]


@app.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int, client=Depends(get_db)):
    client.table("events").delete().eq("id", event_id).execute()
    return Response(status_code=204)


@app.get("/api/events/categories")
def event_categories(client=Depends(get_db)):
    rows = db.fetch_all(lambda: client.table("events").select("category").order("id"))
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["category"]] = counts.get(r["category"], 0) + 1
    return [{"category": c, "n": n} for c, n in sorted(counts.items(), key=lambda x: -x[1])]


# ---------------------------------------------------------------- メトリクス

@app.get("/api/metrics/catalog")
def metric_catalog(client=Depends(get_db)):
    rows = client.table("metric_catalog").select("*").order("metric_name").execute().data or []
    sleep = [{"metric_name": name, "units": units, "n_rows": None,
              "first_date": None, "last_date": None}
             for name, (_, units) in analysis.SLEEP_METRICS.items()]
    return sleep + rows


def load_series(client, metric: str, start: date | None = None,
                end: date | None = None) -> dict[date, float]:
    if metric in analysis.SLEEP_METRICS:
        column, _ = analysis.SLEEP_METRICS[metric]
        table, cols = "sleep_sessions", f"id,date,{column}"
    else:
        table, cols = "health_metrics", "id,date,qty,avg_value"

    def q():
        query = client.table(table).select(cols)
        if table == "health_metrics":
            query = query.eq("metric_name", metric)
        if start:
            query = query.gte("date", start.isoformat())
        if end:
            query = query.lte("date", end.isoformat())
        return query.order("date").order("id")

    rows = db.fetch_all(q)
    if table == "sleep_sessions":
        return analysis.daily_series_from_sleep(rows, column)
    return analysis.daily_series_from_metrics(rows)


def _series_json(series: dict[date, float]) -> list[dict]:
    return [{"date": d.isoformat(), "value": v} for d, v in series.items()]


@app.get("/api/metrics/daily")
def metric_daily(metric: str, start: date | None = None, end: date | None = None,
                 client=Depends(get_db)):
    return {"metric": metric, "series": _series_json(load_series(client, metric, start, end))}


@app.get("/api/sleep")
def sleep_sessions(start: date | None = None, end: date | None = None, client=Depends(get_db)):
    def q():
        query = client.table("sleep_sessions").select(
            "date,source,sleep_start,sleep_end,total_sleep_hr,deep_hr,rem_hr,core_hr,awake_hr")
        if start:
            query = query.gte("date", start.isoformat())
        if end:
            query = query.lte("date", end.isoformat())
        return query.order("date").order("id")
    return db.fetch_all(q)


# ---------------------------------------------------------------- 分析

def _load_events(client, category: str | None = None) -> list[dict]:
    def q():
        query = client.table("events").select("id,date,category,intensity")
        if category:
            query = query.eq("category", category)
        return query.order("date").order("id")
    return db.fetch_all(q)


@app.get("/api/analysis/event-impact")
def event_impact(metric: str, category: str,
                 window: int = Query(3, ge=1, le=14),
                 min_intensity: int | None = Query(None, ge=1, le=5),
                 client=Depends(get_db)):
    events = analysis.filter_events(_load_events(client, category), category, min_intensity)
    dates = analysis.event_dates(events)
    if dates:
        series = load_series(client, metric, dates[0] - timedelta(days=window + 60),
                             dates[-1] + timedelta(days=window + 60))
    else:
        series = {}
    return {"metric": metric, "category": category,
            **analysis.event_impact(series, dates, window)}


@app.get("/api/analysis/category-comparison")
def category_comparison(metric: str, lag: int = Query(1, ge=0, le=14),
                        min_intensity: int | None = Query(None, ge=1, le=5),
                        client=Depends(get_db)):
    events = analysis.filter_events(_load_events(client), None, min_intensity)
    series = load_series(client, metric)
    return {"metric": metric, **analysis.category_comparison(series, events, lag)}


@app.exception_handler(RuntimeError)
async def runtime_error_handler(request: Request, exc: RuntimeError):
    logger.exception("runtime error")
    return JSONResponse(status_code=500, content={"detail": str(exc)})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
