"""
ヘルスデータ × イベントの分析ロジック（純粋関数）。

series は {date: 値} の辞書（1日1値）、events は events テーブルの行のリスト。
"""

from __future__ import annotations

import bisect
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


WORKOUT_PREFIX = "workout:"


def is_workout(category: str) -> bool:
    return category.startswith(WORKOUT_PREFIX)


def is_run(name: str | None) -> bool:
    """ランニング系のワークアウトか（Outdoor Run / Indoor Run / Running 等）。"""
    return bool(name) and "run" in name.lower()


def has_intensity(category: str) -> bool:
    """強度を持つ出来事か。手入力イベントと、強度スコアを計算するランニングが対象。"""
    return not is_workout(category) or is_run(category[len(WORKOUT_PREFIX):])


def filter_events(events: Iterable[dict], category: str | None = None,
                  min_intensity: int | None = None) -> list[dict]:
    """強度の絞り込みは強度を持つ出来事（手入力イベントとラン）だけに適用する。"""
    out = []
    for e in events:
        if category and e.get("category") != category:
            continue
        if (min_intensity is not None and has_intensity(e["category"])
                and (e.get("intensity") or 0) < min_intensity):
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


def pearson_r(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3:
        return None
    try:
        return statistics.correlation(xs, ys)
    except statistics.StatisticsError:  # どちらかが定数
        return None


# 運動量の区分（分）: (ラベル, 下限, 上限)。下限・上限とも含む
DOSE_BINS = [("なし", 0, 0), ("1〜30分", 0.01, 30), ("31〜60分", 30.01, 60), ("61分以上", 60.01, math.inf)]


def _lagged_points(series: dict[date, float], dose_by_date: dict[date, float | None],
                   lag: int) -> list[dict]:
    """
    series の各日について「lag 日前の運動量」と値を組にする（その日に運動がなければ 0）。
    運動データの最初の日より前は対象外（記録開始前の「0」を混ぜないため）。
    dose が None の日（運動はしたが量が分からない）は除く。
    """
    if not dose_by_date:
        return []
    first = min(dose_by_date)
    points = []
    for d in sorted(series):
        source_day = d - timedelta(days=lag)
        if source_day < first:
            continue
        dose = dose_by_date.get(source_day, 0.0)
        if dose is None:
            continue
        points.append({"date": source_day.isoformat(), "dose": dose,
                       "active": source_day in dose_by_date, "value": series[d]})
    return points


def _with_diff(bins: list[dict]) -> list[dict]:
    """先頭の区分（運動なし）の平均との差を付ける。"""
    base = bins[0]["mean"] if bins else None
    for b in bins:
        b["diff"] = None if base is None or b["mean"] is None else b["mean"] - base
    return bins


def workout_dose(series: dict[date, float], minutes_by_date: dict[date, float], lag: int = 1) -> dict:
    """
    その日の運動時間（分, ワークアウトがない日は0）と、lag 日後の指標の関係。
    series の範囲内で、運動データの最初の日以降だけを対象にする（記録開始前の「0分」を混ぜないため）。
    """
    points = [{"date": p["date"], "minutes": p["dose"], "value": p["value"]}
              for p in _lagged_points(series, minutes_by_date, lag)]
    bins = _with_diff([
        {"label": label, **_summary([p["value"] for p in points if lo <= p["minutes"] <= hi])}
        for label, lo, hi in DOSE_BINS
    ])
    return {
        "lag": lag,
        "n": len(points),
        "r": pearson_r([p["minutes"] for p in points], [p["value"] for p in points]),
        "bins": bins,
        "points": points,
    }


# ---------------------------------------------------------------- ランニングの強度

# ランの強度の測り方: キー -> (表示名, 単位)
RUN_MEASURES = {
    "load": ("距離×速度", "km·km/h"),
    "distance": ("距離", "km"),
    "speed": ("速度", "km/h"),
    "duration": ("時間", "分"),
}

_KM_PER_UNIT = {"km": 1.0, "m": 0.001, "mi": 1.609344, "yd": 0.0009144, "ft": 0.0003048}
_KMH_PER_UNIT = {"km/hr": 1.0, "km/h": 1.0, "kph": 1.0, "mi/hr": 1.609344, "mph": 1.609344,
                 "mi/h": 1.609344, "m/s": 3.6}


def to_km(qty: float | None, units: str | None) -> float | None:
    if qty is None or not units:
        return None
    factor = _KM_PER_UNIT.get(units.strip().lower())
    return None if factor is None else qty * factor


def to_kmh(qty: float | None, units: str | None) -> float | None:
    if qty is None or not units:
        return None
    factor = _KMH_PER_UNIT.get(units.strip().lower())
    return None if factor is None else qty * factor


def run_stats(w: dict) -> dict:
    """
    ワークアウト1件の距離(km)・速度(km/h)・ペース(分/km)・負荷(距離×速度)。
    速度は距離÷時間を優先し、計算できなければ記録された平均速度を使う。
    """
    km = to_km(w.get("distance_qty"), w.get("distance_units"))
    minutes = w.get("duration_min")
    if km is not None and minutes:
        speed = km * 60 / minutes
    else:
        speed = to_kmh(w.get("avg_speed"), w.get("speed_units"))
    return {
        "distance_km": km,
        "speed_kmh": speed,
        "pace_min_km": 60 / speed if speed else None,
        "load": km * speed if km is not None and speed is not None else None,
    }


def run_measure(w: dict, measure: str) -> float | None:
    """run_stats 済みのワークアウトから強度の値を取り出す。"""
    if measure == "duration":
        return w.get("duration_min")
    key = {"load": "load", "distance": "distance_km", "speed": "speed_kmh"}[measure]
    return w.get(key)


def run_day_measures(runs: Iterable[dict], measure: str) -> dict[date, float | None]:
    """
    日ごとのランの強度。距離・時間・負荷は合計、速度は合計距離÷合計時間。
    ランはしたが値が分からない日は None。
    """
    by_day: dict[date, list[dict]] = defaultdict(list)
    for w in runs:
        by_day[_to_date(w["date"])].append(w)
    out: dict[date, float | None] = {}
    for d, ws in by_day.items():
        if measure == "speed":
            timed = [w for w in ws if w.get("distance_km") is not None and w.get("duration_min")]
            if timed:
                out[d] = sum(w["distance_km"] for w in timed) * 60 / sum(w["duration_min"] for w in timed)
            else:
                speeds = [w["speed_kmh"] for w in ws if w.get("speed_kmh") is not None]
                out[d] = statistics.fmean(speeds) if speeds else None
        else:
            values = [run_measure(w, measure) for w in ws]
            known = [v for v in values if v is not None]
            out[d] = sum(known) if known else None
    return out


def intensity_scores(values: dict, levels: int = 10) -> dict:
    """
    値を 1〜levels の強度スコアにする（全体の中での順位。上位10%が10、下位10%が1）。
    手入力イベントの強度（1〜10）と同じ目盛りで絞り込めるようにするため。
    """
    known = sorted(v for v in values.values() if v is not None)
    if not known:
        return {k: None for k in values}
    out = {}
    for k, v in values.items():
        if v is None:
            out[k] = None
            continue
        rank = bisect.bisect_right(known, v) / len(known)
        out[k] = max(1, math.ceil(rank * levels))
    return out


def run_intensity(series: dict[date, float], dose_by_date: dict[date, float | None],
                  lag: int = 1) -> dict:
    """
    ランの強度（距離・速度・距離×速度など）で日を「なし / 低 / 中 / 高」に分け、
    lag 日後の指標を比較する。低・中・高はランした日の値の三分位で区切る。
    相関係数はランした日だけで計算する（強度が上がるほど指標がどう動くか）。
    """
    points = _lagged_points(series, dose_by_date, lag)
    run_points = [p for p in points if p["active"]]
    run_values = sorted(v for v in dose_by_date.values() if v is not None)

    if len(run_values) >= 3:
        t1, t2 = statistics.quantiles(run_values, n=3, method="inclusive")
        levels = [("低", None, t1), ("中", t1, t2), ("高", t2, None)]
    else:
        levels = [("ランあり", None, None)] if run_values else []

    def in_level(v: float, lo: float | None, hi: float | None) -> bool:
        return (lo is None or v > lo) and (hi is None or v <= hi)

    bins = [{"label": "なし", "lo": None, "hi": None,
             **_summary([p["value"] for p in points if not p["active"]])}]
    for label, lo, hi in levels:
        bins.append({"label": label, "lo": lo, "hi": hi,
                     **_summary([p["value"] for p in run_points if in_level(p["dose"], lo, hi)])})

    return {
        "lag": lag,
        "n": len(points),
        "n_runs": len(run_points),
        "r": pearson_r([p["dose"] for p in run_points], [p["value"] for p in run_points]),
        "bins": _with_diff(bins),
        "points": [{"date": p["date"], "dose": p["dose"], "value": p["value"]} for p in run_points],
    }
