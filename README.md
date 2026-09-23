# Apphealth — ヘルスデータ × イベント相関分析

Apple Watch の健康データ（Health Auto Export 経由）と、日々の出来事（飲酒・ストレス・旅行など）を
突き合わせて可視化・分析する個人用 Web アプリ。設計は [docs/health_app_design.md](docs/health_app_design.md)。

```
[iPhone] Health Auto Export ──POST /webhook/health-export──▶ [Render] FastAPI ──▶ [Supabase] Postgres
                                                                 └ / （ダッシュボード・イベント入力・分析）
```

## 構成

| パス | 内容 |
|---|---|
| `app/main.py` | API（Webhook受信・ZIP取り込み・イベントCRUD・メトリクス・分析）と静的ファイル配信 |
| `app/parsing.py` | Health Auto Export JSON → DB行 への変換（純粋関数） |
| `app/importer.py` | 変換した行を Supabase に upsert。Webhook / ZIP / CLI で共通 |
| `app/analysis.py` | イベント前後比較・ラグ分析・カテゴリ別比較 |
| `app/static/` | フロントエンド（素の HTML/JS + Chart.js） |
| `db/schema.sql` | テーブル定義（新規作成用） |
| `db/migrations/001_dedupe_and_rls.sql` | 旧 schema.sql で作成済みの DB 向けマイグレーション |
| `scripts/import_health_data.py` | ZIP を CLI から取り込むスクリプト |
| `render.yaml` | Render Blueprint |

## API

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/webhook/health-export` | Health Auto Export からの自動送信（`Authorization: Bearer <WEBHOOK_TOKEN>`） |
| POST | `/api/import/zip` | 手動エクスポート ZIP のアップロード |
| GET/POST | `/api/events` | イベント一覧 / 作成（`date`, `category`, `note`, `intensity`） |
| PUT/DELETE | `/api/events/{id}` | イベント更新 / 削除 |
| GET | `/api/events/categories` | カテゴリと件数 |
| GET | `/api/metrics/catalog` | 取り込み済み指標の一覧 |
| GET | `/api/metrics/daily?metric=&start=&end=` | 1日1値の系列（`sleep_total` 等の睡眠指標も可） |
| GET | `/api/analysis/event-impact?metric=&category=&window=3` | イベント前後の変化 + ラグ別比較 |
| GET | `/api/analysis/category-comparison?metric=&lag=1` | カテゴリ別の比較 |

`/webhook/*` と `/healthz` 以外は `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` の Basic 認証で保護されます。

### 分析の定義
- **前後の変化**: 各イベントについて直前 `window` 日の平均をベースラインとし、-window〜+window 日の値との差を平均。
- **ラグ別比較**: 「イベント日 + N 日」の値と、どのイベントの 0〜window 日後にも当たらない日の値を比較（差と効果量 Cohen's d）。
- **カテゴリ別比較**: 各カテゴリの「イベント日 + lag 日」の値と、イベントのない日の値を比較。
- 1日1値への集約: 心拍などの統計型は `Avg`、それ以外は `qty`。同じ日に複数 source があれば平均。

## セットアップ

### 1. Supabase
SQL Editor で `db/schema.sql` を実行（既に旧版でテーブルを作っている場合は `db/migrations/001_dedupe_and_rls.sql`）。
RLS を有効にしているため、anon キーではデータにアクセスできません。バックエンドは **service_role キー** を使います。

### 2. ローカル実行
```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env   # 値を埋める
uvicorn app.main:app --reload
pytest
```
初回データ投入は画面の「取り込み」タブか、`python -m scripts.import_health_data <ZIP>`。

### 3. Render
1. Render で **New > Blueprint** → このリポジトリを選択（`render.yaml` が読まれる）
2. `SUPABASE_URL` / `SUPABASE_KEY` / `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` を入力。`WEBHOOK_TOKEN` は自動生成される
3. `main` ブランチへの push で自動デプロイ

### 4. Health Auto Export（Premium）
Automations → REST API を作成:
- URL: `https://<render-app>.onrender.com/webhook/health-export`
- Headers: `Authorization: Bearer <WEBHOOK_TOKEN>`
- Export Format: JSON / Aggregate Data: ON / Period: Day（直近数日分を送る設定にしても upsert なので重複しません）

Render 無料プランはスリープから起動に 30〜60 秒かかるため、初回の同期がタイムアウトした場合は次回同期で取り込まれます。
