-- 旧 schema.sql で既にテーブルを作成済みの場合に実行するマイグレーション。
--  * source が NULL の行も重複扱いにする（NULLS NOT DISTINCT）
--  * heart_rate_notifications に重複排除用のユニーク制約を追加
--  * metric_catalog ビューを追加
--  * RLS を有効化（anon キーからのアクセスを遮断）

-- 既存の重複行を掃除（id が大きい＝新しい方を残す）
delete from health_metrics a using health_metrics b
 where a.id < b.id and a.date = b.date and a.metric_name = b.metric_name
   and a.source is not distinct from b.source;
delete from sleep_sessions a using sleep_sessions b
 where a.id < b.id and a.date = b.date and a.source is not distinct from b.source;
delete from heart_rate_notifications a using heart_rate_notifications b
 where a.id < b.id and a.event_time is not distinct from b.event_time
   and a.notif_type is not distinct from b.notif_type;

alter table health_metrics drop constraint if exists health_metrics_date_metric_name_source_key;
alter table health_metrics add constraint health_metrics_date_metric_name_source_key
  unique nulls not distinct (date, metric_name, source);

alter table sleep_sessions drop constraint if exists sleep_sessions_date_source_key;
alter table sleep_sessions add constraint sleep_sessions_date_source_key
  unique nulls not distinct (date, source);

alter table heart_rate_notifications drop constraint if exists heart_rate_notifications_time_type_key;
alter table heart_rate_notifications add constraint heart_rate_notifications_time_type_key
  unique nulls not distinct (event_time, notif_type);

drop index if exists idx_health_metrics_name;
create index if not exists idx_health_metrics_name_date on health_metrics (metric_name, date);

create or replace view metric_catalog with (security_invoker = true) as
select metric_name,
       max(units)  as units,
       count(*)    as n_rows,
       min(date)   as first_date,
       max(date)   as last_date
from health_metrics
group by metric_name;

alter table health_metrics           enable row level security;
alter table sleep_sessions           enable row level security;
alter table workouts                 enable row level security;
alter table heart_rate_notifications enable row level security;
alter table events                   enable row level security;
