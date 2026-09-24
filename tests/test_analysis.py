from datetime import date, timedelta

import pytest

from app import analysis


def d(n):
    return date(2026, 1, 1) + timedelta(days=n)


def test_event_impact_detects_drop_next_day():
    # 基本値 50、イベント翌日だけ 40 になる
    events = [10, 30, 50]
    series = {d(i): 50.0 for i in range(70)}
    for e in events:
        series[d(e + 1)] = 40.0
    r = analysis.event_impact(series, [d(e) for e in events], window=2)

    profile = {p["offset"]: p for p in r["profile"]}
    assert profile[0]["mean_delta"] == 0
    assert profile[1]["mean_delta"] == -10
    assert profile[1]["n"] == 3

    lags = {l["lag"]: l for l in r["lags"]}
    assert lags[1]["diff"] == -10
    assert lags[0]["diff"] == 0
    assert lags[1]["event"]["n"] == 3


def test_event_impact_without_events():
    r = analysis.event_impact({d(0): 1.0}, [], window=3)
    assert r["n_events"] == 0
    assert all(p["n"] == 0 for p in r["profile"])


def test_category_comparison_with_lag():
    series = {d(i): 50.0 + (i % 2) for i in range(20)}
    series[d(3)] = 30.0
    series[d(8)] = 34.0
    events = [
        {"date": d(2).isoformat(), "category": "alcohol"},
        {"date": d(7).isoformat(), "category": "alcohol"},
        {"date": d(12).isoformat(), "category": "travel"},
    ]
    r = analysis.category_comparison(series, events, lag=1)
    cats = {c["category"]: c for c in r["categories"]}
    assert cats["alcohol"]["event"]["mean"] == 32
    assert cats["alcohol"]["diff"] < -15
    assert cats["travel"]["event"]["n"] == 1
    assert r["control"]["n"] == 20 - 3


def test_filter_events_by_intensity():
    events = [{"category": "a", "intensity": 1}, {"category": "a", "intensity": 4},
              {"category": "b", "intensity": 5}, {"category": "a", "intensity": None}]
    assert len(analysis.filter_events(events, "a", 3)) == 1
    assert len(analysis.filter_events(events, None, None)) == 4


def test_cohens_d():
    assert analysis.cohens_d([1, 2, 3], [4, 5, 6]) == pytest.approx(-3.0)
    assert analysis.cohens_d([1], [2, 3]) is None


def test_workout_dose_bins_and_correlation():
    # 運動した翌日ほど値が高い
    series = {d(i): 50.0 for i in range(1, 30)}
    minutes = {}
    for i in range(0, 28, 3):
        minutes[d(i)] = 20.0 if i % 2 else 70.0
        series[d(i + 1)] = 55.0 if i % 2 else 60.0
    r = analysis.workout_dose(series, minutes, lag=1)
    bins = {b["label"]: b for b in r["bins"]}
    assert bins["なし"]["mean"] == 50
    assert bins["1〜30分"]["mean"] == 55
    assert bins["61分以上"]["diff"] == 10
    assert bins["31〜60分"]["n"] == 0
    assert r["r"] > 0.8
    # 運動データの最初の日より前は対象外
    assert min(p["date"] for p in r["points"]) == d(0).isoformat()


def test_workout_dose_without_workouts():
    r = analysis.workout_dose({d(0): 1.0}, {}, lag=1)
    assert r["n"] == 0 and r["r"] is None


def test_intensity_filter_skips_workouts_without_intensity():
    # ラン以外のワークアウトは強度を持たないので絞り込まない。ランは強度スコアで絞り込む
    events = [{"category": "workout:Yoga", "intensity": None},
              {"category": "workout:Outdoor Run", "intensity": 8},
              {"category": "workout:Indoor Run", "intensity": 2},
              {"category": "alcohol", "intensity": 1}]
    assert [e["category"] for e in analysis.filter_events(events, None, 3)] == [
        "workout:Yoga", "workout:Outdoor Run"]


def test_run_stats_units():
    s = analysis.run_stats({"distance_qty": 5, "distance_units": "km", "duration_min": 30})
    assert s["speed_kmh"] == 10 and s["pace_min_km"] == 6 and s["load"] == 50
    s = analysis.run_stats({"distance_qty": 1, "distance_units": "mi", "duration_min": None,
                            "avg_speed": 6, "speed_units": "mi/hr"})
    assert s["distance_km"] == pytest.approx(1.609344)
    assert s["speed_kmh"] == pytest.approx(9.656064)
    assert analysis.run_stats({"distance_qty": 5, "distance_units": None})["distance_km"] is None
    assert analysis.is_run("Outdoor Run") and analysis.is_run("Running") and not analysis.is_run("Yoga")


def test_run_day_measures_combines_runs():
    runs = [
        {"date": d(0), "distance_km": 5.0, "duration_min": 30, "speed_kmh": 10.0, "load": 50.0},
        {"date": d(0), "distance_km": 3.0, "duration_min": 10, "speed_kmh": 18.0, "load": 54.0},
        {"date": d(1), "distance_km": None, "duration_min": 20, "speed_kmh": None, "load": None},
    ]
    assert analysis.run_day_measures(runs, "distance") == {d(0): 8.0, d(1): None}
    assert analysis.run_day_measures(runs, "speed") == {d(0): 12.0, d(1): None}
    assert analysis.run_day_measures(runs, "load") == {d(0): 104.0, d(1): None}
    assert analysis.run_day_measures(runs, "duration") == {d(0): 40, d(1): 20}


def test_intensity_scores():
    scores = analysis.intensity_scores({i: float(i) for i in range(1, 11)} | {"x": None})
    assert [scores[i] for i in range(1, 11)] == list(range(1, 11))
    assert scores["x"] is None
    assert analysis.intensity_scores({"a": None}) == {"a": None}


def test_run_intensity_bins():
    # 長く走った翌日ほど値が低い。ランした日は 3日おき、距離は 3 / 6 / 12 km の繰り返し
    series = {d(i): 50.0 for i in range(0, 40)}
    dose = {}
    for n, i in enumerate(range(0, 36, 3)):
        km = [3.0, 6.0, 12.0][n % 3]
        dose[d(i)] = km
        series[d(i + 1)] = 50.0 - km
    dose[d(37)] = None  # 距離が分からない日は、なしにも数えない
    r = analysis.run_intensity(series, dose, lag=1)
    bins = {b["label"]: b for b in r["bins"]}
    assert bins["なし"]["mean"] == 50
    assert bins["低"]["n"] == 4 and bins["低"]["diff"] == -3
    assert bins["中"]["mean"] == 44
    assert bins["高"]["diff"] == -12 and 6 <= bins["高"]["lo"] < 12
    assert r["n_runs"] == 12
    assert r["r"] == pytest.approx(-1.0)
    assert d(37).isoformat() not in {p["date"] for p in r["points"]}


def test_run_intensity_few_runs():
    r = analysis.run_intensity({d(1): 40.0, d(2): 50.0}, {d(0): 5.0}, lag=1)
    assert [b["label"] for b in r["bins"]] == ["なし", "ランあり"]
    assert r["bins"][1]["diff"] == -10
    assert analysis.run_intensity({d(0): 1.0}, {}, lag=1)["n"] == 0
