/**
 * Schema audit: which tables/columns does the code still touch, and what's actually populated?
 *
 * Cross-references live row counts + column population against every reference in src/, so
 * "unused" means unused by the CODE, not merely empty in a young database.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function sourceText(dir: string): string {
  let out = "";
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out += sourceText(p);
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) out += readFileSync(p, "utf8");
  }
  return out;
}

async function main() {
  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, realtime: { transport: ws as any } });

  const code = sourceText("src") + sourceText("web/app") + sourceText("web/lib");

  // Table list from the migrations (source of truth for what exists).
  const sql = ["0001_init", "0003_invite_expiry", "0004_inbound"]
    .map((f) => readFileSync(`supabase/migrations/${f}.sql`, "utf8")).join("\n");
  const tables = [...sql.matchAll(/create table (\w+)/g)].map((m) => m[1]);

  console.log(`${tables.length} tables\n`);
  const unusedTables: string[] = [];
  const suspectCols: string[] = [];

  for (const t of tables) {
    const { count, error } = await sb.from(t).select("*", { head: true, count: "exact" });
    if (error) { console.log(`  ${t}: (not readable: ${error.message})`); continue; }

    // Does the code reference this table at all?
    const referenced = new RegExp(`["'\`]${t}["'\`]`).test(code) || code.includes(`from("${t}")`);
    if (!referenced) { unusedTables.push(t); }

    console.log(`${referenced ? " " : "✗"} ${t.padEnd(22)} rows=${String(count ?? 0).padStart(5)}${referenced ? "" : "   <- NOT referenced in code"}`);

    // Column-level: which columns does the code never mention?
    const block = sql.split(`create table ${t} (`)[1]?.split("\n);")[0] ?? "";
    const cols = [...block.matchAll(/^\s{2}(\w+)\s+/gm)].map((m) => m[1])
      .filter((c) => !["primary","foreign","unique","check","constraint"].includes(c));
    const unused = cols.filter((c) => !new RegExp(`\\b${c}\\b`).test(code));
    if (unused.length && referenced) {
      suspectCols.push(`${t}: ${unused.join(", ")}`);
    }
  }

  console.log("\n── columns never referenced in code ──");
  for (const s of suspectCols) console.log("  " + s);
  console.log("\n── tables never referenced in code ──");
  console.log("  " + (unusedTables.join(", ") || "(none)"));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
