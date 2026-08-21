-- ============================================================================
-- REAL SCHEDULING (interim, until myKaarma)
--
-- Appointments only ever stored preferred_time as free text ("Friday at 10am"). That can't be
-- sorted, drawn on a calendar, or checked for conflicts — so the agent could book six people into
-- the same slot and nobody would know until they arrived.
--
-- This resolves a spoken time to a real starts_at/ends_at, so we can offer genuine availability
-- and recognize a customer whose car is IN THE SHOP right now.
--
-- Capacity is deliberately crude: concurrent-appointment count, not bay/technician modelling.
-- myKaarma owns real shop loading; this only has to stop us double-booking the same hour.
-- ============================================================================

alter table appointments
  add column if not exists ends_at timestamptz,
  -- When the vehicle actually arrived. Set by an advisor; drives "your car is being serviced".
  add column if not exists checked_in_at timestamptz,
  add column if not exists completed_at timestamptz;

-- 'in_service' = vehicle is physically here being worked on.
alter table appointments drop constraint if exists appointments_status_check;
alter table appointments add constraint appointments_status_check
  check (status in ('pending_confirmation','confirmed','in_service','canceled','no_show','shown'));

create index if not exists appointments_calendar
  on appointments (company_id, starts_at)
  where status in ('pending_confirmation','confirmed','in_service');

-- How many vehicles the shop can have in progress at once. Bounds what the agent will offer.
alter table companies
  add column if not exists concurrent_capacity int not null default 4,
  add column if not exists appointment_slot_minutes int not null default 30;

comment on column companies.concurrent_capacity is
  'Max overlapping appointments the agent will book into one slot. Crude stand-in for bay and
   technician capacity until myKaarma provides real availability.';
