-- Repeating budgets.
--
-- A budget's booked period (period_start..period_end, both included) can now
-- repeat: the same number of days starts again the day after each cycle ends,
-- forever, with the same limit and spending reset to 0. A Nov 1-5 budget runs
-- Nov 1-5, Nov 6-10, Nov 11-15, and so on.
--
-- spent_minor counts one cycle, the one starting on spent_period_start (null
-- means the booked period_start). The reset is lazy: a purchase in a later
-- cycle starts the count over, and the API shows 0 for a budget whose spending
-- is from an earlier cycle. The API mirrors this in
-- apps/api/src/services/budget-period.ts; change both together.

alter table public.budgets
  add column repeats boolean not null default false,
  add column spent_period_start date;

-- The first day of the budget cycle that contains p_day. That's the booked
-- start for a budget that doesn't repeat, and for any day on or before its
-- booked end. date - date is an integer number of days, and integer division
-- rounds toward zero, which is a floor here because p_day > p_period_end.
create or replace function public.budget_cycle_start(
  p_period_start date,
  p_period_end date,
  p_repeats boolean,
  p_day date
)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when not p_repeats or p_day <= p_period_end then p_period_start
    else p_period_start
      + ((p_day - p_period_start) / (p_period_end - p_period_start + 1)) * (p_period_end - p_period_start + 1)
  end
$$;

-- Same as 202610180002_spend_tracking.sql, except for how budgets are
-- charged: a purchase counts toward the cycle of each budget that contains
-- it. It's skipped before a budget starts, after a one-off budget ends, and
-- for a cycle older than the one being counted (a late event).
create or replace function public.record_decision_event(
  p_event_id uuid,
  p_user_id uuid,
  p_decision_id uuid,
  p_event_type public.decision_event_type,
  p_occurred_at timestamptz,
  p_metadata jsonb
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted_count integer;
  decision_cart jsonb;
  purchase_day date;
  amount bigint;
begin
  insert into public.events (event_id, user_id, decision_id, event_type, occurred_at, metadata)
  values (p_event_id, p_user_id, p_decision_id, p_event_type, p_occurred_at, coalesce(p_metadata, '{}'::jsonb))
  on conflict do nothing;

  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    return 'duplicate';
  end if;

  if p_event_type = 'bought' then
    select d.cart into decision_cart
    from public.decisions d
    where d.id = p_decision_id and d.user_id = p_user_id;

    if decision_cart is not null then
      purchase_day := (p_occurred_at at time zone 'UTC')::date;
      amount := (decision_cart ->> 'total_minor')::bigint;

      update public.budgets b
      set spent_minor = case
            when public.budget_cycle_start(b.period_start, b.period_end, b.repeats, purchase_day)
              = coalesce(b.spent_period_start, b.period_start)
            then b.spent_minor + amount
            else amount
          end,
          spent_period_start = public.budget_cycle_start(b.period_start, b.period_end, b.repeats, purchase_day)
      where b.user_id = p_user_id
        and b.currency = decision_cart ->> 'currency'
        and purchase_day >= b.period_start
        and (b.repeats or purchase_day <= b.period_end)
        and public.budget_cycle_start(b.period_start, b.period_end, b.repeats, purchase_day)
          >= coalesce(b.spent_period_start, b.period_start);
    end if;
  end if;

  return 'created';
end;
$$;

-- CREATE OR REPLACE keeps the existing grants; restated so this file reads on
-- its own. Only the API (service role) records events.
revoke execute on function public.record_decision_event(uuid, uuid, uuid, public.decision_event_type, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_decision_event(uuid, uuid, uuid, public.decision_event_type, timestamptz, jsonb)
  to service_role;

-- Signed-in users may set `repeats` like the other columns the budgets API
-- accepts. spent_period_start, like spent_minor, changes only through
-- record_decision_event or the service role.
grant insert (repeats) on public.budgets to authenticated;
grant update (repeats) on public.budgets to authenticated;
