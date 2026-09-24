import os

from dotenv import load_dotenv

load_dotenv()

# Neon の接続文字列（例: postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require）
DATABASE_URL = os.environ.get("DATABASE_URL", "")
WEBHOOK_TOKEN = os.environ.get("WEBHOOK_TOKEN", "")
BASIC_AUTH_USER = os.environ.get("BASIC_AUTH_USER", "")
BASIC_AUTH_PASSWORD = os.environ.get("BASIC_AUTH_PASSWORD", "")

# ワークアウトの開始時刻を「何日のワークアウトか」に変換するときのタイムゾーン
APP_TIMEZONE = os.environ.get("APP_TIMEZONE", "Asia/Tokyo")

# Web Push（気分のリマインダー）。python -m scripts.generate_vapid_keys で作る
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
# プッシュサービスが問題のあるときに連絡する先（mailto: か https:）
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")
