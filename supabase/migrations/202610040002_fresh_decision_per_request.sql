-- Every /v1/decide request is analyzed fresh and stored as its own decision,
-- so the same cart (same user, hash, and policy version) can now appear many
-- times. Drop the unique constraint on those columns. It was declared inline
-- without a name, so look it up by its columns instead of guessing the
-- generated name. The lookup index stays: it answers "how often was this
-- cart seen".
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  where con.conrelid = 'public.decisions'::regclass
    and con.contype = 'u'
    and (
      select array_agg(att.attname::text order by att.attname)
      from unnest(con.conkey) as key(attnum)
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = key.attnum
    ) = array['cart_hash', 'policy_version', 'user_id'];

  if constraint_name is not null then
    execute format('alter table public.decisions drop constraint %I', constraint_name);
  end if;
end
$$;
