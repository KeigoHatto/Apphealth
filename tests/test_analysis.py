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
