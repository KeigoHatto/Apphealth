import copy

from app import parsing
from tests.sample_payload import SAMPLE


def test_parse_datetime_formats():
    assert parsing.parse_datetime("2026-08-24 00:18:16 +0900") == "2026-08-24T00:18:16+09:00"
    assert parsing.parse_datetime("2026-08-24T00:18:16+09:00") == "2026-08-24T00:18:16+09:00"
    assert parsing.parse_datetime("garbage") is None
    assert parsing.parse_datetime(None) is None


def test_metric_rows_split_simple_stat_and_sleep():
    metrics, sleep = parsing.build_metric_rows(SAMPLE["data"]["metrics"])
    steps = [r for r in metrics if r["metric_name"] == "step_count"]
    hr = next(r for r in metrics if r["metric_name"] == "heart_rate")
    assert [r["qty"] for r in steps] == [8123, 5000]
    assert steps[0]["date"] == "2026-08-24"
    assert (hr["qty"], hr["min_value"], hr["max_value"], hr["avg_value"]) == (None, 52, 140, 71.5)
    assert all(r["metric_name"] != "sleep_analysis" for r in metrics)
    assert len(sleep) == 1
    assert sleep[0]["total_sleep_hr"] == 6.2
    assert sleep[0]["sleep_start"] == "2026-08-24T00:18:16+09:00"


def test_duplicate_keys_in_one_batch_are_merged():
    metrics = copy.deepcopy(SAMPLE["data"]["metrics"][:1])
    metrics[0]["data"].append({"date": "2026-08-24 00:00:00 +0900", "qty": 9000,
                               "source": "Apple Watch|iPhone"})
    rows, _ = parsing.build_metric_rows(metrics)
    day = [r for r in rows if r["date"] == "2026-08-24"]
    assert len(day) == 1 and day[0]["qty"] == 9000


def test_workouts_and_gpx_matching():
    rows = parsing.build_workout_rows(
        SAMPLE["data"]["workouts"],
        ["Outdoor Run-20260824_0630.gpx", "Cycling-20260901_1800.gpx"],
    )
    assert rows[0]["distance_qty"] == 5.1
    assert rows[0]["active_energy_units"] == "kcal"
    assert rows[0]["gpx_file"] == "Outdoor Run-20260824_0630.gpx"


def test_gpx_ambiguous_same_day_is_not_guessed():
    rows = parsing.build_workout_rows(
        SAMPLE["data"]["workouts"],
        ["Run-20260824_1800.gpx", "Walk-20260824_1200.gpx"],
    )
    assert rows[0]["gpx_file"] is None


def test_notification_heart_rate_list_takes_peak():
    rows = parsing.build_notification_rows(SAMPLE["data"]["heartRateNotifications"])
    assert rows[0]["heart_rate"] == 131
    assert rows[0]["notif_type"] == "High Heart Rate"


def test_extract_data_accepts_wrapped_and_bare():
    assert parsing.extract_data(SAMPLE) is SAMPLE["data"]
    assert parsing.extract_data(SAMPLE["data"]) is SAMPLE["data"]
    assert parsing.extract_data([]) == {}


def test_workout_duration_prefers_start_end():
    rows = parsing.build_workout_rows([
        {"id": "a", "start": "2026-08-24 06:30:00 +0900", "end": "2026-08-24 07:15:30 +0900", "duration": 2730},
        {"id": "b", "duration": 2730},   # 秒で来たとみなす
        {"id": "c", "duration": 45},     # 分とみなす
    ])
    by_id = {r["id"]: r["duration_min"] for r in rows}
    assert by_id == {"a": 45.5, "b": 45.5, "c": 45}
