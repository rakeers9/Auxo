-- AUX-47: why the extension couldn't read a page, as codes only, so reader
-- failures become a ranked to-do list (POST /v1/read-failures).
--
-- Privacy (decisions log: collect what the purpose needs, nothing we merely
-- can see): no user_id, no URL, no item, price, or page text, and no time
-- finer than the UTC day. The API validates every report against
-- ReadFailureReportSchema (packages/shared/read-failures.ts); the checks
-- below only keep the shape if anything else ever writes here. Codes and
-- readers aren't listed in the database, so a new code needs no migration.
create table public.read_failures (
  id bigint generated always as identity primary key,
  day date not null,
  reader text not null check (reader ~ '^[a-z][a-z_]{0,39}$'),
  page_type text not null check (page_type ~ '^[a-z][a-z_]{0,39}$'),
  store_host text check (store_host is null or char_length(store_host) between 1 and 253),
  extension_version text not null check (extension_version ~ '^[0-9]{1,9}(\.[0-9]{1,9}){0,3}$'),
  codes text[] not null check (
    cardinality(codes) between 1 and 20
    and array_position(codes, null) is null
  )
);

create index read_failures_day_idx on public.read_failures (day);

-- RLS on with no policies: only the API's service role (which bypasses RLS)
-- writes or reads these rows. Table grants are revoked too, so the anon key
-- can't even see that the table exists.
alter table public.read_failures enable row level security;
revoke all on table public.read_failures from public, anon, authenticated;

-- The to-do list: each reader's failure codes over the last 30 days, most
-- reported first. A report with several codes counts once for each code.
create view public.read_failure_ranking
with (security_invoker = true)
as
select
  f.reader,
  code,
  count(*) as reports,
  count(distinct f.day) as days_seen,
  max(f.day) as last_seen,
  array_agg(distinct f.page_type order by f.page_type) as page_types,
  array_agg(distinct f.extension_version order by f.extension_version) as extension_versions
from public.read_failures f
cross join lateral unnest(f.codes) as code
where f.day > current_date - 30
group by f.reader, code
order by reports desc, days_seen desc, f.reader, code;

revoke all on table public.read_failure_ranking from public, anon, authenticated;
grant select on table public.read_failure_ranking to service_role;
