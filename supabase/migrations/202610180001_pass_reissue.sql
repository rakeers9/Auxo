-- AUX-29: a decision can get a new pass after its previous one expired.
--
-- unique (decision_id) allowed one pass per decision forever, so a pass could
-- never be reissued. "At most one *active* pass per decision" can't be an
-- index predicate (now() isn't immutable), so the rule is split:
--   * the database allows at most one *unrevoked* pass per decision
--     (partial unique index on revoked_at is null);
--   * the API (SupabasePassRepository.issue) reuses the unrevoked pass while
--     it's unexpired, and otherwise sets revoked_at on the expired one before
--     inserting the new one. Two concurrent issues race on the index: the
--     loser gets 23505 and returns the winner's pass.
-- revoked_at therefore also means "retired after it expired".

do $$
declare
  constraint_name text;
begin
  -- Declared inline without a name, so find it by its single column.
  select con.conname into constraint_name
  from pg_constraint con
  where con.conrelid = 'public.passes'::regclass
    and con.contype = 'u'
    and (
      select array_agg(att.attname::text order by att.attname)
      from unnest(con.conkey) as key(attnum)
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = key.attnum
    ) = array['decision_id'];

  if constraint_name is not null then
    execute format('alter table public.passes drop constraint %I', constraint_name);
  end if;
end
$$;

create unique index passes_one_unrevoked_per_decision_idx
  on public.passes (decision_id)
  where revoked_at is null;

-- Cart hashes are compared lowercase (the shared CartHashSchema lowercases
-- them), and GET /v1/passes/active looks them up with plain equality.
update public.passes
set cart_hash = lower(cart_hash)
where cart_hash <> lower(cart_hash);

update public.decisions
set cart_hash = lower(cart_hash)
where cart_hash <> lower(cart_hash);

alter table public.passes
  add constraint passes_cart_hash_lowercase check (cart_hash = lower(cart_hash));

create index passes_active_lookup_idx
  on public.passes (user_id, cart_hash, expires_at desc)
  where revoked_at is null;
