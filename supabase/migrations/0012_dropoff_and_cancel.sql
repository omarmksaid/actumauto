-- ============================================================================
-- DROP-OFF vs WAIT, and cancellation bookkeeping.
--
-- Every service department asks "are you dropping it off or waiting?" — it decides how the work
-- is scheduled (a waiter needs a short job in a free bay now; a drop-off can be worked around).
-- The agent was never asking, so an advisor had to call back for it.
-- ============================================================================

alter table appointments
  add column if not exists drop_off text
    check (drop_off in ('waiting', 'dropping_off', 'unknown')),
  add column if not exists canceled_at timestamptz,
  add column if not exists cancel_reason text;

comment on column appointments.drop_off is
  'waiting = customer stays on site; dropping_off = leaving the vehicle. Decides how the shop
   schedules the work, so the agent asks on every booking.';

create index if not exists appointments_open
  on appointments (customer_id, status) where status in ('pending_confirmation', 'confirmed');
