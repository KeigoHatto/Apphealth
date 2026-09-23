"""パース済みの行を DB に書き込む。ZIP取り込みとWebhookの両方から使う。"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import PurePosixPath

from app import db, parsing


def import_payload(conn, payload: dict, gpx_files: list[str] | None = None) -> dict:
    data = parsing.extract_data(payload)

    metric_rows, sleep_rows = parsing.build_metric_rows(data.get("metrics") or [])
    workout_rows = parsing.build_workout_rows(data.get("workouts") or [], gpx_files)
    notification_rows = parsing.build_notification_rows(data.get("heartRateNotifications") or [])

    # 途中で失敗したら全部巻き戻す
    with conn.transaction():
        db.upsert(conn, "health_metrics", metric_rows, ("date", "metric_name", "source"))
        db.upsert(conn, "sleep_sessions", sleep_rows, ("date", "source"))
        db.upsert(conn, "workouts", workout_rows, ("id",))
        db.upsert(conn, "heart_rate_notifications", notification_rows, ("event_time", "notif_type"))

    return {
        "health_metrics": len(metric_rows),
        "sleep_sessions": len(sleep_rows),
        "workouts": len(workout_rows),
        "heart_rate_notifications": len(notification_rows),
    }


def read_export_zip(fileobj) -> tuple[list[dict], list[str]]:
    """
    Health Auto Export の書き出しZIPから (JSONペイロードのリスト, GPXファイル名のリスト) を返す。
    ディスクに展開せずメモリ上で読む（Zip Slip 対策も兼ねる）。
    """
    payloads: list[dict] = []
    gpx_files: list[str] = []
    with zipfile.ZipFile(fileobj) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = PurePosixPath(info.filename).name
            if name.startswith("._"):  # macOS のリソースフォーク
                continue
            if name.lower().endswith(".gpx"):
                gpx_files.append(name)
            elif name.startswith("HealthAutoExport") and name.lower().endswith(".json"):
                with zf.open(info) as f:
                    payloads.append(json.load(io.TextIOWrapper(f, encoding="utf-8")))
    return payloads, gpx_files


def import_zip(conn, fileobj) -> dict:
    payloads, gpx_files = read_export_zip(fileobj)
    if not payloads:
        raise ValueError("ZIP内に HealthAutoExport-*.json が見つかりませんでした")
    totals: dict[str, int] = {}
    for payload in payloads:
        for key, n in import_payload(conn, payload, gpx_files).items():
            totals[key] = totals.get(key, 0) + n
    return totals
