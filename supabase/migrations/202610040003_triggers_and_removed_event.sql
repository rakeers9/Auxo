-- What prompted each decision: a buy-intent click (add to cart, buy now,
-- checkout, ...) or a cart/checkout page view. Null for older clients.
alter table public.decisions
  add column trigger jsonb;

-- The user took an item out of the cart after a decision. Added on its own:
-- a new enum value can't be used in the same transaction that adds it.
alter type public.decision_event_type add value if not exists 'removed' before 'bought';
