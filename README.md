# Apphealth — ヘルスデータ × イベント相関分析

Apple Watch の健康データ（Health Auto Export 経由）と、日々の出来事（飲酒・ストレス・旅行など）を
突き合わせて可視化・分析する個人用 Web アプリ。設計は [docs/health_app_design.md](docs/health_app_design.md)。

```
[iPhone] Health Auto Export ──POST /webhook/health-export──▶ [Render] FastAPI ──▶ [Neon] Postgres
                                                                 └ / （ダッシュボード・イベント入力・分析）
```

## 構成

| パス | 内容 |
|---|---|
| `app/main.py` | API（Webhook受信・ZIP取り込み・イベントCRUD・メトリクス・分析）と静的ファイル配信 |
| `app/parsing.py` | Health Auto Export JSON → DB行 への変換（純粋関数） |
| `app/importer.py` | 変換した行を DB に upsert（1回の取り込みは1トランザクション）。Webhook / ZIP / CLI で共通 |
| `app/db.py` | Postgres 接続プール・スキーマ適用・upsert |
| `app/analysis.py` | イベント前後比較・ラグ分析・カテゴリ別比較 |
| `app/static/` | フロントエンド（素の HTML/JS + Chart.js） |
| `db/schema.sql` | テーブル定義（アプリ起動時に自動適用。何度実行しても安全） |
| `scripts/import_health_data.py` | ZIP を CLI から取り込むスクリプト |
| `render.yaml` | Render Blueprint |

## API

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/webhook/health-export` | Health Auto Export からの自動送信（`Authorization: Bearer <WEBHOOK_TOKEN>`） |
| POST | `/api/import/zip` | 手動エクスポート ZIP のアップロード |
| GET/POST | `/api/events` | イベント一覧 / 作成（`date`, `category`, `note`, `intensity` 1〜10） |
| POST | `/api/events/bulk` | 一括登録（`{"events": [...], "skip_duplicates": true}`。同じ日・同じカテゴリは既定でスキップ） |
| POST | `/api/events/bulk-delete` | 一括削除（`{"ids": [...]}`。一括登録の取り消し用） |
| GET/POST | `/api/event-templates` | テンプレート（カテゴリ + 強度 + メモ）一覧 / 作成（同じ内容なら既存を返す） |
| DELETE | `/api/event-templates/{id}` | テンプレート削除 |
| PUT/DELETE | `/api/events/{id}` | イベント更新 / 削除 |
| GET | `/api/events/categories` | カテゴリと件数・最終記録日・前回の強度 |
| GET | `/api/metrics/catalog` | 取り込み済み指標の一覧 |
| GET | `/api/metrics/daily?metric=&start=&end=` | 1日1値の系列（`sleep_total` 等の睡眠指標も可） |
| GET | `/api/workouts?start=&end=&name=` | ワークアウト一覧（`date` と `start_local` は `APP_TIMEZONE` 基準） |
| GET | `/api/workouts/types` | ワークアウトの種類ごとの回数・合計時間 |
| GET | `/api/occurrences?start=&end=&category=&kind=` | イベントとワークアウトを日付ごとにまとめた一覧 |
| GET | `/api/analysis/categories` | 分析に使えるカテゴリ（イベント + `workout:<種類>`） |
| GET | `/api/analysis/event-impact?metric=&category=&window=3` | イベント（またはワークアウト）前後の変化 + ラグ別比較 |
| GET | `/api/analysis/category-comparison?metric=&lag=1&kind=event` | カテゴリ別の比較（`kind=workout` でワークアウトの種類別） |
| GET | `/api/analysis/workout-dose?metric=&lag=1&name=` | その日の運動時間と N 日後の指標の関係（区分別の平均・相関係数） |
| GET | `/api/analysis/run-intensity?metric=&measure=load&lag=1&name=` | ランの強度（`load`=距離×速度 / `distance` / `speed` / `duration`）で日を なし・低・中・高 に分けた比較 |

`event-impact` / `category-comparison` / `occurrences` / `workouts` は `run_measure`（既定 `load`）を受け取り、ランに強度スコアを付けます。

`/webhook/*` と `/healthz` 以外は `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` の Basic 認証で保護されます。

### 分析の定義
- **前後の変化**: 各イベントについて直前 `window` 日の平均をベースラインとし、-window〜+window 日の値との差を平均。
- **ラグ別比較**: 「イベント日 + N 日」の値と、どのイベントの 0〜window 日後にも当たらない日の値を比較（差と効果量 Cohen's d）。
- **カテゴリ別比較**: 各カテゴリの「イベント日 + lag 日」の値と、イベントのない日の値を比較。
- **ワークアウト**: 各ワークアウトを `workout:<種類>` というカテゴリの出来事として扱うので、上の分析がそのまま使える。
  ワークアウト時間は開始〜終了時刻から計算する。
- **強度（1〜10）**: 手入力イベントは入力値。ランは `run_measure` で選んだ基準（距離×速度・距離・速度・時間）で
  全ランを並べた順位を 1〜10 にした値（上位10%が10）。強度の絞り込みはこの2つに適用し、ラン以外のワークアウトには適用しない。
  1〜5 だった頃の記録は、初回起動時に一度だけ2倍にして 1〜10 に揃える。
- **ランの強度と指標**: 速度は 距離÷時間（取れなければ記録された平均速度）、単位は km・km/h に揃える。
  ランした日を強度の三分位で 低・中・高 に分け、ランしなかった日と N 日後の指標を比較。相関係数はランした日だけで計算。
- **運動時間と指標**: その日の運動時間の合計（なし / 1〜30分 / 31〜60分 / 61分以上）で日を分け、N 日後の指標の平均を比較。相関係数も表示。
  ワークアウト記録の最初の日より前は対象外。
- 1日1値への集約: 心拍などの統計型は `Avg`、それ以外は `qty`。同じ日に複数 source があれば平均。

## セットアップ

### 1. Neon
1. https://neon.tech でプロジェクトを作成（リージョンは Render と近い場所、例: AWS Singapore / Tokyo）
2. ダッシュボードの **Connect** から接続文字列（`postgresql://...?sslmode=require`）をコピー
3. テーブル作成は不要（アプリ起動時に `db/schema.sql` が自動で適用されます）

Neon は使われていない間は計算資源を止めるため、止まった後の最初のリクエストは少し遅くなります（通常1秒未満）。

### 2. ローカル実行
```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env   # DATABASE_URL などを埋める
uvicorn app.main:app --reload
```
初回データ投入は画面の「取り込み」タブか、`python -m scripts.import_health_data <ZIP>`。

テスト: 解析ロジックのテストはそのまま、API テストは `TEST_DATABASE_URL` を設定したときだけ実行されます
（毎回テーブルを TRUNCATE するので、本番とは別の DB か Neon のブランチを指定してください）。
```bash
TEST_DATABASE_URL=postgresql://... pytest
```

### 3. Render
1. Render で **New > Blueprint** → このリポジトリを選択（`render.yaml` が読まれる）
2. `DATABASE_URL` / `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` を入力。`WEBHOOK_TOKEN` は自動生成される
3. `main` ブランチへの push で自動デプロイ

### 4. Health Auto Export（Premium）
Automations → REST API を作成:
- URL: `https://<render-app>.onrender.com/webhook/health-export`
- Headers: `Authorization: Bearer <WEBHOOK_TOKEN>`
- Export Format: JSON / Aggregate Data: ON / Period: Day（直近数日分を送る設定にしても upsert なので重複しません）

Render 無料プランはスリープから起動に 30〜60 秒かかるため、初回の同期がタイムアウトした場合は次回同期で取り込まれます。
