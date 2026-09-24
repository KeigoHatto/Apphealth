"""
気分のリマインダーを送るかどうかの判定（純粋関数）。

外部の定期実行（cron-job.org など）が /webhook/reminders/tick を数分〜15分おきに叩き、
そのたびに is_due() で「今送るべきか」を決める。
最後に通知した時刻と最後に気分を記録した時刻のうち新しいほうから interval 経過していて、
いまが通知してよい時間帯なら送る（記録した直後にリマインドが来ないように）。
"""

from __future__ import annotations

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

# 定期チェックの間隔ぶん通知が後ろにずれ続けないよう、少し早めでも送る
TOLERANCE = timedelta(minutes=5)


def in_window(t: time, start: time, end: time) -> bool:
    """t が start〜end に入っているか。end < start なら日付をまたぐ時間帯（例: 22:00〜02:00）。"""
    if start == end:
        return True
    if start < end:
        return start <= t < end
    return t >= start or t < end


def is_due(now: datetime, settings: dict, last_mood_at: datetime | None, tz: str) -> bool:
    if not settings["enabled"]:
        return False
    local = now.astimezone(ZoneInfo(tz))
    if not in_window(local.time(), settings["start_time"], settings["end_time"]):
        return False
    last = max((t for t in (settings["last_sent_at"], last_mood_at) if t is not None), default=None)
    return last is None or now - last >= timedelta(minutes=settings["interval_minutes"]) - TOLERANCE
