-- ============================================================================
-- INBOUND SERVICE LINE (PLAN.md §16)
--
-- Service calls coming into the dealership route to the agent: it identifies the caller from
-- their phone number, answers questions about the services we own, recommends what's coming due
-- on their cars, and transfers to a service employee for anything out of scope ("where is my car").
--
-- Additive only — nothing here changes existing outbound behavior. `calls.touchpoint_id` was
-- already nullable, which is what lets an inbound call exist with no scheduled work behind it.
-- ============================================================================

-- ── Inbound calls are first-class `calls` rows (§16e) ───────────────────────
-- Existing rows are outbound by construction, hence the default + backfill-free NOT NULL.
alter table calls
  add column direction text not null default 'outbound'
    check (direction in ('outbound', 'inbound')),
  add column from_number text;                 -- E.164 the inbound call came from

create index calls_direction on calls (company_id, direction, created_at desc);

-- ── Services catalog: "the services we own" (§16c) ──────────────────────────
-- Structured and dealership-edited, NOT RAG — controllable, and can't surface stale doc text.
-- Deliberately NO price column: the no-invented-pricing guardrail (§8) holds on inbound, and a
-- quoted price is a commitment the dealership has to honor. Adding prices later = a column + a
-- guardrail flip.
create table service_offerings (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,                          -- "Brake pad replacement"
  description text,                            -- what it is / what's involved, in plain language
  category text,                               -- maintenance | repair | inspection | tires | ...
  operations text[] not null default '{}',     -- op codes / line items, aligns with service_intervals.operations
  typical_duration_min int,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index service_offerings_company on service_offerings (company_id, active);

-- ── Handoff queue (§16b) ────────────────────────────────────────────────────
-- Written when the agent transfers, and ALWAYS written when a transfer doesn't connect, so a
-- caller is never dropped. `customer_id` is null for anonymous callers (§16a).
create table handoff_requests (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  call_id uuid references calls(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  caller_number text,
  reason text not null default 'other'
    check (reason in ('where_is_my_car','pricing','complaint','requested_human','out_of_scope','other')),
  vehicle_hint text,                           -- free text the caller gave ("the silver RAV4")
  notes text,
  transferred boolean not null default false,  -- false = transfer failed/skipped → advisor must call back
  status text not null default 'open' check (status in ('open','resolved')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index handoff_requests_queue on handoff_requests (company_id, status, created_at desc);

-- ── RLS: standard tenant policies (§8 invariant 4) ──────────────────────────
alter table service_offerings enable row level security;
alter table handoff_requests enable row level security;

do $$
declare t text;
begin
  foreach t in array array['service_offerings','handoff_requests']
  loop
    execute format('create policy tenant_select on %I for select using (company_id in (select my_company_ids()));', t);
    execute format('create policy tenant_insert on %I for insert with check (company_id in (select my_company_ids()));', t);
    execute format('create policy tenant_update on %I for update using (company_id in (select my_company_ids()));', t);
  end loop;
end $$;

-- ── Inbound caller identification (§16a) ────────────────────────────────────
-- Resolves the receiving pool number → the dealership that owns it, then the caller's number →
-- exactly one customer of THAT dealership.
--
-- The count is returned so the caller can distinguish "no match" from "ambiguous": BOTH fall back
-- to an anonymous call. A shared household/work number must never cause the agent to read the
-- wrong person's vehicle history — so >1 match is treated as no match, not as "pick the first".
create or replace function identify_inbound_caller(p_to_number text, p_from_number text)
returns table (company_id uuid, customer_id uuid, match_count bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  v_company_id uuid;
  v_count bigint;
  v_customer_id uuid;
  v_digits text;
begin
  -- Which dealership owns the number that was dialed?
  select pn.company_id into v_company_id
  from phone_numbers pn
  where pn.e164 = p_to_number
  limit 1;

  if v_company_id is null then
    return;                                     -- unknown destination → no rows; caller handles it
  end if;

  -- Compare on digits only: stored numbers may vary in formatting across import sources.
  v_digits := regexp_replace(coalesce(p_from_number, ''), '\D', '', 'g');

  if length(v_digits) < 10 then                 -- blocked/withheld caller ID → anonymous
    return query select v_company_id, null::uuid, 0::bigint;
    return;
  end if;

  -- Count matches and keep one id. There is no min(uuid) in Postgres, so aggregate the ids into
  -- an array and take the first — the id is only used when the count is exactly 1 anyway.
  select count(*), (array_agg(c.id))[1] into v_count, v_customer_id
  from customers c
  where c.company_id = v_company_id
    and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10);

  -- Exactly one match identifies the caller; zero or many stay anonymous.
  return query select
    v_company_id,
    case when v_count = 1 then v_customer_id else null::uuid end,
    v_count;
end $$;
