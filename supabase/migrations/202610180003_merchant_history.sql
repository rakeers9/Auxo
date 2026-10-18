-- AUX-34: the user's recent history at a merchant, read into /v1/decide
-- (DecisionContext.history) and passed to the decision model.
--
-- Returns counts over the window [p_since, p_until] (both inclusive); the API
-- turns them into rates (apps/api/src/repositories/supabase-history-repository.ts).
-- Same definitions as computeMerchantHistory in history-repository.ts:
--   purchases      `bought` events in the window whose decision's cart merchant
--                  matches p_merchant case-insensitively
--   spent_minor    those purchases' cart total_minor, p_currency carts only
--   check_ins      check-ins answered in the window on decisions at the merchant
--   regrets        of those, answered 'regret'
--   guarded        paused or blocked decisions at the merchant created in the window
--   overridden     of those, ones with an `overrode` event
--
-- Each part is driven by an existing (user_id, time) index: events by
-- events_user_occurred_at_idx, check-ins by check_ins_user_answered_at_idx,
-- decisions by decisions_user_created_at_idx, overrides by
-- events_decision_id_idx; decisions are joined on their primary key.
create or replace function public.merchant_history(
  p_user_id uuid,
  p_merchant text,
  p_currency text,
  p_since timestamptz,
  p_until timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with bought as (
    select d.cart
    from public.events e
    join public.decisions d on d.id = e.decision_id and d.user_id = e.user_id
    where e.user_id = p_user_id
      and e.event_type = 'bought'
      and e.occurred_at between p_since and p_until
      and lower(d.cart ->> 'merchant') = lower(p_merchant)
  ),
  answered as (
    select c.worth_it
    from public.check_ins c
    join public.decisions d on d.id = c.decision_id and d.user_id = c.user_id
    where c.user_id = p_user_id
      and c.answered_at between p_since and p_until
      and lower(d.cart ->> 'merchant') = lower(p_merchant)
  ),
  guarded as (
    select exists (
      select 1
      from public.events o
      where o.decision_id = d.id
        and o.user_id = p_user_id
        and o.event_type = 'overrode'
    ) as overridden
    from public.decisions d
    where d.user_id = p_user_id
      and d.created_at between p_since and p_until
      and d.action in ('pause', 'block')
      and lower(d.cart ->> 'merchant') = lower(p_merchant)
  )
  select jsonb_build_object(
    'purchases', (select count(*) from bought),
    'spent_minor', (
      select coalesce(sum((cart ->> 'total_minor')::bigint), 0)
      from bought
      where cart ->> 'currency' = p_currency
    ),
    'check_ins', (select count(*) from answered),
    'regrets', (select count(*) from answered where worth_it = 'regret'),
    'guarded', (select count(*) from guarded),
    'overridden', (select count(*) from guarded where overridden)
  );
$$;

-- Only the API (service role) reads history through this function. Supabase
-- grants EXECUTE on new public functions to anon and authenticated by default.
revoke execute on function public.merchant_history(uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.merchant_history(uuid, text, text, timestamptz, timestamptz)
  to service_role;
