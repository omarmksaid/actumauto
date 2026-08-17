-- Touchpoint Center: AI service-reminder platform for dealership service departments.
-- All tenant tables carry company_id (= dealership); RLS enforces isolation via memberships.
-- Backend workers use the service-role key and bypass RLS.
--
-- This migration stands up a NEW Supabase database. Run it in order, then seed.example.sql.
-- Design source of truth: PLAN.md (§2 domain model, §4b/4c/5b durability, §14 analytics).

create extension if not exists "uuid-ossp";

-- ============================================================================
-- TENANCY
-- ============================================================================
create table companies (
  id uuid primary key default uuid_generate_v4(),
  name text not null,                       -- dealership name, e.g. "Milpitas Toyota"
  timezone text not null default 'America/Los_Angeles',
  settings jsonb not null default '{}',     -- branding, voice/behavior prompt, customer-type config
  -- Per-dealership kill switch, re-read at dial time (§4b) so "stop everything" is seconds to effect.
  dial_enabled boolean not null default true,
  -- Billing/plan (operator portal).
  plan text not null default 'pilot',
  billing_status text not null default 'active',
  created_at timestamptz not null default now()
);

create table memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role text not null default 'advisor' check (role in ('owner','admin','advisor')),
  email text,
  phone text,
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

