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

from app import config, db, main, push
from tests.sample_payload import SAMPLE

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL が未設定")

TABLES = ("health_metrics, sleep_sessions, workouts, heart_rate_notifications, events, "
          "mood_logs, push_subscriptions, reminder_settings")


def rows(conn, table):
    return conn.execute(f"select * from {table}").fetchall()


@pytest.fixture
def fake(monkeypatch):
    with db.connect(TEST_DATABASE_URL) as conn:
        db.init_schema(conn)
        conn.execute(f"truncate {TABLES} restart identity")
        conn.execute("insert into reminder_settings (id) values (1)")
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
    # Webhook と healthz、ホーム画面アプリが認証なしで取りに来るファイルは Basic 認証の対象外
    assert http.get("/healthz").status_code == 200
    assert http.get("/sw.js").status_code == 200
    assert http.get("/manifest.webmanifest").status_code == 200
    r = http.post("/webhook/health-export", json=SAMPLE, headers={"Authorization": "Bearer secret-token"})
    assert r.status_code == 200


def _post(http, payload):
    r = http.post("/webhook/health-export", json=payload, headers={"Authorization": "Bearer secret-token"})
    assert r.status_code == 200, r.text


def test_workouts_endpoints_and_analysis(fake, http):
    metrics = [{"date": f"2026-08-{day:02d} 00:00:00 +0900", "qty": 50 + (10 if day in (11, 16) else 0),
                "source": "Apple Watch"} for day in range(1, 21)]
    workouts = [
        # 23:30 JST 開始 → UTC では前日ではなく、JST の日付（8/10）として扱われること
        {"id": "w1", "name": "Outdoor Run", "start": "2026-08-10 23:30:00 +0900",
         "end": "2026-08-11 00:15:00 +0900", "distance": {"qty": 7.5, "units": "km"}},
        {"id": "w2", "name": "Outdoor Run", "start": "2026-08-15 07:00:00 +0900",
         "end": "2026-08-15 07:30:00 +0900"},
        {"id": "w3", "name": "Yoga", "start": "2026-08-18 20:00:00 +0900",
         "end": "2026-08-18 20:20:00 +0900"},
    ]
    _post(http, {"data": {"metrics": [{"name": "heart_rate_variability", "units": "ms", "data": metrics}],
                          "workouts": workouts}})
    http.post("/api/events", json={"date": "2026-08-05", "category": "alcohol"})

    ws = http.get("/api/workouts").json()
    assert [w["id"] for w in ws] == ["w3", "w2", "w1"]
    run = ws[2]
    assert (run["date"], run["start_local"], run["duration_min"], run["distance_qty"]) == (
        "2026-08-10", "23:30", 45, 7.5)
    assert len(http.get("/api/workouts", params={"start": "2026-08-15", "name": "Outdoor Run"}).json()) == 1

    types = http.get("/api/workouts/types").json()
    assert types[0] == {"name": "Outdoor Run", "n": 2, "total_min": 75, "last_date": "2026-08-15"}

    occ = http.get("/api/occurrences", params={"start": "2026-08-01", "end": "2026-08-12"}).json()
    assert [(o["date"], o["category"], o["kind"]) for o in occ] == [
        ("2026-08-05", "alcohol", "event"), ("2026-08-10", "workout:Outdoor Run", "workout")]
    assert occ[1]["note"] == "45分"

    cats = {(c["category"], c["kind"]): c["n"] for c in http.get("/api/analysis/categories").json()}
    assert cats == {("alcohol", "event"): 1, ("workout:Outdoor Run", "workout"): 2, ("workout:Yoga", "workout"): 1}

    r = http.get("/api/analysis/event-impact", params={
        "metric": "heart_rate_variability", "category": "workout:Outdoor Run", "window": 1,
        "min_intensity": 3}).json()
    assert r["n_events"] == 2
    lag1 = next(l for l in r["lags"] if l["lag"] == 1)
    assert lag1["event"]["mean"] == 60

    r = http.get("/api/analysis/category-comparison",
                 params={"metric": "heart_rate_variability", "lag": 1, "kind": "workout"}).json()
    assert [c["category"] for c in r["categories"]] == ["workout:Outdoor Run", "workout:Yoga"]
    r = http.get("/api/analysis/category-comparison",
                 params={"metric": "heart_rate_variability", "lag": 1}).json()
    assert [c["category"] for c in r["categories"]] == ["alcohol"]

    r = http.get("/api/analysis/workout-dose", params={"metric": "heart_rate_variability", "lag": 1}).json()
    bins = {b["label"]: b for b in r["bins"]}
    # 45分のラン(8/10→8/11=60) / 30分のラン(8/15→8/16=60) と 20分のヨガ(8/18→8/19=50)
    assert (bins["31〜60分"]["n"], bins["31〜60分"]["mean"]) == (1, 60)
    assert (bins["1〜30分"]["n"], bins["1〜30分"]["mean"]) == (2, 55)
    assert bins["なし"]["mean"] == 50
    assert r["points"][0]["date"] == "2026-08-10"
    r = http.get("/api/analysis/workout-dose",
                 params={"metric": "heart_rate_variability", "name": "Yoga"}).json()
    assert r["points"][0]["date"] == "2026-08-18"


