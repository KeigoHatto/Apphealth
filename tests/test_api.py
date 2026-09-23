"""
API テスト。本物の Postgres が必要:
  TEST_DATABASE_URL=postgresql://... pytest
未設定ならスキップする。テーブルは毎テスト TRUNCATE されるので、本番DBを指定しないこと。
"""

import base64
import io
import json
import os
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import config, db, main
from tests.sample_payload import SAMPLE

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL が未設定")

TABLES = "health_metrics, sleep_sessions, workouts, heart_rate_notifications, events"


def rows(conn, table):
    return conn.execute(f"select * from {table}").fetchall()


@pytest.fixture
def fake(monkeypatch):
    with db.connect(TEST_DATABASE_URL) as conn:
        db.init_schema(conn)
        conn.execute(f"truncate {TABLES} restart identity")
        main.app.dependency_overrides[main.get_db] = lambda: conn
        monkeypatch.setattr(config, "DATABASE_URL", "")  # lifespan でプールを作らせない
        monkeypatch.setattr(config, "WEBHOOK_TOKEN", "secret-token")
        monkeypatch.setattr(config, "BASIC_AUTH_USER", "")
        monkeypatch.setattr(config, "BASIC_AUTH_PASSWORD", "")
        yield conn
        main.app.dependency_overrides.clear()


@pytest.fixture
def http():
    return TestClient(main.app)


def test_webhook_requires_token(fake, http):
    assert http.post("/webhook/health-export", json=SAMPLE).status_code == 401
    bad = http.post("/webhook/health-export", json=SAMPLE, headers={"Authorization": "Bearer nope"})
    assert bad.status_code == 401


def test_webhook_imports_and_is_idempotent(fake, http):
    headers = {"Authorization": "Bearer secret-token"}
    for _ in range(2):
        r = http.post("/webhook/health-export", json=SAMPLE, headers=headers)
        assert r.status_code == 200, r.text
    assert r.json()["imported"] == {"health_metrics": 3, "sleep_sessions": 1,
                                    "workouts": 1, "heart_rate_notifications": 1}
    assert len(rows(fake, "health_metrics")) == 3
    assert len(rows(fake, "sleep_sessions")) == 1
    assert len(rows(fake, "heart_rate_notifications")) == 1
    hr = fake.execute("select * from health_metrics where metric_name = 'heart_rate'").fetchone()
    assert (hr["min_value"], hr["avg_value"], hr["raw"]["Max"]) == (52, 71.5, 140)
    sleep = rows(fake, "sleep_sessions")[0]
    assert sleep["sleep_start"].isoformat() == "2026-08-23T15:18:16+00:00"


def test_webhook_rejects_when_token_not_configured(fake, http, monkeypatch):
    monkeypatch.setattr(config, "WEBHOOK_TOKEN", "")
    r = http.post("/webhook/health-export", json=SAMPLE, headers={"Authorization": "Bearer "})
    assert r.status_code == 503


def test_zip_import(fake, http):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("export/HealthAutoExport-2026-08-24-2026-08-25.json", json.dumps(SAMPLE))
        zf.writestr("export/Outdoor Run-20260824_0630.gpx", "<gpx/>")
    r = http.post("/api/import/zip", files={"file": ("x.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 200, r.text
    assert rows(fake, "workouts")[0]["gpx_file"] == "Outdoor Run-20260824_0630.gpx"


def test_import_rolls_back_on_error(fake, http):
    bad = json.loads(json.dumps(SAMPLE))
    bad["data"]["workouts"][0]["duration"] = None
    bad["data"]["workouts"][0]["start"] = "2026-08-24 06:30:00 +0900"
    bad["data"]["workouts"][0]["isIndoor"] = "not-a-bool"  # boolean 列に入らない
    headers = {"Authorization": "Bearer secret-token"}
    with pytest.raises(Exception):
        http.post("/webhook/health-export", json=bad, headers=headers)
    assert rows(fake, "health_metrics") == []


def test_zip_without_json(fake, http):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", "x")
    r = http.post("/api/import/zip", files={"file": ("x.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 400


def test_events_crud(fake, http):
    r = http.post("/api/events", json={"date": "2026-08-24", "category": " Alcohol ", "intensity": 3})
    assert r.status_code == 201, r.text
    ev = r.json()
    assert ev["category"] == "alcohol"

    assert http.post("/api/events", json={"date": "2026-08-24", "category": "x", "intensity": 9}).status_code == 422
    assert http.post("/api/events", json={"date": "2026-08-24", "category": "  "}).status_code == 422

    r = http.put(f"/api/events/{ev['id']}", json={"date": "2026-08-25", "category": "stress", "note": "締切"})
    assert r.json()["note"] == "締切"
    assert http.put("/api/events/999", json={"date": "2026-08-25", "category": "x"}).status_code == 404

    assert http.get("/api/events/categories").json() == [{"category": "stress", "n": 1}]
    assert len(http.get("/api/events", params={"start": "2026-08-25"}).json()) == 1
    assert http.delete(f"/api/events/{ev['id']}").status_code == 204
    assert http.get("/api/events").json() == []


def test_metrics_and_analysis(fake, http):
    http.post("/webhook/health-export", json=SAMPLE, headers={"Authorization": "Bearer secret-token"})
    http.post("/api/events", json={"date": "2026-08-24", "category": "alcohol"})

    catalog = {m["metric_name"] for m in http.get("/api/metrics/catalog").json()}
    assert {"sleep_total", "step_count", "heart_rate"} <= catalog

    series = http.get("/api/metrics/daily", params={"metric": "step_count"}).json()["series"]
    assert series == [{"date": "2026-08-24", "value": 8123}, {"date": "2026-08-25", "value": 5000}]
    sleep = http.get("/api/metrics/daily", params={"metric": "sleep_total"}).json()["series"]
    assert sleep == [{"date": "2026-08-24", "value": 6.2}]

    r = http.get("/api/analysis/event-impact",
                 params={"metric": "step_count", "category": "alcohol", "window": 1})
    assert r.status_code == 200
    assert r.json()["n_events"] == 1
    r = http.get("/api/analysis/category-comparison", params={"metric": "step_count", "lag": 1})
    assert r.json()["categories"][0]["event"]["mean"] == 5000


def test_basic_auth(fake, http, monkeypatch):
    monkeypatch.setattr(config, "BASIC_AUTH_USER", "me")
    monkeypatch.setattr(config, "BASIC_AUTH_PASSWORD", "pw")
    assert http.get("/api/events").status_code == 401
    assert http.get("/").status_code == 401
    good = "Basic " + base64.b64encode(b"me:pw").decode()
    assert http.get("/api/events", headers={"Authorization": good}).status_code == 200
    assert http.get("/", headers={"Authorization": good}).status_code == 200
    # Webhook と healthz は Basic 認証の対象外
    assert http.get("/healthz").status_code == 200
    r = http.post("/webhook/health-export", json=SAMPLE, headers={"Authorization": "Bearer secret-token"})
    assert r.status_code == 200
