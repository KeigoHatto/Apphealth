"""
Health Auto Export (Apple Watch) の書き出しZIPを読み込み、
中身のJSONをパースしてSupabaseにUPSERTするスクリプト（初回データ投入・検証用）。

事前準備:
  pip install -r requirements.txt
  .env に SUPABASE_URL / SUPABASE_KEY を設定（.env.example 参照）

使い方（リポジトリのルートで実行）:
  python -m scripts.import_health_data /path/to/HealthAutoExport_YYYYMMDDHHMMSS.zip
"""

import sys

from app import db, importer


def main(zip_path: str) -> None:
    with open(zip_path, "rb") as f:
        try:
            counts = importer.import_zip(db.get_client(), f)
        except ValueError as e:
            print(e)
            sys.exit(1)
    print("取り込み完了: " + ", ".join(f"{k} {v}件" for k, v in counts.items()))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("使い方: python -m scripts.import_health_data <zipファイルのパス>")
        sys.exit(1)
    main(sys.argv[1])
