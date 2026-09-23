# ヘルスデータ×イベント相関分析Webアプリ 設計まとめ

## 1. 目的
Apple Watchの健康データ（心拍・睡眠・活動量など）と、日々の出来事（飲酒・ストレス・旅行等の自己申告イベント）を突き合わせて、両者の関係を可視化・分析するWebアプリを作る。

## 2. データソース

### 2.1 取得方法
- **アプリ**: Health Auto Export（iOS、開発者: Lybron Sobers）
- **プラン**: Premium（年額 $6.99 ≒ 約1,140円/年）
- **方式**: バックグラウンド自動同期。1日1回、REST API（自前のエンドポイント）にJSONをPOSTさせる
- 手動エクスポート（ZIP、JSON+GPX同梱）も可能。初期データ投入や検証用に使う

### 2.2 データ構造（実データで確認済み）
エクスポートJSONのトップレベルは `data` キー配下に3種類:

- **`metrics`**: 日次メトリクスの配列。1メトリクスにつき `name`, `units`, `data`（日付ごとの値の配列）を持つ。
  - 確認済み指標（32種）: `step_count`, `heart_rate`, `resting_heart_rate`, `heart_rate_variability`, `sleep_analysis`, `active_energy`, `basal_energy_burned`, `walking_running_distance`, `cycling_distance`, `flights_climbed`, `apple_exercise_time`, `apple_stand_time`, `apple_stand_hour`, `respiratory_rate`, `vo2_max`, `walking_speed`, `walking_step_length`, `walking_asymmetry_percentage`, `walking_double_support_percentage`, `walking_heart_rate_average`, `running_speed`, `running_power`, `running_stride_length`, `running_vertical_oscillation`, `running_ground_contact_time`, `stair_speed_up`, `stair_speed_down`, `cardio_recovery`, `time_in_daylight`, `environmental_audio_exposure`, `physical_effort`, `six_minute_walking_test_distance`
  - データ点の形式は指標によって2パターン:
    - シンプル型: `{"date": "...", "qty": 数値, "source": "..."}`（歩数など）
    - 統計型: `{"date": "...", "Min": 数値, "Max": 数値, "Avg": 数値, "source": "..."}`（心拍など）
    - `sleep_analysis`のみ特殊で、`inBedStart/End`, `sleepStart/End`, `deep`, `rem`, `core`, `awake`, `totalSleep`（すべて時間=hr単位）を持つ

- **`workouts`**: ワークアウトの配列。`id`（UUID）, `name`, `start`, `end`, `duration`, `distance{qty,units}`, `activeEnergy{qty,units}`, `speed{qty,units}`, `stepCount[]`（時系列）, `isIndoor`, `source` 等。ランニング・サイクリングはGPXファイル（ルート）が別添される。

- **`heartRateNotifications`**: 心拍異常通知の配列（高心拍/低心拍/不整脈等のアラート、59件確認）。

## 3. データベース設計（Neon / Postgres）

> 2026-09: Supabase の無料プランのプロジェクト数上限に達したため、Neon（素の Postgres）に変更。

`schema.sql` に完全なDDLあり。テーブル構成:

| テーブル | 用途 |
|---|---|
| `health_metrics` | 日次メトリクス（long format）。`qty`列 or `min/max/avg`列のどちらかを使う。生データは`raw` (jsonb) にも保持 |
| `sleep_sessions` | 睡眠セッション専用（`sleep_analysis`から分離） |
| `workouts` | ワークアウト単位のサマリー。GPXファイル名も紐付け |
| `heart_rate_notifications` | 心拍アラート履歴 |
| `events` | **ユーザーが手入力する日々のイベント**。`date`, `category`（例: alcohol/stress/travel等、自由運用）, `note`, `intensity`（1〜5の自己申告強度） |

重複防止のため `health_metrics` は `(date, metric_name, source)`、`sleep_sessions` は `(date, source)` でunique制約。

## 4. データ取り込み

`import_health_data.py`（初回検証済み・動作確認要）:
- ZIPを展開 → JSON読み込み
- `metrics`を`health_metrics`と`sleep_sessions`に振り分けてDBへupsert
- `workouts`をGPXファイル名と突き合わせてupsert
- `heartRateNotifications`をinsert

Premium移行後は、Health Auto Export側から直接REST APIエンドポイントにPOSTされる方式に切り替える想定。その場合、受信用のAPIエンドポイント（例: `POST /webhook/health-export`）を用意し、このスクリプトのロジックを流用してパース・upsertする。

## 5. インフラ構成

```
[iPhone] Health Auto Export (Premium)
   → 1日1回、自動でJSONをPOST
        ↓
[Render] Webサービス（バックエンドAPI）
   - POST /webhook/health-export  ← Health Auto Exportからの自動受信
   - POST /events                 ← 日々のイベント手入力
   - GET  /api/... 系             ← 分析・集計結果を返す
   - 静的ファイル or フロントエンドを同居 or 別ホスティング
        ↓
[Neon] Postgres（無料枠）
```

### コスト
- Health Auto Export Premium（年額）: 約1,140円/年（月あたり約95円）
- Neon: 無料枠で運用（個人の日次データなら十分な容量）
- Render: 無料プランでスタート（Webサービスは非アクティブ時スリープするため、1日1回のWebhook受信用途であれば許容範囲。確実な常時稼働が必要になったら有料プラン $7/月 ≒ 約1,140円/月に切り替え検討）
- **合計: 月あたり約95円〜（Render無料枠利用時）**

### デプロイ方式
- コードはGitHubリポジトリで管理（プライベート推奨、ヘルスデータを扱うため）
- Renderの「New Web Service」でGitHubリポジトリを連携し、Auto-Deployを有効化 → `main`ブランチへのpushで自動反映
- DBの接続文字列（`DATABASE_URL`）はRenderの環境変数として設定し、リポジトリには含めない（`.env`は`.gitignore`に追加）

## 6. 分析の方向性
- イベント発生日を基準に、前後でHRV・安静時心拍・睡眠スコアがどう変化するか（before/after比較）
- イベントカテゴリ別に睡眠スコアや心拍指標の分布を比較
- イベント発生からのラグ（翌日・翌々日に影響が出るか）も考慮する

## 7. 現状の進捗
- [x] Health Auto Exportで手動エクスポート済み（JSON + GPX形式、データ構造確認済み）
- [x] テーブル設計（`schema.sql`）作成済み（Supabase → Neon に移行）
- [x] インポートスクリプト（`import_health_data.py`）作成済み（DBへの実接続・動作確認はこれから）
- [ ] Health Auto ExportをPremiumにアップグレード
- [x] GitHubリポジトリ作成
- [x] Renderバックエンド構築（Webhook受信 / イベント入力API / 分析API）… `app/`（FastAPI）
- [ ] Render⇔GitHub Auto Deploy設定（`render.yaml` は用意済み。Render側でBlueprint作成が必要）
- [x] フロントエンド（ダッシュボード、イベント入力フォーム、相関可視化）構築 … `app/static/`

## 8. 添付ファイル
- `db/schema.sql`: テーブル定義（アプリ起動時に自動適用）
- `scripts/import_health_data.py`: Health Auto ExportのZIPをパースしてDBに投入するスクリプト（ロジックは `app/parsing.py` / `app/importer.py` に共通化）
