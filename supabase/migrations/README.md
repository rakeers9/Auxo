# Supabase migrations

Migrations are applied in filename order by the Supabase CLI.

The initial migration creates profiles, rules, budgets, merchants, extraction
recipes, decisions, events, purchase check-ins, and passes. User-owned tables
have row-level security policies, while backend-only decision writes use the
service-role client and never expose that credential to the extension.

Apply locally with:

```bash
supabase db reset
```
