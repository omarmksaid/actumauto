-- ============================================================================
-- RECORDING ARCHIVE (§8 invariant 6, §9 PITR reasoning)
--
-- Call audio lives in Vapi's R2 bucket and we only keep a URL. Two problems with that:
--   1. Vapi's retention is theirs to change, and the URL we store isn't even playable
--      (private bucket — only short-lived presigned URLs stream).
--   2. Leaving Vapi would take every recording with it.
--
-- Recordings are contractually sensitive and unregenerable, so we copy them into our own
-- Storage bucket and expire them on OUR schedule (default 6 months).
--
-- Columns track the copy so it can retry: a job that fails silently is worse than no job,
-- because you'd believe you had audio you don't.
-- ============================================================================

alter table calls
  add column if not exists recording_path text,           -- our Storage object path
  add column if not exists recording_bytes bigint,
  add column if not exists archive_status text not null default 'pending'
    check (archive_status in ('pending','archived','failed','skipped','expired')),
  add column if not exists archive_attempts int not null default 0,
  add column if not exists archive_error text,
  add column if not exists archived_at timestamptz,
  add column if not exists recording_expires_at timestamptz;

comment on column calls.archive_status is
  'pending = not yet copied; archived = in our bucket; failed = retries exhausted;
   skipped = no recording to copy (0s call); expired = deleted by the retention sweep.';

-- The archiver claims work with this; keeping it partial keeps the index tiny once most calls
-- are archived.
create index if not exists calls_archive_queue on calls (archive_status, created_at)
  where archive_status in ('pending', 'failed');

create index if not exists calls_archive_expiry on calls (recording_expires_at)
  where archive_status = 'archived';

-- Calls that already happened have no recording in our bucket. Mark ones with no audio as
-- skipped so they never enter the retry queue; the rest stay pending and get picked up.
update calls
   set archive_status = 'skipped'
 where recording_url is null and archive_status = 'pending';

-- Retention window, per dealership. 6 months by default: long enough to cover a service dispute,
-- short enough to bound storage growth.
alter table companies
  add column if not exists recording_retention_days int not null default 180;

comment on column companies.recording_retention_days is
  'How long call audio is kept in our bucket before the retention sweep deletes it. 0 = keep forever.';
