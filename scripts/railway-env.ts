/**
 * Print the environment variables to paste into Railway, split per service.
 *
 *   npx tsx scripts/railway-env.ts            # both services
 *   npx tsx scripts/railway-env.ts --api      # API only
 *   npx tsx scripts/railway-env.ts --web      # dashboard only
 *
 * Reads the local .env so nothing is retyped. Secrets ARE printed — this is for pasting into
 * Railway's variable editor, so don't share the output.
 */
import "dotenv/config";
import { readFileSync } from "fs";

const API_VARS = [
  "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET",
  "ANTHROPIC_API_KEY", "VAPI_API_KEY", "VAPI_WEBHOOK_SECRET",
  "LLM_MODEL_CALL", "LLM_MODEL_OFFLINE", "DEFAULT_TTS_PROVIDER", "DEFAULT_VOICE_ID",
  "DEFAULT_TIMEZONE",
];

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    out[k.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function main() {
  const e = env();
  const only = process.argv.includes("--api") ? "api"
             : process.argv.includes("--web") ? "web" : "both";

  if (only !== "web") {
    console.log("╭─ SERVICE 1: API + worker  (root directory: blank) ─────────────────\n");
    for (const k of API_VARS) if (e[k]) console.log(`${k}=${e[k]}`);
    console.log("\n# Set AFTER the domain exists, then redeploy:");
    console.log("APP_URL=https://<api-service>.up.railway.app");
    console.log("WEB_URL=https://<web-service>.up.railway.app");
    console.log("");
  }

  if (only !== "api") {
    console.log("╭─ SERVICE 2: dashboard  (root directory: web) ──────────────────────\n");
    console.log(`NEXT_PUBLIC_SUPABASE_URL=${e.SUPABASE_URL ?? ""}`);
    console.log(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${e.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""}`);
    console.log("NEXT_PUBLIC_API_URL=https://<api-service>.up.railway.app");
    console.log("\n# NEXT_PUBLIC_* are inlined at BUILD time — changing one needs a redeploy,");
    console.log("# not just a restart.");
    console.log("");
  }
}
main();
