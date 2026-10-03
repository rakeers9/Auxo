create extension if not exists pgcrypto;

create type public.decision_lane as enum ('L0', 'L1', 'L2', 'L3', 'L4');
create type public.decision_action as enum ('allow', 'pause', 'block');
create type public.decision_event_type as enum (
  'left',
  'saved',
  'overrode',
  'bought'
);
create type public.purchase_check_in as enum ('yes', 'meh', 'regret');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'full_name', email)
from auth.users
on conflict (id) do nothing;

create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  version integer not null check (version > 0),
  selectors jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, version)
);

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  rule_type text not null,
  configuration jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rules_user_id_idx on public.rules (user_id);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  limit_minor bigint not null check (limit_minor >= 0),
  spent_minor bigint not null default 0 check (spent_minor >= 0),
  period_start date not null,
  period_end date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (user_id, currency, period_start, period_end)
);

create index budgets_user_period_idx
  on public.budgets (user_id, period_start, period_end);

create table public.decisions (
  id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  cart_hash text not null check (cart_hash ~ '^(sha256:)?[A-Fa-f0-9]{64}$'),
  cart jsonb not null,
  lane public.decision_lane not null,
  action public.decision_action not null,
  template_id text not null,
  cooldown_seconds integer not null check (cooldown_seconds >= 0),
  policy_version text not null,
  model_provider text,
  model_version text,
  model_output jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (id, user_id),
  unique (user_id, cart_hash, policy_version)
);

create index decisions_user_created_at_idx
  on public.decisions (user_id, created_at desc);
create index decisions_lookup_idx
  on public.decisions (user_id, cart_hash, policy_version, expires_at);

create table public.events (
  event_id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  decision_id uuid not null,
  event_type public.decision_event_type not null,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  foreign key (decision_id, user_id)
    references public.decisions (id, user_id) on delete cascade
);

create index events_user_occurred_at_idx
  on public.events (user_id, occurred_at desc);
create index events_decision_id_idx on public.events (decision_id);

create table public.check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  decision_id uuid not null,
  worth_it public.purchase_check_in not null,
  note text check (char_length(note) <= 500),
  answered_at timestamptz not null,
  received_at timestamptz not null default now(),
  foreign key (decision_id, user_id)
    references public.decisions (id, user_id) on delete cascade,
  unique (decision_id)
);

create index check_ins_user_answered_at_idx
  on public.check_ins (user_id, answered_at desc);

create table public.passes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  decision_id uuid not null,
  cart_hash text not null check (cart_hash ~ '^(sha256:)?[A-Fa-f0-9]{64}$'),
  merchant text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > issued_at),
  foreign key (decision_id, user_id)
    references public.decisions (id, user_id) on delete cascade,
  unique (decision_id)
);

create index passes_user_expires_at_idx
  on public.passes (user_id, expires_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger merchants_set_updated_at
before update on public.merchants
for each row execute function public.set_updated_at();

create trigger recipes_set_updated_at
before update on public.recipes
for each row execute function public.set_updated_at();

create trigger rules_set_updated_at
before update on public.rules
for each row execute function public.set_updated_at();

create trigger budgets_set_updated_at
before update on public.budgets
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.merchants enable row level security;
alter table public.recipes enable row level security;
alter table public.rules enable row level security;
alter table public.budgets enable row level security;
alter table public.decisions enable row level security;
alter table public.events enable row level security;
alter table public.check_ins enable row level security;
alter table public.passes enable row level security;

create policy "profiles_select_own"
on public.profiles for select
using ((select auth.uid()) = id);

create policy "profiles_update_own"
on public.profiles for update
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "authenticated_read_merchants"
on public.merchants for select
to authenticated
using (true);

create policy "authenticated_read_recipes"
on public.recipes for select
to authenticated
using (true);

create policy "rules_own_rows"
on public.rules for all
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "budgets_own_rows"
on public.budgets for all
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "decisions_select_own"
on public.decisions for select
using ((select auth.uid()) = user_id);

create policy "events_select_own"
on public.events for select
using ((select auth.uid()) = user_id);

create policy "events_insert_own"
on public.events for insert
with check ((select auth.uid()) = user_id);

create policy "check_ins_select_own"
on public.check_ins for select
using ((select auth.uid()) = user_id);

create policy "check_ins_insert_own"
on public.check_ins for insert
with check ((select auth.uid()) = user_id);

create policy "passes_select_own"
on public.passes for select
using ((select auth.uid()) = user_id);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  return new;
end;
$$;

create trigger create_profile_after_signup
after insert on auth.users
for each row execute function public.create_profile_for_new_user();
