/**
 * Bulk-load the services catalog from a JSON file.
 *
 *   npx tsx scripts/import-services.ts                      # uses scripts/services.json
 *   npx tsx scripts/import-services.ts path/to/other.json
 *   npx tsx scripts/import-services.ts --replace            # deactivate anything not in the file
 *
 * Idempotent: matches on name, updates rather than duplicating, so editing the file and
 * re-running is safe. Only `name` is required; everything else is optional.
 *
 *   { "name": "Brake pad replacement",          // REQUIRED — how the agent refers to it
 *     "description": "Front or rear pads…",     // what it involves, spoken to the caller
 *     "category": "repair",                     // maintenance | repair | inspection | tires | …
 *     "typical_duration_min": 120,              // the agent quotes this as "about 2 hours"
 *     "operations": ["BRK-F"],                  // optional op codes
 *     "active": true }                          // false hides it without deleting
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { readFileSync } from "fs";

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes("--replace");
  const file = args.find((a) => !a.startsWith("--")) ?? "scripts/services.json";

  let rows: any[];
  try {
    rows = JSON.parse(readFileSync(file, "utf8"));
  } catch (e: any) { console.error(`could not read ${file}: ${e.message}`); process.exit(1); }
  if (!Array.isArray(rows)) { console.error("file must contain a JSON array"); process.exit(1); }

  const bad = rows.filter((r) => !r?.name?.trim());
  if (bad.length) { console.error(`${bad.length} entr(ies) missing a "name"`); process.exit(1); }

  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, realtime: { transport: ws as any } });

  const { data: co } = await sb.from("companies").select("id, name").limit(1).single();
  if (!co) { console.error("no dealership found"); process.exit(1); }
  console.log(`${co.name}: importing ${rows.length} service(s) from ${file}\n`);

  const { data: existing } = await sb.from("service_offerings")
    .select("id, name").eq("company_id", co.id);
  const byName = new Map((existing ?? []).map((r: any) => [r.name.toLowerCase(), r.id]));

  let added = 0, updated = 0;
  for (const r of rows) {
    const payload = {
      name: r.name.trim(),
      description: r.description ?? null,
      category: r.category ?? null,
      operations: Array.isArray(r.operations) ? r.operations : [],
      typical_duration_min: r.typical_duration_min ?? null,
      active: r.active ?? true,
      updated_at: new Date().toISOString(),
    };
    const id = byName.get(payload.name.toLowerCase());
    if (id) {
      const { error } = await sb.from("service_offerings").update(payload).eq("id", id);
      if (error) console.error(`  ! ${payload.name}: ${error.message}`); else updated++;
    } else {
      const { error } = await sb.from("service_offerings").insert({ company_id: co.id, ...payload });
      if (error) console.error(`  ! ${payload.name}: ${error.message}`); else added++;
    }
  }

  // --replace hides catalog entries the file dropped. Deactivate rather than delete: the agent
  // stops offering them, but past appointments referencing them stay intelligible.
  let deactivated = 0;
  if (replace) {
    const keep = new Set(rows.map((r) => r.name.trim().toLowerCase()));
    for (const [name, id] of byName) {
      if (!keep.has(name)) {
        await sb.from("service_offerings").update({ active: false }).eq("id", id);
        deactivated++;
      }
    }
  }

  const { count } = await sb.from("service_offerings")
    .select("*", { head: true, count: "exact" }).eq("company_id", co.id).eq("active", true);
  console.log(`  added ${added}, updated ${updated}${replace ? `, deactivated ${deactivated}` : ""}`);
  console.log(`  ${count} active service(s) — the agent picks this up on the next call.`);
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
