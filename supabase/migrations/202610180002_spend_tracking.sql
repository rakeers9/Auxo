-- AUX-31: track budget spend from `bought` events.
--
-- The first `bought` event for a decision adds that decision's cart
-- total_minor to spent_minor of each of the user's budgets in the cart's
-- currency whose period contains the event's occurred_at (UTC date, the same
-- date the policy engine compares budgets against).

-- One purchase per decision. Any existing extra `bought` events for a decision
-- (keeping the earliest received) are removed so the index can be built; the
-- extension sends `bought` once per order, so this should match no rows.
delete from public.events e
using public.events earlier
where e.event_type = 'bought'
  and earlier.event_type = 'bought'
  and earlier.decision_id = e.decision_id
  and (earlier.received_at, earlier.event_id) < (e.received_at, e.event_id);

create unique index events_one_bought_per_decision_idx
  on public.events (decision_id)
  where event_type = 'bought';

-- Inserts an event and, for the first `bought` event of a decision, charges the
-- matching budgets, all in one transaction. Returns 'created' or 'duplicate'
-- (a replayed event_id or a second `bought` for the decision). ON CONFLICT DO
-- NOTHING without a target covers both the primary key and the partial index,
-- and concurrent duplicates wait on the index, so a purchase is counted once.
-- The increment is a single UPDATE ... spent_minor = spent_minor + x, so
-- concurrent purchases never lose an update.
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
      update public.budgets b
      set spent_minor = b.spent_minor + (decision_cart ->> 'total_minor')::bigint
      where b.user_id = p_user_id
        and b.currency = decision_cart ->> 'currency'
        and (p_occurred_at at time zone 'UTC')::date between b.period_start and b.period_end;
    end if;
  end if;

  return 'created';
end;
$$;

-- Only the API (service role) records events through this function. Supabase
-- grants EXECUTE on new public functions to anon and authenticated by default.
revoke execute on function public.record_decision_event(uuid, uuid, uuid, public.decision_event_type, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_decision_event(uuid, uuid, uuid, public.decision_event_type, timestamptz, jsonb)
  to service_role;

-- Clients must not set spent_minor through the anon key. budgets_own_rows was
-- FOR ALL; split it per command, and use column privileges so that signed-in
-- users can only write the columns the budgets API accepts. spent_minor then
-- starts at its default (0) and only changes through record_decision_event
-- (or the service role, which bypasses RLS and keeps full table privileges,
-- so the API's budget CRUD is unaffected). The updated_at trigger isn't
-- subject to column privileges.
drop policy if exists "budgets_own_rows" on public.budgets;

create policy "budgets_select_own"
on public.budgets for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "budgets_insert_own"
on public.budgets for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "budgets_update_own"
on public.budgets for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "budgets_delete_own"
on public.budgets for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke insert, update on public.budgets from anon, authenticated;
grant insert (user_id, currency, limit_minor, period_start, period_end) on public.budgets to authenticated;
grant update (limit_minor) on public.budgets to authenticated;