def test_moods_and_mood_metric(fake, http):
    # 00:30 JST は UTC では前日だが、JST の日付（8/25）として集計されること
    for mood, at in [(2, "2026-08-24T08:00:00+09:00"), (4, "2026-08-24T20:00:00+09:00"),
                     (5, "2026-08-25T00:30:00+09:00")]:
        r = http.post("/api/moods", json={"mood": mood, "logged_at": at, "note": "眠い" if mood == 2 else None})
        assert r.status_code == 201, r.text
    assert r.json()["date"] == "2026-08-25" and r.json()["time_local"] == "00:30"
    assert http.post("/api/moods", json={"mood": 6}).status_code == 422
    assert http.post("/api/moods", json={"mood": 3}).json()["logged_at"]  # 省略時は現在時刻

    moods = http.get("/api/moods", params={"end": "2026-08-24"}).json()
    assert [(m["mood"], m["note"]) for m in moods] == [(4, None), (2, "眠い")]

    assert "mood" in {m["metric_name"] for m in http.get("/api/metrics/catalog").json()}
    series = http.get("/api/metrics/daily",
                      params={"metric": "mood", "start": "2026-08-24", "end": "2026-08-25"}).json()["series"]
    assert series == [{"date": "2026-08-24", "value": 3}, {"date": "2026-08-25", "value": 5}]

    assert http.delete(f"/api/moods/{moods[0]['id']}").status_code == 204
    assert len(http.get("/api/moods").json()) == 3


SUB = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "key", "auth": "auth"}}


@pytest.fixture
def vapid(monkeypatch):
    monkeypatch.setattr(config, "VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setattr(config, "VAPID_PRIVATE_KEY", "priv")
    sent = []
    monkeypatch.setattr(push, "webpush", lambda info, data, **kw: sent.append((info, json.loads(data))))
    return sent


def test_push_subscription_and_settings(fake, http, vapid):
    assert http.get("/api/push/public-key").json() == {"public_key": "pub"}
    assert http.post("/api/push/subscribe", json={"endpoint": "x", "keys": {}}).status_code == 422
    for _ in range(2):  # 同じ端末の登録し直しは上書き
        assert http.post("/api/push/subscribe", json=SUB).status_code == 201
    s = http.get("/api/reminders/settings").json()
    assert (s["enabled"], s["devices"], s["push_configured"]) == (False, 1, True)

    r = http.put("/api/reminders/settings", json={"enabled": True, "interval_minutes": 90,
                                                  "start_time": "08:30", "end_time": "22:00"})
    assert r.status_code == 200, r.text
    assert (r.json()["interval_minutes"], r.json()["start_time"]) == (90, "08:30:00")
    assert http.put("/api/reminders/settings", json={"enabled": True, "interval_minutes": 5,
                                                     "start_time": "08:30", "end_time": "22:00"}).status_code == 422

    assert http.post("/api/reminders/test").json()["sent"] == 1
    assert vapid[0][0]["keys"] == SUB["keys"] and vapid[0][1]["title"] == "テスト通知"

    http.post("/api/push/unsubscribe", json={"endpoint": SUB["endpoint"]})
    assert http.get("/api/reminders/settings").json()["devices"] == 0


def test_push_not_configured(fake, http, monkeypatch):
    monkeypatch.setattr(config, "VAPID_PUBLIC_KEY", "")
    assert http.get("/api/push/public-key").status_code == 503
    assert http.post("/api/reminders/test").status_code == 503


def test_reminder_tick(fake, http, vapid):
    auth = {"Authorization": "Bearer secret-token"}
    assert http.post("/webhook/reminders/tick").status_code == 401
    http.post("/api/push/subscribe", json=SUB)
    # 無効のあいだは送らないが、定期チェックが届いたことは記録する
    assert http.post("/webhook/reminders/tick", headers=auth).json() == {"due": False}
    assert http.get("/api/reminders/settings").json()["last_checked_at"]

    http.put("/api/reminders/settings", json={"enabled": True, "interval_minutes": 60,
                                              "start_time": "00:00", "end_time": "00:00"})
    r = http.post("/webhook/reminders/tick", headers=auth).json()
    assert r == {"due": True, "sent": 1, "failed": 0, "removed": 0}
    assert vapid[-1][1]["url"] == "/#mood"
    # 送った直後は次の間隔まで送らない
    assert http.post("/webhook/reminders/tick", headers=auth).json() == {"due": False}
    assert len(vapid) == 1


def test_expired_subscription_is_removed(fake, http, vapid, monkeypatch):
    class Gone:
        status_code = 410

    def fail(info, data, **kw):
        raise push.WebPushException("gone", response=Gone())

    monkeypatch.setattr(push, "webpush", fail)
    http.post("/api/push/subscribe", json=SUB)
    assert http.post("/api/reminders/test").json() == {"sent": 0, "failed": 0, "removed": 1}
    assert rows(fake, "push_subscriptions") == []
