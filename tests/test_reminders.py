from datetime import datetime, time, timedelta, timezone

from app.reminders import in_window, is_due

TZ = "Asia/Tokyo"
JST = timezone(timedelta(hours=9))


def settings(**kw):
    return {"enabled": True, "interval_minutes": 120, "start_time": time(9), "end_time": time(21),
            "last_sent_at": None, **kw}


def at(h, m=0, day=24):
    return datetime(2026, 8, day, h, m, tzinfo=JST)


def test_in_window():
    assert in_window(time(9), time(9), time(21))
    assert not in_window(time(21), time(9), time(21))
    assert not in_window(time(8, 59), time(9), time(21))
    # 日付をまたぐ時間帯
    assert in_window(time(23), time(22), time(2))
    assert in_window(time(1), time(22), time(2))
    assert not in_window(time(12), time(22), time(2))
    # 開始 = 終了 は終日
    assert in_window(time(3), time(0), time(0))


def test_disabled_or_outside_window():
    assert not is_due(at(12), settings(enabled=False), None, TZ)
    assert not is_due(at(8), settings(), None, TZ)
    assert not is_due(at(21, 30), settings(), None, TZ)
    assert is_due(at(12), settings(), None, TZ)


def test_interval_counts_from_last_reminder_or_mood():
    s = settings(last_sent_at=at(10))
    assert not is_due(at(11), s, None, TZ)
    assert is_due(at(12), s, None, TZ)
    # 定期チェックのずれを吸収するため少し早めでも送る
    assert is_due(at(11, 56), s, None, TZ)
    assert not is_due(at(11, 50), s, None, TZ)
    # 自分で記録した直後にはリマインドしない
    assert not is_due(at(12), s, at(11), TZ)
    assert is_due(at(13), s, at(11), TZ)


def test_first_reminder_of_the_day():
    s = settings(last_sent_at=at(20, 50, day=23))
    assert not is_due(at(8, 55), s, None, TZ)
    assert is_due(at(9), s, None, TZ)


def test_timezone_is_applied():
    # 03:00 UTC = 12:00 JST
    now = datetime(2026, 8, 24, 3, tzinfo=timezone.utc)
    assert is_due(now, settings(), None, TZ)
    assert not is_due(now, settings(), None, "UTC")
