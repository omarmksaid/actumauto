-- ============================================================================
-- SERVICE ALIASES — what callers actually say for a service.
--
-- lookup_services currently leans on a hardcoded SYNONYMS map in the code ("ac" -> air
-- conditioning, "overheating" -> coolant). That's my guess at how people talk, it's the same for
-- every dealership, and changing it needs a deploy.
--
-- Aliases move that knowledge to the dealership, who hear the actual phrasing all day. Seeded
-- from the hardcoded map so behaviour doesn't regress.
-- ============================================================================

alter table service_offerings
  add column if not exists aliases text[] not null default '{}';

comment on column service_offerings.aliases is
  'Alternate phrasings callers use ("CEL", "brake flush"). Matched by lookup_services alongside
   the name and description, so the agent recognizes a service by the words customers actually say.';

-- Seed from the hardcoded synonym map, scoped by name so it applies to any dealership's catalog.
update service_offerings set aliases = '{"AC","A/C","air con","not cooling","blowing warm"}'
  where name ilike '%air conditioning%' and aliases = '{}';
update service_offerings set aliases = '{"CEL","check engine","engine codes","warning light"}'
  where name ilike '%check engine%' and aliases = '{}';
update service_offerings set aliases = '{"brake flush","brake fluid service"}'
  where name ilike '%brake fluid%' and aliases = '{}';
update service_offerings set aliases = '{"squeaking","squealing","grinding","brake job","pads"}'
  where name ilike '%brake pad%' and aliases = '{}';
update service_offerings set aliases = '{"overheating","radiator","antifreeze"}'
  where name ilike '%coolant%' and aliases = '{}';
update service_offerings set aliases = '{"dead battery","jump start","won''t start"}'
  where name ilike '%battery test%' and aliases = '{}';
update service_offerings set aliases = '{"pulling","steering","alignment"}'
  where name ilike '%alignment%' and aliases = '{}';
update service_offerings set aliases = '{"flat","puncture","nail in tire"}'
  where name ilike '%flat tire%' and aliases = '{}';
update service_offerings set aliases = '{"MPI","courtesy check","free inspection"}'
  where name ilike '%multi-point%' and aliases = '{}';
update service_offerings set aliases = '{"smog","emissions","registration"}'
  where name ilike '%smog%' and aliases = '{}';
update service_offerings set aliases = '{"tune up","plugs"}'
  where name ilike '%spark plug%' and aliases = '{}';
update service_offerings set aliases = '{"oil","oil change","LOF"}'
  where name ilike '%oil %' and aliases = '{}';
update service_offerings set aliases = '{"muffler","loud","exhaust noise"}'
  where name ilike '%exhaust%' and aliases = '{}';
update service_offerings set aliases = '{"wipers","blades"}'
  where name ilike '%wiper%' and aliases = '{}';
update service_offerings set aliases = '{"headlight","bulb","light out"}'
  where name ilike '%headlight%' and aliases = '{}';
