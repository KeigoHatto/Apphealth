"""
Health Auto Export の JSON ペイロードを DB の行に変換する純粋関数群。

手動エクスポート（ZIP内のJSON）と REST API 自動化（Webhook POST）は
どちらも {"data": {"metrics": [...], "workouts": [...], ...}} という同じ形なので、
ここで共通化している。DBへのアクセスはここでは行わない（テストしやすくするため）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

# 心拍のようにMin/Max/Avgを持つ指標かどうかを判定するためのキー
STAT_KEYS = {"Min", "Max", "Avg"}

SLEEP_METRIC = "sleep_analysis"

_DATETIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S %z",  # '2026-08-24 00:18:16 +0900'（Health Auto Export 標準）
    "%Y-%m-%d %H:%M:%S",
)


def parse_date_only(date_str: str) -> str:
    """'2026-08-24 00:00:00 +0900' -> '2026-08-24'"""
    return date_str.strip().split(" ")[0].split("T")[0]


def parse_datetime(date_str: str | None) -> str | None:
    if not date_str:
        return None
    for fmt in _DATETIME_FORMATS:
        try:
            return datetime.strptime(date_str, fmt).isoformat()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(date_str).isoformat()
    except ValueError:
        return None


def to_number(value: Any) -> float | None:
    """数値に変換できないもの（None, 文字列, dict等）は None にする。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, dict):
        return to_number(value.get("qty"))
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _dedupe(rows: list[dict], key_fields: tuple[str, ...]) -> list[dict]:
    """
    同じユニークキーを持つ行が1回のupsertに混ざると Postgres が
    'ON CONFLICT DO UPDATE command cannot affect row a second time' で失敗するため、
    後勝ちで1行にまとめる。
    """
    by_key: dict[tuple, dict] = {}
    for row in rows:
        by_key[tuple(row.get(k) for k in key_fields)] = row
    return list(by_key.values())


def build_metric_rows(metrics: list[dict]) -> tuple[list[dict], list[dict]]:
    """metrics 配列を (health_metrics 行, sleep_sessions 行) に振り分ける。"""
    metric_rows: list[dict] = []
    sleep_rows: list[dict] = []

    for metric in metrics:
        name = metric.get("name")
        if not name:
            continue
        units = metric.get("units")
        for point in metric.get("data", []) or []:
            if not point.get("date"):
                continue
            date = parse_date_only(point["date"])
            source = point.get("source")

            if name == SLEEP_METRIC:
                sleep_rows.append({
                    "date": date,
                    "source": source,
                    "in_bed_start": parse_datetime(point.get("inBedStart")),
                    "in_bed_end": parse_datetime(point.get("inBedEnd")),
                    "sleep_start": parse_datetime(point.get("sleepStart")),
                    "sleep_end": parse_datetime(point.get("sleepEnd")),
                    "total_sleep_hr": to_number(point.get("totalSleep")),
                    "deep_hr": to_number(point.get("deep")),
                    "rem_hr": to_number(point.get("rem")),
                    "core_hr": to_number(point.get("core")),
                    "awake_hr": to_number(point.get("awake")),
                    "raw": point,
                })
                continue

            is_stat = STAT_KEYS.issubset(point.keys())
            metric_rows.append({
                "date": date,
                "metric_name": name,
                "qty": None if is_stat else to_number(point.get("qty")),
                "min_value": to_number(point.get("Min")) if is_stat else None,
                "max_value": to_number(point.get("Max")) if is_stat else None,
                "avg_value": to_number(point.get("Avg")) if is_stat else None,
                "units": units,
                "source": source,
                "raw": point,
            })

    return (
        _dedupe(metric_rows, ("date", "metric_name", "source")),
        _dedupe(sleep_rows, ("date", "source")),
    )


def _match_gpx(start: str | None, gpx_files: list[str]) -> str | None:
    """
    GPXファイル名とワークアウト開始日時を突き合わせる。
    日時（YYYYMMDD_HHMM 等）まで一致するものを優先し、なければ日付のみで一致するもの。
    """
    if not start or not gpx_files:
        return None
    day = start[:10].replace("-", "")
    hhmm = start[11:16].replace(":", "")
    same_day = [f for f in gpx_files if day in f.replace("-", "")]
    precise = [f for f in same_day if hhmm and hhmm in f.replace("-", "").replace(":", "")]
    if precise:
        return precise[0]
    return same_day[0] if len(same_day) == 1 else None


def _qty_units(obj: Any) -> tuple[float | None, str | None]:
    if isinstance(obj, dict):
        return to_number(obj.get("qty")), obj.get("units")
    return to_number(obj), None


def _duration_min(w: dict, start_iso: str | None, end_iso: str | None) -> float | None:
    """
    ワークアウト時間（分）。Health Auto Export の duration は秒で来るバージョンがあり単位が
    はっきりしないので、開始・終了時刻から計算できるときはそちらを優先する。
    """
    if start_iso and end_iso:
        seconds = (datetime.fromisoformat(end_iso) - datetime.fromisoformat(start_iso)).total_seconds()
        if seconds >= 0:
            return round(seconds / 60, 2)
    duration = to_number(w.get("duration"))
    if duration is None:
        return None
    # 5時間(300分)を超える値は秒とみなす
    return round(duration / 60, 2) if duration > 300 else duration


def build_workout_rows(workouts: list[dict], gpx_files: list[str] | None = None) -> list[dict]:
    gpx_files = gpx_files or []
    rows = []
    for w in workouts:
        if not w.get("id"):
            continue
        start = w.get("start")
        distance, distance_units = _qty_units(w.get("distance"))
        # バージョンにより activeEnergy / activeEnergyBurned のどちらかで来る
        energy, energy_units = _qty_units(w.get("activeEnergyBurned") or w.get("activeEnergy"))
        speed, speed_units = _qty_units(w.get("speed"))
        start_iso, end_iso = parse_datetime(start), parse_datetime(w.get("end"))
        rows.append({
            "id": w["id"],
            "name": w.get("name"),
            "source": w.get("source"),
            "start_time": start_iso,
            "end_time": end_iso,
            "duration_min": _duration_min(w, start_iso, end_iso),
            "distance_qty": distance,
            "distance_units": distance_units,
            "active_energy_qty": energy,
            "active_energy_units": energy_units,
            "avg_speed": speed,
            "speed_units": speed_units,
            "is_indoor": w.get("isIndoor"),
            "gpx_file": _match_gpx(start, gpx_files),
            "raw": w,
        })
    return _dedupe(rows, ("id",))


def _notification_heart_rate(n: dict) -> float | None:
    hr = n.get("heartRate")
    if hr is None:
        hr = n.get("qty")
    if isinstance(hr, list):
        # 時系列で来る場合はピーク値を代表値にする
        values = [v for v in (to_number(p) for p in hr) if v is not None]
        return max(values) if values else None
    return to_number(hr)


def build_notification_rows(notifications: list[dict]) -> list[dict]:
    rows = []
    for n in notifications:
        rows.append({
            "event_time": parse_datetime(n.get("date") or n.get("start")),
            "notif_type": n.get("type") or n.get("name"),
            "heart_rate": _notification_heart_rate(n),
            "raw": n,
        })
    return _dedupe(rows, ("event_time", "notif_type"))


def extract_data(payload: dict) -> dict:
    """{"data": {...}} でも {...} でも受け付ける。"""
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload if isinstance(payload, dict) else {}
