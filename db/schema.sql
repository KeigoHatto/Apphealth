-- ============================================================
-- Health tracking schema for Supabase (Postgres 15+)
-- Health Auto Export (Apple Watch) 用
--
-- 既にテーブルを作成済みの場合は db/migrations/001_dedupe_and_rls.sql を実行してください。
-- ============================================================

-- 1) 日次メトリクス（歩数・心拍・HRV・活動系など、qty or Min/Max/Avg形式）
create table if not exists health_metrics (
  id            bigserial primary key,
  date          date not null,
  metric_name   text not null,        -- e.g. 'step_count', 'heart_rate'
  qty           numeric,              -- 単純な値を持つ指標用
  min_value     numeric,              -- heart_rate等 Min/Max/Avg形式の指標用
  max_value     numeric,
  avg_value     numeric,
  units         text,
  source        text,
  raw           jsonb,                -- 元データをそのまま保持（後で見返せるように）
  created_at    timestamptz not null default now(),
  -- source が NULL でも重複扱いにする（NULLS NOT DISTINCT は PG15+）
  constraint health_metrics_date_metric_name_source_key
    unique nulls not distinct (date, metric_name, source)
);
create index if not exists idx_health_metrics_date on health_metrics (date);
create index if not exists idx_health_metrics_name_date on health_metrics (metric_name, date);

-- 2) 睡眠セッション
create table if not exists sleep_sessions (
  id              bigserial primary key,
  date            date not null,
  source          text,
  in_bed_start    timestamptz,
  in_bed_end      timestamptz,
  sleep_start     timestamptz,
  sleep_end       timestamptz,
  total_sleep_hr  numeric,
  deep_hr         numeric,
  rem_hr          numeric,
  core_hr         numeric,
  awake_hr        numeric,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  constraint sleep_sessions_date_source_key
    unique nulls not distinct (date, source)
);
create index if not exists idx_sleep_sessions_date on sleep_sessions (date);

-- 3) ワークアウト（ラン・サイクリング等）
create table if not exists workouts (
  id                  text primary key,   -- HealthAutoExportのworkout id (UUID)
  name                text,
  source              text,
  start_time          timestamptz,
  end_time            timestamptz,
  duration_min        numeric,
  distance_qty        numeric,
  distance_units      text,
  active_energy_qty   numeric,
  active_energy_units text,
  avg_speed           numeric,
  speed_units         text,
  is_indoor           boolean,
  gpx_file            text,               -- 対応するGPXファイル名（あれば）
  raw                 jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists idx_workouts_start on workouts (start_time);

-- 4) 心拍アラート通知
--    Webhookは毎日重複した期間を送ってくるので (event_time, notif_type) で重複排除する
create table if not exists heart_rate_notifications (
  id            bigserial primary key,
  event_time    timestamptz,
  notif_type    text,       -- 例: 'High Heart Rate', 'Irregular Rhythm' 等
  heart_rate    numeric,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  constraint heart_rate_notifications_time_type_key
    unique nulls not distinct (event_time, notif_type)
);
create index if not exists idx_hrn_time on heart_rate_notifications (event_time);

-- 5) 日々のイベント（ユーザーが手入力する記録）
create table if not exists events (
  id            bigserial primary key,
  date          date not null,
  category      text not null,    -- 例: 'alcohol', 'stress', 'travel', 'poor_sleep_env' 等、自由に運用
  note          text,
  intensity     smallint check (intensity between 1 and 5),  -- 自己申告の強度スコア(任意)
  created_at    timestamptz not null default now()
);
create index if not exists idx_events_date on events (date);
create index if not exists idx_events_category on events (category);

-- 6) 取り込まれている指標の一覧（ダッシュボードのセレクタ用）
create or replace view metric_catalog with (security_invoker = true) as
select metric_name,
       max(units)  as units,
       count(*)    as n_rows,
       min(date)   as first_date,
       max(date)   as last_date
from health_metrics
group by metric_name;

-- ============================================================
-- Row Level Security
-- バックエンドは service_role キーで接続する（service_role は RLS をバイパスする）。
-- RLS を有効にしてポリシーを作らないことで、anon キー経由の読み書きを全て拒否する。
-- （RLSがオフだと、anonキーを知っている人は誰でもヘルスデータを読めてしまう）
-- ============================================================
alter table health_metrics           enable row level security;
alter table sleep_sessions           enable row level security;
alter table workouts                 enable row level security;
alter table heart_rate_notifications enable row level security;
alter table events                   enable row level security;
