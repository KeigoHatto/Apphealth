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
