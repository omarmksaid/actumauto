/**
 * Message dispatch (PLAN.md §4b) for SMS + email — the same claim → gate → execute → confirm
 * discipline as voice, so a fallback send never double-fires. Shorter than voice (no live call),
 * but the safety machinery is identical: CAS claim, dial-time gate, provider-down → circuit + hold.
 */

import { supabaseAdmin } from "../lib/supabase";
import { boss } from "../jobs/queue";
import { env } from "../lib/env";
import { recordCost, RATES } from "../lib/costs";
import { preDialGate } from "./gate";
import { getSender } from "../channels/types";
import "../channels/register";

export async function dispatchMessage(touchpointId: string): Promise<void> {
  // 1. CLAIM.
  const claimId = crypto.randomUUID();
  const { data: tp } = await supabaseAdmin
    .from("touchpoints")
    .update({ status: "claiming", claim_id: claimId, claimed_at: new Date().toISOString() })
    .eq("id", touchpointId).eq("status", "scheduled")
    .select("id, company_id, customer_id, channel")
    .maybeSingle();
  if (!tp) return;

  const channel = tp.channel as "sms" | "email";
  const sender = getSender(channel);
  if (!sender) { await revert(touchpointId, "failed"); return; }

  const { data: company } = await supabaseAdmin
    .from("companies").select("name, timezone").eq("id", tp.company_id).single();
  const { data: customer } = await supabaseAdmin
    .from("customers").select("full_name, phone, email, opted_out, do_not_contact").eq("id", tp.customer_id).single();
  const { data: cadence } = await supabaseAdmin
    .from("cadences").select("quiet_start, quiet_end").eq("company_id", tp.company_id).limit(1).maybeSingle();

  if (!customer || customer.opted_out || customer.do_not_contact) { await revert(touchpointId, "canceled"); return; }

  // 2. GATE (kill switch, circuit, quiet hours [sms], spend caps).
  const gate = await preDialGate({
    companyId: tp.company_id,
    timezone: company?.timezone ?? env.DEFAULT_TIMEZONE,
    quietStart: cadence?.quiet_start ?? "20:00",
    quietEnd: cadence?.quiet_end ?? "09:00",
    channel,
  });
  if (!gate.ok) {
    await revert(touchpointId, "scheduled");
    await boss.send(`dispatch-message`, { touchpointId },
      { startAfter: gate.retryAfterSec, singletonKey: `dispatch:${touchpointId}` });
    return;
  }

  const ctx: any = {
    companyId: tp.company_id, customerId: tp.customer_id, touchpointId,
    toPhone: customer.phone, toEmail: customer.email,
    customerName: customer.full_name, dealershipName: company?.name ?? "the dealership",
    bookingLink: `${env.WEB_URL}/book/${touchpointId}`,
  };
  if (!sender.canReach(ctx)) { await revert(touchpointId, "canceled"); return; }

  // For SMS, attach a pool number as the sender.
  if (channel === "sms") {
    const number = await pickNumber(tp.company_id);
    if (!number) {
      await revert(touchpointId, "scheduled");
      await boss.send("dispatch-message", { touchpointId }, { startAfter: 15 * 60, singletonKey: `dispatch:${touchpointId}` });
      return;
    }
    ctx.fromNumber = number.e164;
    ctx._numberId = number.id;
  }

  // 3. EXECUTE.
  const result = await sender.send(ctx);

  if (!result.ok) {
    const providerDown = !result.status || result.status >= 500;
    if (providerDown) {
      await tripCircuit(channel === "sms" ? "telnyx_sms" : "resend");
      await revert(touchpointId, "scheduled", { provider_error: result.error });
      await boss.send("dispatch-message", { touchpointId }, { startAfter: 5 * 60, singletonKey: `dispatch:${touchpointId}` });
    } else {
      await supabaseAdmin.from("touchpoints")
        .update({ status: "failed", outcome: "provider_error", provider_error: result.error }).eq("id", touchpointId);
    }
    return;
  }

  // 4. CONFIRM: record the message + cost, mark completed.
  await supabaseAdmin.from("messages").insert({
    company_id: tp.company_id, customer_id: tp.customer_id, touchpoint_id: touchpointId,
    channel, direction: "outbound", content: ctx.body ?? "(default template)",
    provider_message_id: result.providerMessageId,
  });
  await recordCost({
    companyId: tp.company_id, touchpointId, customerId: tp.customer_id,
    category: channel, amountUsd: channel === "sms" ? RATES.SMS : RATES.EMAIL,
  });
  await supabaseAdmin.from("touchpoints")
    .update({ status: "completed", outcome: "answered" }).eq("claim_id", claimId);
  if (channel === "sms" && ctx._numberId) await bumpNumberUsage(ctx._numberId);
}

export function registerMessageDispatch(boss: any) {
  return boss.work("dispatch-message", { batchSize: 3 }, async ([job]: any) => {
    await dispatchMessage((job.data as { touchpointId: string }).touchpointId);
  });
}

// ── helpers (shared shape with voice dispatch) ──

async function revert(id: string, status: string, extra: Record<string, unknown> = {}) {
  await supabaseAdmin.from("touchpoints")
    .update({ status, claim_id: null, claimed_at: null, ...extra }).eq("id", id);
}

async function pickNumber(companyId: string) {
  const { data } = await supabaseAdmin
    .from("phone_numbers").select("id, e164, daily_cap, sent_today, quarantined_at")
    .eq("company_id", companyId).eq("enabled", true).is("quarantined_at", null);
  const usable = (data ?? []).filter((n) => (n.sent_today ?? 0) < (n.daily_cap ?? 400));
  if (!usable.length) return null;
  usable.sort((a, b) => (a.sent_today ?? 0) - (b.sent_today ?? 0));
  return usable[0];
}

async function bumpNumberUsage(numberId: string) {
  await supabaseAdmin.rpc("increment_number_sent", { p_id: numberId }).then(() => {}, () => {});
}

async function tripCircuit(provider: string) {
  await supabaseAdmin.from("provider_circuits").upsert({
    provider, state: "open", opened_at: new Date().toISOString(),
    retry_after: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
}
