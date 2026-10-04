alter table public.decisions
  add column decision_context jsonb;

update public.decisions
set decision_context = jsonb_build_object(
  'decision_id', id,
  'cart_summary', jsonb_build_object(
    'merchant', cart->>'merchant',
    'total_minor', (cart->>'total_minor')::bigint,
    'currency', cart->>'currency',
    'item_count', jsonb_array_length(cart->'items')
  ),
  'budget', null,
  'matched_rules', '[]'::jsonb,
  'model_signal', null,
  'decisive_factors', jsonb_build_array(jsonb_build_object('code', 'no_policy_match', 'source', 'policy', 'lane', lane)),
  'available_actions', case when action = 'allow' then '["continue"]'::jsonb else '["leave", "save_for_later"]'::jsonb end
)
where decision_context is null;

alter table public.decisions
  alter column decision_context set not null;
