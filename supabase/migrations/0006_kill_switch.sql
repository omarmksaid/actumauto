-- ============================================================================
-- KILL SWITCH — stop the agent answering, without unplugging anything
--
-- Two independent levers, because they fail differently:
--
--   phone_numbers.enabled = false   -> that number stops resolving to a dealership. The agent
--                                      does not answer at all; Vapi falls back to its own
--                                      handling. Use when a number should go dark.
--
--   companies.agent_enabled = false -> the dealership is still recognized, but the agent is
--                                      told not to converse. The caller hears a short message
--                                      and is transferred to a human (or asked to hold), rather
--                                      than hitting silence. Use for "stop the AI, keep the line".
--
-- The second is the one you want in an emergency: a caller who reaches dead air is worse off
-- than one who is politely handed to a person.
-- ============================================================================

alter table companies
  add column if not exists agent_enabled boolean not null default true;

comment on column companies.agent_enabled is
  'Kill switch. false = the AI stops handling calls; callers are greeted briefly and handed to a human.';

-- Honor phone_numbers.enabled. It was previously ignored, so disabling a number in Settings
-- looked like a kill switch but changed nothing — the worst kind of safety control.
create or replace function identify_inbound_caller(p_to_number text, p_from_number text)
returns table (company_id uuid, customer_id uuid, match_count bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  v_company_id uuid;
  v_count bigint;
  v_customer_id uuid;
  v_digits text;
begin
  -- Which dealership owns the number that was dialed? A disabled number resolves to nothing,
  -- which the caller-side treats as "not ours" and declines to answer.
  select pn.company_id into v_company_id
  from phone_numbers pn
  where pn.e164 = p_to_number
    and pn.enabled
  limit 1;

  if v_company_id is null then
    return;
  end if;

  v_digits := regexp_replace(coalesce(p_from_number, ''), '\D', '', 'g');

  if length(v_digits) < 10 then                 -- blocked/withheld caller ID → anonymous
    return query select v_company_id, null::uuid, 0::bigint;
    return;
  end if;

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
