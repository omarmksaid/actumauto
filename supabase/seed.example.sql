-- seed.example.sql — run AFTER 0001_init.sql on a NEW Touchpoint Center database.
-- Sets up: storage buckets, the single global_settings row, the create_workspace RPC,
-- and platform-global Toyota service schedules (company_id = null; every dealership sees them).
--
-- Toyota intervals below are compiled from PUBLIC maintenance-schedule sources and are
-- APPROXIMATE — mark for dealer verification before relying on them (PLAN.md §11).

-- ── Storage buckets ──
insert into storage.buckets (id, name, public) values
  ('imports', 'imports', false),
  ('knowledge', 'knowledge', false),
  ('recordings', 'recordings', false)
on conflict (id) do nothing;

-- ── Global settings (single row; three cap layers live here, §12c) ──
insert into global_settings (id, global_dial_enabled, max_concurrent_calls, daily_spend_cap_usd, monthly_spend_cap_usd)
values (true, true, 10, 100, 500)
on conflict (id) do nothing;

-- ── create_workspace RPC ──
-- Called at signup: creates the dealership + owner membership + a default cadence, atomically.
-- SECURITY DEFINER so a freshly-signed-up user (no membership yet) can bootstrap their own workspace.
create or replace function create_workspace(p_name text, p_timezone text default 'America/Los_Angeles')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into companies (name, timezone) values (p_name, p_timezone)
  returning id into v_company_id;

  insert into memberships (user_id, company_id, role, email)
  values (auth.uid(), v_company_id, 'owner', (select email from auth.users where id = auth.uid()));

  insert into cadences (company_id, name) values (v_company_id, 'Default');

  return v_company_id;
end $$;

-- ── Platform-global Toyota service schedule (company_id = null) ──
-- Standard schedule: 5,000 mi / 6 mo cadence (typical Toyota "normal" maintenance).
-- APPROXIMATE — verify against the dealer's official maintenance guide.
do $$
declare v_sched uuid;
begin
  insert into service_schedules (company_id, make, model, source, notes)
  values (null, 'Toyota', null,
          'Public Toyota maintenance-schedule references (compiled)',
          'APPROXIMATE — verify with dealer. Applies to most gas Toyota models on the normal schedule.')
  returning id into v_sched;

  insert into service_intervals (schedule_id, mileage, months, service_name, operations, severity) values
    (v_sched, 5000,  6,  'Oil & filter, tire rotation, multi-point inspection',
       '{oil_change,tire_rotation,multipoint_inspection}', 'standard'),
    (v_sched, 10000, 12, 'Oil & filter, tire rotation, inspect brakes & fluids',
       '{oil_change,tire_rotation,brake_inspection,fluid_check}', 'standard'),
    (v_sched, 15000, 18, 'Oil & filter, tire rotation, cabin/engine air filter check',
       '{oil_change,tire_rotation,air_filter_check}', 'standard'),
    (v_sched, 30000, 36, 'Major service: fluids, filters, brakes, drivetrain inspection',
       '{oil_change,tire_rotation,brake_service,transmission_check,coolant_check,air_filter}', 'major'),
    (v_sched, 60000, 72, 'Major service: spark plugs, drive belts, coolant, brake fluid',
       '{spark_plugs,drive_belts,coolant_flush,brake_fluid,tire_rotation}', 'major'),
    (v_sched, 90000, 108, 'Major service: 90k inspection, plugs, fluids, timing components',
       '{spark_plugs,coolant_flush,transmission_service,inspection}', 'major');
end $$;

-- ── (Optional) create a pilot dealership by hand ──
-- insert into companies (id, name, timezone) values
--   ('00000000-0000-0000-0000-000000000001', 'Milpitas Toyota', 'America/Los_Angeles');
-- insert into memberships (user_id, company_id, role, email) values
--   ('<auth.users id>', '00000000-0000-0000-0000-000000000001', 'owner', 'owner@milpitastoyota.com');
-- insert into cadences (company_id) values ('00000000-0000-0000-0000-000000000001');
