-- ============================================================================
-- BUSINESS HOURS (inbound §16)
--
-- The agent had no concept of when the service center is open, so it accepted "tomorrow at 9 PM"
-- for a shop that closes in the afternoon — a soft commitment the dealership then has to walk
-- back. Stored per dealership as JSON so a shop can keep different weekday/Saturday hours and
-- close on Sunday.
--
-- Shape (24h local time, null = closed that day):
--   {"mon":["07:00","18:00"], … ,"sat":["08:00","16:00"], "sun":null}
-- ============================================================================

alter table companies
  add column if not exists business_hours jsonb not null default '{
    "mon": ["07:00", "18:00"],
    "tue": ["07:00", "18:00"],
    "wed": ["07:00", "18:00"],
    "thu": ["07:00", "18:00"],
    "fri": ["07:00", "18:00"],
    "sat": ["08:00", "16:00"],
    "sun": null
  }'::jsonb;

comment on column companies.business_hours is
  'Service center opening hours per weekday in dealership-local time; null = closed. The agent
   quotes these and refuses to capture an appointment request outside them.';
