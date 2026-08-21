/**
 * Talk to the inbound agent from your terminal — same prompt, same tools, no phone.
 *
 *   npx tsx scripts/chat.ts                 # as a known caller (first customer on file)
 *   npx tsx scripts/chat.ts --anon          # as an unrecognized caller
 *   npx tsx scripts/chat.ts --from +1408…   # as a specific number
 *   npx tsx scripts/chat.ts --prompt        # print the system prompt and exit
 *   npx tsx scripts/chat.ts --keep          # keep the call row (with duration) for dashboards
 *
 * Uses the SAME /inbound/assistant + /inbound/tools endpoints Vapi calls, so what you see here
 * is what a caller gets — minus speech. Tool calls are executed for real and printed, so you can
 * confirm the agent looks things up instead of inventing answers.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline/promises";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const API = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const SECRET = process.env.VAPI_WEBHOOK_SECRET ?? "";

/**
 * Accept what a person would type (628-358-7659, (628) 358 7659, 16283587659) and produce the
 * E.164 form Vapi actually sends. Passing a raw 10-digit string would exercise a case that never
 * occurs on a real call.
 */
function toE164(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (raw.trim().startsWith("+") && d.length >= 11) return `+${d}`;
  return "";
}

async function post(path: string, body: any) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vapi-secret": SECRET },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function main() {
  const args = process.argv.slice(2);
  const anon = args.includes("--anon");
  const doCleanup = args.includes("--cleanup");
  const promptOnly = args.includes("--prompt");
  // Keep the call row so it shows up on the dashboard (with a real duration) instead of being
  // deleted on exit. Without this, testing metrics means hand-editing the database.
  const keep = args.includes("--keep");
  const fromFlag = args.indexOf("--from");

  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, realtime: { transport: ws as any } });

  if (doCleanup) { await sweepSimulated(sb); return; }

  const { data: num } = await sb.from("phone_numbers").select("e164").eq("enabled", true).limit(1).single();
  if (!num) { console.error("No enabled phone_numbers row — the agent can't resolve a dealership."); process.exit(1); }

  let from: string;
  if (fromFlag >= 0) {
    const raw = args[fromFlag + 1];
    if (!raw) { console.error("--from needs a number, e.g. --from 628-358-7659"); process.exit(1); }
    from = toE164(raw);
    if (!from) {
      console.error(`could not read "${raw}" as a phone number (want 10 digits, or 11 starting with 1)`);
      process.exit(1);
    }
  } else if (anon) {
    from = "+15550009999";
  } else {
    const { data: c } = await sb.from("customers").select("phone").not("phone", "is", null).limit(1).single();
    from = c?.phone ?? "+15550009999";
  }

  // Report what the lookup will actually do, so a "why didn't it know me?" is answerable up front.
  const { data: matches } = await sb.from("customers").select("full_name, phone");
  const digits = from.replace(/\D/g, "").slice(-10);
  const hits = (matches ?? []).filter((c: any) => (c.phone ?? "").replace(/\D/g, "").slice(-10) === digits);

  // Prefix marks these as simulated: cleanup runs on exit, but a hard kill (Ctrl-C twice,
  // crash) can strand rows, and an untagged row is indistinguishable from a real call in the
  // dashboard. `--cleanup` sweeps any strays.
  const callId = `sim-${Date.now()}`;
  const startedAt = Date.now();
  const { assistant } = await post("/inbound/assistant", {
    message: { type: "assistant-request",
      call: { id: callId, phoneNumber: { number: num.e164 }, customer: { number: from } } },
  });

  const system = assistant.model.messages[0].content;
  if (promptOnly) { console.log(system); await cleanup(sb, callId); return; }

  const tools = (assistant.model.tools ?? [])
    .filter((t: any) => t.type === "function")
    .map((t: any) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  // Vapi's native transferCall isn't a server tool; model it so the agent can "transfer" here.
  tools.push({ name: "transferCall", description: "Transfer the caller to a human.",
    input_schema: { type: "object", properties: {} } });
  // Vapi exposes endCall via endCallFunctionEnabled. Model it too, otherwise the simulator can't
  // show whether the agent actually hangs up when the conversation is finished.
  tools.push({ name: "endCall", description: "End the call once the conversation is complete.",
    input_schema: { type: "object", properties: {} } });

  const who = hits.length === 1 ? `identified as ${hits[0].full_name}`
            : hits.length > 1 ? `AMBIGUOUS — ${hits.length} customers share this number, so the agent treats it as anonymous`
            : "not on file — anonymous";
  console.log(`\n  dialing ${num.e164} from ${from}`);
  console.log(`  ${who}`);
  console.log(`  tools: ${tools.map((t: any) => t.name).join(", ")}\n`);
  console.log(`  AGENT: ${assistant.firstMessage}\n`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const messages: any[] = [];
  let ended = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (!ended) {
    // Piped stdin closes readline once input runs out; treat that as "hang up" rather than crash,
    // so scripted turns (echo "..." | chat.ts) work for repeatable prompt testing.
    let you: string;
    try { you = await rl.question("  YOU: "); }
    catch { break; }
    if (!you.trim() || ["exit", "quit"].includes(you.trim().toLowerCase())) break;
    messages.push({ role: "user", content: you });

    // Loop until the model stops calling tools.
    for (let hop = 0; hop < 6; hop++) {
      const res = await anthropic.messages.create({
        model: process.env.LLM_MODEL_CALL ?? "claude-haiku-4-5-20251001",
        max_tokens: 400, system, tools, messages,
      });
      messages.push({ role: "assistant", content: res.content });

      const text = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ").trim();
      if (text) console.log(`\n  AGENT: ${text}\n`);

      const calls = res.content.filter((c: any) => c.type === "tool_use");
      if (!calls.length) break;

      const results: any[] = [];
      for (const tc of calls as any[]) {
        if (tc.name === "endCall") {
          console.log(`  [call ended by agent]`);
          ended = true;
          results.push({ type: "tool_result", tool_use_id: tc.id, content: "Call ended." });
          continue;
        }
        if (tc.name === "transferCall") {
          console.log(`  [transfer] caller would now be connected to a human`);
          // The leg is GONE — end the simulated call, same as endCall. Letting the loop continue
          // invited the model to keep talking ("I've transferred you..."), which looked like an
          // agent bug but was the simulator being unfaithful: in production Vapi has already
          // moved the caller and nobody is left to hear it.
          ended = true;
          results.push({ type: "tool_result", tool_use_id: tc.id,
            content: "Transferred. The caller is no longer on your line. Say nothing further." });
          continue;
        }
        const out = await post("/inbound/tools", {
          message: { toolCalls: [{ id: tc.id, function: { name: tc.name, arguments: tc.input } }],
                     call: { id: callId } },
        });
        const result = out.results?.[0]?.result ?? "(no result)";
        console.log(`  [tool] ${tc.name}(${JSON.stringify(tc.input)})`);
        console.log(`  [ -> ] ${String(result).replace(/\n/g, "\n         ").slice(0, 400)}\n`);
        results.push({ type: "tool_result", tool_use_id: tc.id, content: String(result) });
      }
      messages.push({ role: "user", content: results });
      if (ended) break;
    }
  }
  rl.close();
  const secs = await finalize(sb, callId, startedAt);
  if (keep) {
    console.log(`\n  (call kept — ${secs}s, visible on the dashboard)`);
  } else {
    await cleanup(sb, callId);
    console.log("\n  (simulated call row cleaned up)");
  }
}

/** Delete every stranded simulated call (from runs killed before cleanup). */
async function sweepSimulated(sb: any) {
  const { data } = await sb.from("calls").select("id").like("vapi_call_id", "sim-%");
  const ids = (data ?? []).map((x: any) => x.id);
  if (!ids.length) { console.log("  no stranded simulated rows"); return; }
  await deleteCallRows(sb, ids);
  console.log(`  removed ${ids.length} stranded simulated call row(s)`);
}

/** Remove the rows this simulation created so the dashboard stays truthful. */
/**
 * Stamp the simulated call as completed.
 *
 * duration_sec is normally written by Vapi's end-of-call webhook, which this simulator never
 * sends — so simulated calls had a null duration and were invisible to "Avg call length" and to
 * anything counting answered calls. Use --keep to leave the row behind for dashboard testing.
 */
async function finalize(sb: any, callId: string, startedAt: number) {
  const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  await sb.from("calls")
    .update({ duration_sec: seconds, metadata: { endedReason: "customer-ended-call", simulated: true } })
    .eq("vapi_call_id", callId);
  return seconds;
}

async function cleanup(sb: any, callId: string) {
  const { data } = await sb.from("calls").select("id").eq("vapi_call_id", callId);
  const ids = (data ?? []).map((x: any) => x.id);
  if (ids.length) await deleteCallRows(sb, ids);
}

/**
 * Everything a simulated call can create, in FK order.
 *
 * Customers and vehicles matter here: testing the new-caller flow with `--anon` runs
 * register_customer for real, and `created_on_call_id` is ON DELETE SET NULL — so deleting the
 * call alone would leave a fake "Test Caller" sitting in the Customer Directory forever, which is
 * exactly the pollution this cleanup exists to prevent. Deleting the customer cascades to their
 * vehicles and appointments.
 */
async function deleteCallRows(sb: any, callIds: string[]) {
  const { data: made } = await sb.from("customers").select("id").in("created_on_call_id", callIds);
  const customerIds = (made ?? []).map((x: any) => x.id);

  await sb.from("handoff_requests").delete().in("call_id", callIds);
  // Vehicles added to a PRE-EXISTING customer during the call (register_customer on a caller who
  // was already on file); the ones belonging to simulated customers go by cascade below.
  await sb.from("vehicles").delete().in("created_on_call_id", callIds);
  if (customerIds.length) await sb.from("customers").delete().in("id", customerIds);
  await sb.from("calls").delete().in("id", callIds);
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
