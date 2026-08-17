-- Invites expire (PLAN.md §7 team invites). 7-day window, matching the accept flow.
alter table invites add column if not exists expires_at timestamptz not null default (now() + interval '7 days');
create index if not exists invites_pending on invites (company_id, email) where accepted_at is null;
