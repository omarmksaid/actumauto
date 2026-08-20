-- ============================================================================
-- SALES LEADS — the public "Contact sales" form on the marketing page.
--
-- Stored, not emailed: Resend isn't configured, and a lead that only exists in an unsent email
-- is a lead you lose. Email notification can layer on later without changing this.
--
-- The insert endpoint is PUBLIC (no auth — that's the point of a contact form), so RLS denies
-- all tenant access and only the service role reads it. No policies are created deliberately:
-- with RLS enabled and no policy, anon/authenticated get nothing.
-- ============================================================================

create table sales_leads (
  id uuid primary key default uuid_generate_v4(),
  first_name text not null,
  last_name text not null,
  dealership_name text not null,
  dealership_address text,
  email text,
  phone text,
  notes text,
  status text not null default 'new' check (status in ('new','contacted','qualified','closed','spam')),
  -- Light abuse forensics for a public endpoint.
  source_ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index sales_leads_new on sales_leads (status, created_at desc);

alter table sales_leads enable row level security;
-- No policies: service-role only.
