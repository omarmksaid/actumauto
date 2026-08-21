-- ============================================================================
-- NEW-CUSTOMER INTAKE ON AN INBOUND CALL
--
-- Until now an unidentified caller was a dead end: the agent could answer service questions but
-- could not book, because a booking needs a customer row to attach to and we had none. The agent
-- now creates that row mid-call from what the caller says.
--
-- The cost of that is provenance. Every wrong number, telemarketer, and misheard name becomes a
-- customers row, mixed in with the CSV-imported records the dealership actually vouches for. So
-- call-created rows are marked at birth: the Customer Directory can separate them, the identify
-- rate stays interpretable, and a bad row is findable without guessing.
--
-- `created_on_call_id` also gives the simulator something precise to clean up — scripts/chat.ts
-- deletes its own call's rows on exit, and without this it would have to match on names.
-- ============================================================================

alter table customers
  -- Which inbound call created this record. NULL = imported, or created in the dashboard.
  add column if not exists created_on_call_id uuid references calls(id) on delete set null;

alter table vehicles
  add column if not exists created_on_call_id uuid references calls(id) on delete set null;

comment on column customers.created_on_call_id is
  'Set when the phone agent created this customer during an inbound call, rather than a CSV import
   or dashboard entry. Unverified: the name is whatever the caller said and was heard correctly.';

-- Partial indexes: the interesting query is always "the call-created ones", never the imported
-- majority, so don't carry an index entry for every row.
create index if not exists customers_created_on_call
  on customers (created_on_call_id) where created_on_call_id is not null;
create index if not exists vehicles_created_on_call
  on vehicles (created_on_call_id) where created_on_call_id is not null;
