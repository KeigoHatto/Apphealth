import os

from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
WEBHOOK_TOKEN = os.environ.get("WEBHOOK_TOKEN", "")
BASIC_AUTH_USER = os.environ.get("BASIC_AUTH_USER", "")
BASIC_AUTH_PASSWORD = os.environ.get("BASIC_AUTH_PASSWORD", "")
