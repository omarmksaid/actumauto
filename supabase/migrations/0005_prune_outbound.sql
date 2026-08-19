-- ============================================================================
-- SCHEMA PRUNE — remove what outbound dialing left behind (inbound-only, PLAN.md §16)
--
-- The code no longer references any of this. Verified with scripts/audit-schema.ts, which
-- cross-references every table and column against src/ and web/.
--
-- DESTRUCTIVE. All dropped tables are empty on the pilot database; if yours are not, export
-- first. Everything here is recoverable from git history (migration 0001).
-- ============================================================================

-- ── 1. touchpoint_id: the unit of OUTBOUND work ─────────────────────────────
-- Live code writes this as null on every path (inbound calls have no scheduled work behind
-- them), so the column is pure vestigial plumbing. Drop the FKs before the table.
alter table calls        drop column if exists touchpoint_id;
alter table appointments drop column if exists touchpoint_id;
alter table cost_events  drop column if exists touchpoint_id;

-- ── 2. Outbound-only tables ─────────────────────────────────────────────────
-- touchpoints  — scheduled outbound work; nothing schedules calls now
-- campaigns    — service-reminder runs
-- cadences     — retry timing, SMS/email fallback, voicemail branch, quiet hours
-- messages     — SMS/email turns (no SMS, and email is unwired)
drop table if exists touchpoints cascade;
drop table if exists campaigns   cascade;
drop table if exists cadences    cascade;
drop table if exists messages    cascade;

-- ── 3. Dialer-safety tables ─────────────────────────────────────────────────
-- These existed to keep an OUTBOUND dialer from misbehaving. Inbound consumes calls it did not
-- initiate, so there is nothing to pace, trip, or kill-switch.
--   provider_circuits — circuit breaker holding touchpoints during an outage
--   global_settings   — global dial kill switch, concurrency cap, spend caps
-- NOTE: if per-call spend ceilings are wanted later they should be rebuilt around inbound
-- volume (which we do NOT control), not resurrected from this shape.
drop table if exists provider_circuits cascade;
drop table if exists global_settings   cascade;

-- ── 4. Outbound pacing columns on phone_numbers ─────────────────────────────
-- phone_numbers is now a ROUTING MAP: dialed number -> dealership. Caps, weighting, the
-- warm-up ramp, and answer-rate health were all about pacing outbound dials.
alter table phone_numbers
  drop column if exists daily_cap,
  drop column if exists weight,
  drop column if exists sent_today,
  drop column if exists last_reset,
  drop column if exists ramp_started_on,
  drop column if exists answer_rate_7d,
  drop column if exists health_score,
  drop column if exists quarantined_at,
  drop column if exists spam_label;

-- ── 5. Outbound kill switch + unused billing fields on companies ────────────
alter table companies
  drop column if exists dial_enabled,     -- per-dealership "stop dialing" switch
  drop column if exists plan,             -- operator-portal billing; no portal exists
  drop column if exists billing_status;

-- ── 6. Appointment fields tied to the outbound reminder loop ────────────────
-- reminder_state drove timed pre-appointment reminders (an outbound cadence step).
alter table appointments drop column if exists reminder_state;

-- ── 7. Unused extensible bag ────────────────────────────────────────────────
-- customers.profile is still referenced by the import field registry; vehicle_profile is not.
alter table vehicles drop column if exists vehicle_profile;

-- ── 8. create_workspace no longer inserts a cadences row ────────────────────
-- The seeded RPC wrote a default cadence for every new dealership. With cadences gone that
-- insert raises "relation cadences does not exist" and dealership creation fails outright,
-- so the function must be replaced in the same migration that drops the table.
create or replace function create_workspace(p_name text, p_timezone text default 'America/Los_Angeles')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company_id uuid;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'create_workspace must be called by an authenticated user';
  end if;

  insert into companies (name, timezone) values (p_name, p_timezone)
  returning id into v_company_id;

  insert into memberships (user_id, company_id, role, email)
  values (v_user_id, v_company_id, 'owner', (select email from auth.users where id = v_user_id));

  return v_company_id;
end $$;

-- ============================================================================
-- DELIBERATELY KEPT
--
--   call_analyses    — conversation intelligence (PLAN.md §14). Empty and unwired, but the
--                      schema IS the eval schema; rebuilding it later costs more than keeping it.
--   audit_log        — unwired, but security-relevant and cheap to keep empty.
--   vehicle_mileage  — feeds avg_miles_per_day, which drives due-service projection. The import
--                      path will populate it; dropping it would degrade recommendations.
--   invites          — team invites work today.
--   platform_admins  — operator access.
--   appointments.external_id / shown_at — the myKaarma + shown-RO loop (§6b) still to come.
--   customers.personality — nothing writes it yet, but the post-call synthesis job is a small
--                      slice away and the column is where it belongs.
-- ============================================================================
