-- ============================================================================
-- RENAME: Touchpoint Center -> ActumAuto
--
-- Only the appointment tag needs migrating. It's written into myKaarma appointment notes and
-- matched later to close the booked -> shown-RO loop (§6b), so old and new tags must not
-- diverge. Safe to run now (test data only); after go-live it would strand real tags.
-- ============================================================================

update appointments
   set notes = replace(notes, 'TPC:', 'AA:')
 where notes like '%TPC:%';

comment on column appointments.notes is
  'Carries the AA:<appointment_id> tag used to match this booking back to a shown repair order.';
