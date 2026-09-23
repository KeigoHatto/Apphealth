SAMPLE = {
    "data": {
        "metrics": [
            {"name": "step_count", "units": "count", "data": [
                {"date": "2026-08-24 00:00:00 +0900", "qty": 8123, "source": "Apple Watch|iPhone"},
                {"date": "2026-08-25 00:00:00 +0900", "qty": 5000, "source": "Apple Watch|iPhone"},
            ]},
            {"name": "heart_rate", "units": "count/min", "data": [
                {"date": "2026-08-24 00:00:00 +0900", "Min": 52, "Max": 140, "Avg": 71.5, "source": "Apple Watch"},
            ]},
            {"name": "sleep_analysis", "units": "hr", "data": [
                {"date": "2026-08-24 00:00:00 +0900", "source": "Apple Watch",
                 "inBedStart": "2026-08-23 23:40:00 +0900", "inBedEnd": "2026-08-24 07:00:00 +0900",
                 "sleepStart": "2026-08-24 00:18:16 +0900", "sleepEnd": "2026-08-24 06:50:00 +0900",
                 "totalSleep": 6.2, "deep": 0.9, "rem": 1.4, "core": 3.9, "awake": 0.3},
            ]},
        ],
        "workouts": [
            {"id": "W-1", "name": "Outdoor Run", "start": "2026-08-24 06:30:00 +0900",
             "end": "2026-08-24 07:00:00 +0900", "duration": 30,
             "distance": {"qty": 5.1, "units": "km"}, "activeEnergy": {"qty": 320, "units": "kcal"},
             "speed": {"qty": 10.2, "units": "km/hr"}, "isIndoor": False, "source": "Apple Watch"},
        ],
        "heartRateNotifications": [
            {"start": "2026-08-24 13:00:00 +0900", "type": "High Heart Rate",
             "heartRate": [{"qty": 120}, {"qty": 131}]},
        ],
    }
}
