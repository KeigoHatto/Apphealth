-- ============================================================
-- Health tracking schema for Postgres 15+（Neon）
-- Health Auto Export (Apple Watch) 用
--
-- アプリ起動時に自動で適用される（何度実行しても安全）。手動で流してもよい。
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
  intensity     smallint check (intensity between 1 and 10),  -- 自己申告の強度スコア 1〜10(任意)
  created_at    timestamptz not null default now()
);
create index if not exists idx_events_date on events (date);
create index if not exists idx_events_category on events (category);

-- 一度だけ流すデータ移行の記録
create table if not exists schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);

-- 強度を 1〜5 から 1〜10 に変更（既存の値は2倍にして目盛りを合わせる）
do $$
begin
  if not exists (select 1 from schema_migrations where name = 'events_intensity_10') then
    alter table events drop constraint if exists events_intensity_check;
    update events set intensity = intensity * 2 where intensity is not null;
    alter table events add constraint events_intensity_check check (intensity between 1 and 10);
    insert into schema_migrations (name) values ('events_intensity_10');
  end if;
end $$;

-- 5b) イベントのテンプレート（よく使う「カテゴリ + 強度 + メモ」を使い回す）
create table if not exists event_templates (
  id          bigserial primary key,
  category    text not null,
  intensity   smallint check (intensity between 1 and 10),
  note        text,
  created_at  timestamptz not null default now(),
  constraint event_templates_key unique nulls not distinct (category, intensity, note)
);

-- 6) 取り込まれている指標の一覧（ダッシュボードのセレクタ用）
create or replace view metric_catalog as
select metric_name,
       max(units)  as units,
       count(*)    as n_rows,
       min(date)   as first_date,
       max(date)   as last_date
from health_metrics
group by metric_name;
