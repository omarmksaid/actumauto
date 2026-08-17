-- Dispatch-support RPCs (PLAN.md §4b): concurrent-safe touchpoint claiming + number usage.
-- These run under the service role from the worker (RLS bypassed), but are written defensively.

-- ── claim_due_touchpoints ──
-- Returns due, schedulable touchpoints and flips them to 'claiming' in one statement, using
-- FOR UPDATE SKIP LOCKED so two scheduler instances never grab the same row (§4b, §8 invariant 10).
-- The per-touchpoint claim_id / dial-time gate still happen in dispatchVoice; this is the queue-claim.
create or replace function claim_due_touchpoints(p_limit int default 50)
returns table (id uuid, channel text, company_id uuid)
language plpgsql security definer set search_path = public as $$
begin
  return query
  update touchpoints t
     set status = 'claiming', claimed_at = now()
   where t.id in (
     select tt.id
     from touchpoints tt
     where tt.status = 'scheduled'
       and tt.scheduled_at <= now()
     order by tt.scheduled_at
     for update skip locked
     limit p_limit
   )
  returning t.id, t.channel, t.company_id;
end $$;

-- ── increment_number_sent ──
-- Atomic per-number send counter, with a daily reset baked in.
create or replace function increment_number_sent(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update phone_numbers
     set sent_today = case when last_reset is distinct from current_date then 1 else coalesce(sent_today,0) + 1 end,
         last_reset = current_date
   where id = p_id;
end $$;