-- Team invites (admin invites service advisors under a dealership).
create table invites (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  email text not null,
  role text not null default 'advisor' check (role in ('owner','admin','advisor')),
  token text not null unique,
  invited_by uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- Platform operators (cross-dealership). Independent of memberships.
create table platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- CUSTOMERS & VEHICLES  (§2)
-- ============================================================================
create table customers (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  -- Required fields.
  full_name text not null,
  email text,
  phone text,                               -- E.164 (coerced at import)
  -- Profiling / extensible.
  customer_type text,                       -- loyal | lapsed | new | vip | ... (configurable in settings)
  tags text[] not null default '{}',
  detected_language text,
  personality jsonb not null default '{}',  -- synthesized from past conversations
  profile jsonb not null default '{}',      -- extensible bag for future fields
  notes text,
  do_not_contact boolean not null default false,
  opted_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_company on customers (company_id);
create index customers_phone on customers (company_id, phone);
create index customers_email on customers (company_id, email);

create table vehicles (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  -- Required fields.
  make text not null,
  model text not null,
  year int not null,
  sold_on date,                             -- purchase date
  mileage int,                              -- odometer at mileage_as_of
  -- Mileage tracking that fixes the cold-start problem (§2 vehicles).
  mileage_as_of date,                       -- when the odometer reading was taken (NOT the CSV export date)
  last_service_on date,
  mileage_at_last_service int,
  avg_miles_per_day numeric,                -- DERIVED (real slope if 2 points, else observed blended w/ fleet prior)
  vin text,
  trim text,
  vehicle_profile jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index vehicles_company on vehicles (company_id);
create index vehicles_customer on vehicles (customer_id);
create index vehicles_vin on vehicles (company_id, vin);
create index vehicles_makemodel on vehicles (make, model, year);

-- Accumulates every odometer snapshot we see (CSV, service record, in-call mention),
-- so the avg_miles_per_day slope improves over time.
create table vehicle_mileage (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  mileage int not null,
  observed_on date not null,
  source text not null default 'csv',       -- csv | service | call | manual
  created_at timestamptz not null default now()
);
create index vehicle_mileage_vehicle on vehicle_mileage (vehicle_id, observed_on);

-- ============================================================================
-- SERVICE SCHEDULES  (§2) — seeded from researched public Toyota intervals; extensible to any make.
-- ============================================================================
create table service_schedules (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid references companies(id) on delete cascade,  -- null = platform-global default (seeded)
  make text not null,
  model text,                               -- null = applies to all models of the make
  year_from int,
  year_to int,
  source text,                              -- provenance for the "verify with dealer" caveat
  notes text,
  created_at timestamptz not null default now()
);
create index service_schedules_lookup on service_schedules (make, model, year_from, year_to);

create table service_intervals (
  id uuid primary key default uuid_generate_v4(),
  schedule_id uuid not null references service_schedules(id) on delete cascade,
  mileage int,                              -- e.g. 5000, 10000 (either mileage OR months triggers)
  months int,                               -- e.g. 6, 12
  service_name text not null,               -- "Oil & filter, tire rotation, multi-point inspection"
  operations text[] not null default '{}',
  severity text not null default 'standard' check (severity in ('standard','major','safety')),
  created_at timestamptz not null default now()
);
create index service_intervals_schedule on service_intervals (schedule_id, mileage, months);

-- ============================================================================
-- IMPORTS & CAMPAIGNS  (§2, §3)
-- ============================================================================
create table imports (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  filename text not null,
  storage_path text,                        -- Supabase Storage `imports` bucket
  kind text not null default 'customers' check (kind in ('customers','ro')),  -- ro = shown-RO re-import (§6b)
  column_map jsonb not null default '{}',   -- { target_field: source_header }
  row_count int,
  status text not null default 'parsing' check (status in ('parsing','mapped','importing','done','failed')),
  error text,
  stats jsonb not null default '{}',        -- per-row errors, dupes, coercion notes
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index imports_company on imports (company_id, created_at desc);

create table campaigns (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  import_id uuid references imports(id),
  cadence_id uuid,                          -- FK added after cadences table below
  name text not null,
  status text not null default 'draft' check (status in ('draft','active','paused','done')),
  targeting jsonb not null default '{}',
  pacing jsonb not null default '{}',       -- per-campaign overrides
  created_at timestamptz not null default now()
);
create index campaigns_company on campaigns (company_id);

-- Per-dealership follow-up settings (defaults seeded; editable in Settings). Campaigns override via nullable cols.
create table cadences (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null default 'Default',
  no_answer_retry_after_min int not null default 1440,
  max_call_attempts int not null default 2,
  sms_fallback_after_min int not null default 120,
  email_fallback_after_min int not null default 240,
  reminder_offsets_min int[] not null default '{1440,120}',  -- 24h + 2h before appt
  -- Voicemail branch (§2). AMD-driven.
  on_machine text not null default 'drop_message' check (on_machine in ('drop_message','hangup')),
  voicemail_counts_as_attempt boolean not null default false,
  voicemail_sms_immediate boolean not null default true,
  -- Quiet hours (recipient-local) + pacing.
  quiet_start time not null default '20:00',
  quiet_end time not null default '09:00',
  per_day_pacing int,                        -- optional per-campaign daily cap
  created_at timestamptz not null default now()
);

alter table campaigns
  add constraint campaigns_cadence_fk foreign key (cadence_id) references cadences(id);

-- ============================================================================
-- NUMBER POOL & DELIVERABILITY  (§2)
-- ============================================================================
create table phone_numbers (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  e164 text not null,
  provider text not null default 'telnyx',
  vapi_phone_id text,                        -- imported into Vapi
  enabled boolean not null default true,
  weight numeric not null default 1,         -- volume knob
  daily_cap int not null default 400,
  sent_today int not null default 0,
  last_reset date,
  -- Warm-up ramp (§2): new numbers ramp their effective cap over ~2 weeks.
  ramp_started_on date,
  -- Health: answer-rate decay is the shipping proxy signal; spam_label is the future external signal.
  answer_rate_7d numeric,
  health_score numeric,
  quarantined_at timestamptz,
  spam_label jsonb not null default '{}',
  cnam text,                                 -- dealership display name (SHAKEN/STIR + CNAM)
  created_at timestamptz not null default now(),
  unique (company_id, e164)
);

-- ============================================================================
-- TOUCHPOINTS  (§2, §4b) — the unit of outbound work. Per customer + service-window, NOT per vehicle.
-- ============================================================================
create table touchpoints (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  vehicle_ids uuid[] not null default '{}',  -- all due vehicles covered by this contact
  campaign_id uuid references campaigns(id) on delete set null,
  channel text not null check (channel in ('voice','sms','email')),
  kind text not null default 'initial'
    check (kind in ('initial','no_answer_retry','voicemail_followup','reminder')),
  scheduled_at timestamptz not null,
  window_bucket text,                        -- for customer-level dedupe singletonKey (customer_id + window)
  status text not null default 'scheduled'
    check (status in ('scheduled','claiming','in_flight','completed','failed','canceled','spam_blocked')),
  attempt int not null default 0,
  outcome text
    check (outcome in ('answered','no_answer','voicemail_dropped','machine_hangup','booked',
                       'declined','bad_number','carrier_rejected','provider_error')),
  phone_number_id uuid references phone_numbers(id),
  -- Two-phase claim (§4b): claim → gate → execute → confirm, reconciler backstop (§4c).
  claim_id uuid,
  claimed_at timestamptz,
  provider_error text,                       -- "provider down" ≠ "call failed"; does NOT consume an attempt
  cost_usd numeric,
  result jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index touchpoints_company on touchpoints (company_id);
create index touchpoints_customer on touchpoints (customer_id);
create index touchpoints_scheduler on touchpoints (status, scheduled_at);  -- FOR UPDATE SKIP LOCKED batches
create unique index touchpoints_claim_id_idx on touchpoints (claim_id) where claim_id is not null;
create index touchpoints_reconciler_idx on touchpoints (status, claimed_at)
  where status in ('claiming','in_flight');
create index touchpoints_dedupe on touchpoints (customer_id, window_bucket);

-- ============================================================================
-- CALLS, TRANSCRIPTS, MESSAGES  (§2)
-- ============================================================================
create table calls (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  touchpoint_id uuid references touchpoints(id) on delete set null,
  customer_id uuid references customers(id) on delete cascade,
  vapi_call_id text,
  recording_url text,
  duration_sec int,
  outcome text,
  cost_usd numeric,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index calls_company on calls (company_id, created_at desc);
create index calls_touchpoint on calls (touchpoint_id);

-- Turn-by-turn rows for BOTH voice transcripts and SMS/email threads (channel column).
-- messages.search is a generated tsvector — inserts just work, never write to it (§7 gotcha).
create table transcripts (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  call_id uuid references calls(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  channel text not null default 'voice' check (channel in ('voice','sms','email')),
  role text not null check (role in ('ai','customer','human_agent','system')),
  content text not null,
  ts timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', coalesce(content,''))) stored,
  created_at timestamptz not null default now()
);
create index transcripts_call on transcripts (call_id, ts);
create index transcripts_search on transcripts using gin (search);

-- SMS/email turns (conversational loop + directory recency).
create table messages (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  touchpoint_id uuid references touchpoints(id) on delete set null,
  channel text not null check (channel in ('sms','email')),
  direction text not null check (direction in ('outbound','inbound')),
  content text not null,
  provider_message_id text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_customer on messages (customer_id, created_at);

-- ============================================================================
-- APPOINTMENTS  (§2, §6b) — myKaarma abstracted; `soft` mode until real adapter.
-- ============================================================================
create table appointments (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  vehicle_id uuid references vehicles(id) on delete set null,
  touchpoint_id uuid references touchpoints(id) on delete set null,
  provider text not null default 'soft' check (provider in ('mykaarma','soft')),
  external_id text,
  starts_at timestamptz,
  preferred_time text,                       -- for soft commits (captured, not yet placed)
  service_ops jsonb not null default '{}',
  notes text,                                -- carries the TPC:<id> tag for the shown-RO loop (§6b)
  status text not null default 'pending_confirmation'
    check (status in ('pending_confirmation','confirmed','canceled','no_show','shown')),
  reminder_state jsonb not null default '{}',
  shown_at timestamptz,
  created_at timestamptz not null default now()
);
create index appointments_company on appointments (company_id, created_at desc);
create index appointments_customer on appointments (customer_id);

-- ============================================================================
-- CALL ANALYSES  (§14a) — one structured pass per completed call.
-- Mechanical fields computed in code; judgment fields from Claude (kept as separate classes).
-- ============================================================================
create table call_analyses (
  call_id uuid primary key references calls(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  -- conversation mechanics (mechanical — from transcript + Vapi turn timestamps)
  customer_engaged boolean,
  talk_ratio numeric,
  interruption_count int,
  customer_turn_count int,
  silence_or_confusion_events int,
  -- comprehension & identity (judged)
  understood_purpose boolean,
  identity_confusion boolean,
  ai_disclosure_reaction text,               -- null | neutral | negative | positive
  -- objections & intent (judged, fixed taxonomy)
  objections text[] not null default '{}',   -- price|too_busy|services_elsewhere|just_serviced|sold_vehicle|doesnt_trust_ai|timing|other
  objection_handled boolean,
  interest_level text,                       -- hot|warm|cold|hostile
  commitment_type text,                      -- booked|soft_commit|callback_requested|declined|none
  -- quality & safety (judged QA rubric)
  script_adherence_score int,
  disclosed_recording boolean,
  stated_dealership boolean,
  invented_facts boolean,
  correct_vehicle_referenced boolean,
  sentiment_start text,
  sentiment_end text,
  agent_error_notes text,
  -- language
  language_detected text,
  language_switch_requested boolean,
  -- bookkeeping
  analysis_cost_usd numeric,
  taxonomy_version int not null default 1,
  created_at timestamptz not null default now()
);
create index call_analyses_company on call_analyses (company_id, created_at desc);

-- ============================================================================
-- COST TRACKING  (§12) — the same events price the product (cost per shown RO).
-- ============================================================================
create table cost_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id) on delete cascade,
  touchpoint_id uuid references touchpoints(id) on delete set null,
  call_id uuid references calls(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  category text not null check (category in ('voice','sms','email','llm','embedding','analysis')),
  amount_usd numeric not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index cost_events_company on cost_events (company_id, created_at);

-- ============================================================================
-- DURABILITY & CONTROL  (§2, §4b/4c/5b, §12c) — correctness under partial failure.
-- ============================================================================
-- Durable inbox for every provider callback. Handlers write here + return 200; a job processes (§5b).
create table webhook_events (
  id uuid primary key default uuid_generate_v4(),
  provider text not null,                    -- vapi | telnyx | mykaarma
  event_type text,
  raw_payload jsonb not null,                -- PERMANENT — the replay log
  signature_valid boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  touchpoint_id uuid                         -- backfilled during processing
);
create index webhook_events_unprocessed on webhook_events (received_at) where processed_at is null;

-- Per-provider circuit breaker. A tripped circuit holds touchpoints in `scheduled` (no attempts consumed).
create table provider_circuits (
  provider text primary key,                 -- vapi | telnyx_sms | resend | anthropic
  state text not null default 'closed' check (state in ('closed','open','half_open')),
  failure_count int not null default 0,
  opened_at timestamptz,
  retry_after timestamptz
);

-- Global kill switch + concurrency governor + spend ceilings (three independent cap layers, §12c).
create table global_settings (
  id boolean primary key default true check (id),  -- single-row table
  global_dial_enabled boolean not null default true,
  max_concurrent_calls int not null default 10,
  daily_spend_cap_usd numeric not null default 100,
  monthly_spend_cap_usd numeric not null default 500
);

-- ============================================================================
-- AUDIT
-- ============================================================================
create table audit_log (
  id bigint generated always as identity primary key,
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid references auth.users(id),
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ============================================================================
-- RLS  (§8) — tenant isolation via memberships. Same pattern as realtyAI 0001.
-- ============================================================================
alter table companies enable row level security;
alter table memberships enable row level security;
alter table invites enable row level security;
alter table customers enable row level security;
alter table vehicles enable row level security;
alter table vehicle_mileage enable row level security;
alter table service_schedules enable row level security;
alter table imports enable row level security;
alter table campaigns enable row level security;
alter table cadences enable row level security;
alter table phone_numbers enable row level security;
alter table touchpoints enable row level security;
alter table calls enable row level security;
alter table transcripts enable row level security;
alter table messages enable row level security;
alter table appointments enable row level security;
alter table call_analyses enable row level security;
alter table cost_events enable row level security;
alter table audit_log enable row level security;

create or replace function my_company_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select company_id from memberships where user_id = auth.uid()
$$;

create policy member_read on companies for select using (id in (select my_company_ids()));
create policy member_update on companies for update using (id in (select my_company_ids()));
create policy member_rw_memberships on memberships for select using (company_id in (select my_company_ids()));

-- Generic per-table tenant policies (tables with a direct company_id column).
do $$
declare t text;
begin
  foreach t in array array[
    'invites','customers','vehicles','vehicle_mileage','imports','campaigns','cadences',
    'phone_numbers','touchpoints','calls','transcripts','messages','appointments',
    'call_analyses','cost_events','audit_log'
  ]
  loop
    execute format('create policy tenant_select on %I for select using (company_id in (select my_company_ids()));', t);
    execute format('create policy tenant_insert on %I for insert with check (company_id in (select my_company_ids()));', t);
    execute format('create policy tenant_update on %I for update using (company_id in (select my_company_ids()));', t);
  end loop;
end $$;

-- service_schedules: company-owned rows OR platform-global defaults (company_id is null).
create policy schedules_select on service_schedules for select
  using (company_id is null or company_id in (select my_company_ids()));
create policy schedules_insert on service_schedules for insert
  with check (company_id in (select my_company_ids()));
create policy schedules_update on service_schedules for update
  using (company_id in (select my_company_ids()));

-- service_intervals inherit access from their parent schedule.
alter table service_intervals enable row level security;
create policy intervals_select on service_intervals for select using (
  schedule_id in (
    select id from service_schedules
    where company_id is null or company_id in (select my_company_ids())
  )
);

-- Backend workers use the service-role key and bypass RLS. webhook_events / provider_circuits /
-- global_settings / platform_admins are operator/worker-only — no tenant policies (service-role only).

-- ============================================================================
-- DIRECTORY SEARCH  (§2, §6) — search customers by phone / name / VIN.
-- ============================================================================
create or replace function search_customers(p_company_id uuid, p_query text)
returns table (
  customer_id uuid, full_name text, phone text, email text,
  customer_type text, vehicle_count bigint
)
language sql stable security definer set search_path = public as $$
  select c.id, c.full_name, c.phone, c.email, c.customer_type, count(v.id)
  from customers c
  left join vehicles v on v.customer_id = c.id
  where c.company_id = p_company_id
    and (
      c.full_name ilike '%' || p_query || '%'
      or c.phone ilike '%' || p_query || '%'
      or c.email ilike '%' || p_query || '%'
      or exists (
        select 1 from vehicles vv
        where vv.customer_id = c.id and vv.vin ilike '%' || p_query || '%'
      )
    )
  group by c.id
  order by c.full_name
  limit 50
$$;
