"""
ヘルスデータ × イベントの分析ロジック（純粋関数）。

series は {date: 値} の辞書（1日1値）、events は events テーブルの行のリスト。
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from datetime import date, timedelta
from typing import Iterable

# 睡眠は sleep_sessions テーブルから、ここにある擬似メトリクス名で参照する
SLEEP_METRICS = {
    "sleep_total": ("total_sleep_hr", "hr"),
    "sleep_deep": ("deep_hr", "hr"),
    "sleep_rem": ("rem_hr", "hr"),
    "sleep_core": ("core_hr", "hr"),
    "sleep_awake": ("awake_hr", "hr"),
}


def _to_date(value) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def _summary(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "mean": None, "median": None, "sd": None,
                "q1": None, "q3": None, "min": None, "max": None}
    s = sorted(values)
    if len(s) >= 2:
        q1, _, q3 = statistics.quantiles(s, n=4, method="inclusive")
    else:
        q1 = q3 = s[0]
    return {
        "n": len(s),
        "mean": statistics.fmean(s),
        "median": statistics.median(s),
        "sd": statistics.stdev(s) if len(s) >= 2 else None,
        "q1": q1,
        "q3": q3,
        "min": s[0],
        "max": s[-1],
    }


def cohens_d(a: list[float], b: list[float]) -> float | None:
    """効果量（プールした標準偏差で割った平均差, a - b）。"""
    if len(a) < 2 or len(b) < 2:
        return None
    va, vb = statistics.variance(a), statistics.variance(b)
    pooled = math.sqrt(((len(a) - 1) * va + (len(b) - 1) * vb) / (len(a) + len(b) - 2))
    if pooled == 0:
        return None
    return (statistics.fmean(a) - statistics.fmean(b)) / pooled


def _compare(event_values: list[float], control_values: list[float]) -> dict:
    ev, ctl = _summary(event_values), _summary(control_values)
    diff = None
    if ev["mean"] is not None and ctl["mean"] is not None:
        diff = ev["mean"] - ctl["mean"]
    return {"event": ev, "control": ctl, "diff": diff,
            "cohens_d": cohens_d(event_values, control_values)}


def filter_events(events: Iterable[dict], category: str | None = None,
                  min_intensity: int | None = None) -> list[dict]:
    out = []
    for e in events:
        if category and e.get("category") != category:
            continue
        if min_intensity is not None and (e.get("intensity") or 0) < min_intensity:
            continue
        out.append(e)
    return out


def event_dates(events: Iterable[dict]) -> list[date]:
    return sorted({_to_date(e["date"]) for e in events})


def event_impact(series: dict[date, float], dates: list[date], window: int = 3) -> dict:
    """
    イベント前後の変化（before/after 比較 + ラグ分析）。

    - profile: オフセット -window..+window ごとに、各イベントの「直前 window 日の平均」
      （ベースライン）からの差分を平均したもの。
    - lags: ラグ 0..window 日ごとに、イベント日+ラグの値と、
      イベントの影響がない日（どのイベントの 0..window 日後にも当たらない日）の値を比較。
    """
    profile = []
    for offset in range(-window, window + 1):
        deltas, values = [], []
        for d in dates:
            baseline = [series[d - timedelta(days=k)] for k in range(1, window + 1)
                        if d - timedelta(days=k) in series]
            target = d + timedelta(days=offset)
            if not baseline or target not in series:
                continue
            values.append(series[target])
            deltas.append(series[target] - statistics.fmean(baseline))
        profile.append({
            "offset": offset,
            "n": len(deltas),
            "mean_delta": statistics.fmean(deltas) if deltas else None,
            "sd_delta": statistics.stdev(deltas) if len(deltas) >= 2 else None,
            "mean_value": statistics.fmean(values) if values else None,
        })

    affected = {d + timedelta(days=k) for d in dates for k in range(0, window + 1)}
    control = [v for d, v in series.items() if d not in affected]
    lags = []
    for lag in range(0, window + 1):
        ev = [series[d + timedelta(days=lag)] for d in dates if d + timedelta(days=lag) in series]
        lags.append({"lag": lag, **_compare(ev, control)})

    return {"n_events": len(dates), "window": window, "profile": profile, "lags": lags}


def category_comparison(series: dict[date, float], events: list[dict], lag: int = 1) -> dict:
    """
    カテゴリ別に「イベント日 + lag 日」の値の分布を比較する。
    control は、どのカテゴリのイベントも lag 日前に起きていない日。
    """
    by_category: dict[str, set[date]] = defaultdict(set)
    for e in events:
        by_category[e["category"]].add(_to_date(e["date"]))

    all_shifted = {d + timedelta(days=lag) for ds in by_category.values() for d in ds}
    control = [v for d, v in series.items() if d not in all_shifted]

    categories = []
    for category, dates in sorted(by_category.items()):
        values = [series[d + timedelta(days=lag)] for d in sorted(dates)
                  if d + timedelta(days=lag) in series]
        categories.append({"category": category, **_compare(values, control)})

    return {"lag": lag, "control": _summary(control), "categories": categories}
