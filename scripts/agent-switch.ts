/**
 * Kill switch for the inbound agent.
 *
 *   npx tsx scripts/agent-switch.ts off    # stop the AI; callers are handed to a human
 *   npx tsx scripts/agent-switch.ts on     # resume
 *   npx tsx scripts/agent-switch.ts        # show current state
 *
 * OFF still answers the phone — the caller hears one line and is transferred. Silence would be
 * worse for them than a handoff, and an unanswered service line is a lost customer either way.
 * Takes effect on the NEXT call; a call already in progress finishes normally.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

async function main() {
  const arg = (process.argv[2] ?? "").toLowerCase();
  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, realtime: { transport: ws as any } });

  const { data: co } = await sb.from("companies")
    .select("id, name, agent_enabled, settings").limit(1).single();
  if (!co) { console.error("no dealership found"); process.exit(1); }

  if (!arg) {
    const transfer = ((co.settings ?? {}) as any)?.inbound?.transfer_number;
    console.log(`  ${co.name}: agent is ${co.agent_enabled ? "ON — handling calls" : "OFF — transferring every caller"}`);
    if (!co.agent_enabled && !transfer) {
      console.log("  ⚠ no transfer number set, so callers will be asked to hold instead of being connected");
    }
    return;
  }
  if (!["on", "off"].includes(arg)) { console.error("usage: agent-switch.ts [on|off]"); process.exit(1); }

  const enabled = arg === "on";
  const { error } = await sb.from("companies").update({ agent_enabled: enabled }).eq("id", co.id);
  if (error) { console.error("failed:", error.message); process.exit(1); }

  console.log(`  ${co.name}: agent ${enabled ? "ON" : "OFF"}`);
  console.log(enabled
    ? "  Callers are handled normally again, starting with the next call."
    : "  Callers now hear a brief line and are transferred to a human. Calls already in progress finish normally.");
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
