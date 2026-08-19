/**
 * Talk to the inbound agent from your terminal — same prompt, same tools, no phone.
 *
 *   npx tsx scripts/chat.ts                 # as a known caller (first customer on file)
 *   npx tsx scripts/chat.ts --anon          # as an unrecognized caller
 *   npx tsx scripts/chat.ts --from +1408…   # as a specific number
 *   npx tsx scripts/chat.ts --prompt        # print the system prompt and exit
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
  const promptOnly = args.includes("--prompt");
  const fromFlag = args.indexOf("--from");

  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, realtime: { transport: ws as any } });

  const { data: num } = await sb.from("phone_numbers").select("e164").eq("enabled", true).limit(1).single();
  if (!num) { console.error("No enabled phone_numbers row — the agent can't resolve a dealership."); process.exit(1); }

  let from: string;
  if (fromFlag >= 0) from = args[fromFlag + 1];
  else if (anon) from = "+15550009999";
  else {
    const { data: c } = await sb.from("customers").select("phone").not("phone", "is", null).limit(1).single();
    from = c?.phone ?? "+15550009999";
  }

  const callId = `sim-${Date.now()}`;
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

  console.log(`\n  calling as ${from} ${anon || from === "+15550009999" ? "(unrecognized)" : ""}`);
  console.log(`  tools: ${tools.map((t: any) => t.name).join(", ")}\n`);
  console.log(`  AGENT: ${assistant.firstMessage}\n`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const messages: any[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
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
        if (tc.name === "transferCall") {
          console.log(`  [transfer] caller would now be connected to a human`);
          results.push({ type: "tool_result", tool_use_id: tc.id, content: "Transferred." });
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
    }
  }
  rl.close();
  await cleanup(sb, callId);
  console.log("\n  (simulated call row cleaned up)");
}

/** Remove the calls/handoff rows this simulation created so the dashboard stays truthful. */
async function cleanup(sb: any, callId: string) {
  const { data } = await sb.from("calls").select("id").eq("vapi_call_id", callId);
  const ids = (data ?? []).map((x: any) => x.id);
  if (ids.length) {
    await sb.from("handoff_requests").delete().in("call_id", ids);
    await sb.from("calls").delete().in("id", ids);
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
