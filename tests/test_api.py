import base64
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import config, main
from tests.fake_supabase import FakeClient
from tests.sample_payload import SAMPLE


@pytest.fixture
def fake(monkeypatch):
    client = FakeClient()
    main.app.dependency_overrides[main.get_db] = lambda: client
    monkeypatch.setattr(config, "WEBHOOK_TOKEN", "secret-token")
    monkeypatch.setattr(config, "BASIC_AUTH_USER", "")
    monkeypatch.setattr(config, "BASIC_AUTH_PASSWORD", "")
    yield client
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
    assert len(fake.store["health_metrics"]) == 3
    assert len(fake.store["sleep_sessions"]) == 1
    assert len(fake.store["heart_rate_notifications"]) == 1


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
    assert fake.store["workouts"][0]["gpx_file"] == "Outdoor Run-20260824_0630.gpx"


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
