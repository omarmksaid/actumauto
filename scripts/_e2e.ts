/**
 * Scripted end-to-end run of the new-caller flow. Same endpoints as chat.ts, but turns are driven
 * programmatically so a piped script can't desync the readline loop.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const API = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const SECRET = process.env.VAPI_WEBHOOK_SECRET ?? "";
const post = async (p: string, b: any) => {
  const r = await fetch(`${API}${p}`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-vapi-secret": SECRET }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} -> ${r.status}: ${(await r.text()).slice(0,300)}`);
  return r.json();
};

const TURNS = [
  "hey, do you guys do brake work?",
  "yeah my brakes have been squeaking for about a week",
  "sure, can I get an appointment?",
  "Omar Klaib",
  "it's a 2021 Toyota Camry, about 48,000 miles",
  "what's the soonest you have?",
  "yeah that works, I'll drop it off",
  "no that's it, thanks",
];

(async () => {
  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false }, realtime: { transport: ws as any } });
  const { data: num } = await sb.from("phone_numbers").select("e164").eq("enabled", true).limit(1).single();

  const callId = `sim-${Date.now()}`;
  const { assistant } = await post("/inbound/assistant", { message: { type: "assistant-request",
    call: { id: callId, phoneNumber: { number: num!.e164 }, customer: { number: "+15550009999" } } } });

  const system = assistant.model.messages[0].content;
  const tools = (assistant.model.tools ?? []).filter((t: any) => t.type === "function")
    .map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));

  console.log(`AGENT: ${assistant.firstMessage}\n`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const msgs: any[] = [];

  for (const turn of TURNS) {
    console.log(`YOU:   ${turn}`);
    msgs.push({ role: "user", content: turn });

    // Let the model use as many tools as it wants before it speaks.
    for (let hop = 0; hop < 6; hop++) {
      const res = await anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 700, system, tools: tools as any, messages: msgs,
      });
      msgs.push({ role: "assistant", content: res.content });

      const calls = res.content.filter((c: any) => c.type === "tool_use") as any[];
      for (const c of calls) console.log(`  [tool] ${c.name}(${JSON.stringify(c.input)})`);
      const said = res.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ").trim();
      if (said) console.log(`AGENT: ${said}`);

      if (!calls.length) break;

      const out = await post("/inbound/tools", { message: { type: "tool-calls", call: { id: callId },
        toolCalls: calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: JSON.stringify(c.input) } })) } });
      for (const r of out.results) console.log(`  [ -> ] ${String(r.result).replace(/\n/g, " | ").slice(0, 220)}`);
      msgs.push({ role: "user", content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id,
        content: String(out.results.find((r: any) => r.toolCallId === c.id)?.result ?? "") })) });
    }
    console.log();
  }

  // What ended up in the database.
  const { data: rows } = await sb.from("calls").select("id").eq("vapi_call_id", callId);
  const ids = (rows ?? []).map((x: any) => x.id);
  const { data: cust } = await sb.from("customers")
    .select("id, full_name, phone, customer_type, vehicles(year, make, model, mileage), appointments(preferred_time, starts_at, status, drop_off, service_ops)")
    .in("created_on_call_id", ids);
  console.log("=== DB RESULT ===");
  console.log(JSON.stringify(cust, null, 1));

  // Clean up in the same order chat.ts does: customers BEFORE the call row.
  const cids = (cust ?? []).map((x: any) => x.id);
  await sb.from("handoff_requests").delete().in("call_id", ids);
  await sb.from("vehicles").delete().in("created_on_call_id", ids);
  if (cids.length) { await sb.from("appointments").delete().in("customer_id", cids); await sb.from("customers").delete().in("id", cids); }
  await sb.from("calls").delete().in("id", ids);
  console.log("\n(cleaned up)");
})();
