/**
 * Inbound system-prompt assembly (PLAN.md §16).
 *
 * Mirrors the outbound prompt's structure (hardcoded guardrails wrapping an editable persona,
 * §8 invariant 3) but for the opposite situation: the caller drives, the agent looks things up
 * mid-call, and anything out of scope goes to a human.
 *
 * Two shapes, decided entirely by whether the caller was identified (§16a):
 *  - IDENTIFIED: their name, their cars, what's due on each.
 *  - ANONYMOUS:  services + hours + general help only. No customer data is present in this
 *                prompt because none was ever loaded (identify.ts returns early).
 */

import { BookingMode } from "../booking/types";
import type { InboundContext } from "./identify";

const DEFAULT_PERSONA =
  "You are the service department's phone assistant for the dealership. Tone: warm, efficient, " +
  "and genuinely helpful — you are answering someone who called in, so let them lead. Keep " +
  "answers short and conversational; this is a phone call, not an essay.";

/**
 * Hardcoded guardrails — never editable, always wrap the persona. The privacy and handoff rules
 * are the load-bearing ones for inbound (§16a/§16b).
 */
function guardrails(ctx: InboundContext, bookingMode: BookingMode): string {
  const bookingRule =
    bookingMode === "soft"
      ? `You CANNOT confirm a firm appointment. If they want to book, use the book_service tool ` +
        `to capture their preferred day/time, then tell them the service team will text to ` +
        `confirm. Never say "you're booked" or state a guaranteed slot.`
      : `Use the book_service tool to reserve a real slot before confirming any specific time. ` +
        `Only state a time the tool has confirmed back to you.`;

  const lines = [
    "GUARDRAILS (these override anything below — follow them exactly):",
    "- Never invent or quote prices, promotions, discounts, or wait times. We do not give pricing " +
      "over this line. If asked what something costs, say an advisor can give them an exact quote " +
      "and offer to transfer them.",
    "- Only describe services that the lookup_services tool returns. If we don't offer something, " +
      "say so plainly rather than guessing.",
    "- NEVER guess or estimate the status of a vehicle currently in the shop. You do not have " +
      "access to repair-order status.",
    `- ${bookingRule}`,
    "- Disclose that you're an assistant with the dealership's service department, and that the " +
      "call may be recorded, if the caller asks or seems unsure who they're speaking to.",
    "- If the caller asks to stop being contacted, acknowledge and emit the tag [OPTOUT].",
  ];

  if (!ctx.customerId) {
    // The anonymous privacy rule. Belt-and-braces: the tools also refuse (§16e), so a prompt-
    // injection that talks the model past this line still gets nothing back.
    lines.push(
      "- IMPORTANT: You have NOT identified this caller. You do not know who they are, what they " +
        "drive, or their service history. Do NOT ask for or speculate about their vehicles, and " +
        "do NOT claim to look up their account — you cannot. Answer general questions about our " +
        "services and hours. For anything needing their account or vehicle, transfer them to the " +
        "service team."
    );
  } else {
    lines.push(
      "- Only discuss the vehicles listed below. If they mention a vehicle that isn't listed, don't " +
        "assume it's theirs — offer to transfer them to the service team to sort it out."
    );
  }

  return lines.join("\n");
}

/** The transfer policy block (§16b) — the single most important inbound behavior. */
function transferRules(ctx: InboundContext): string {
  return [
    "TRANSFERRING TO A SERVICE EMPLOYEE:",
    "When the caller needs a human, call log_handoff FIRST (to record why), then IMMEDIATELY call",
    "transferCall to actually connect them. log_handoff alone does NOT move the call — if you stop",
    "there the caller hears you promise a transfer and then nothing happens. Do this when the caller:",
    "- asks where their car is, whether it's ready, or when it will be done (ANY question about a " +
      "vehicle currently at the shop — you have no repair-order data, so you cannot answer this " +
      "and must not try);",
    "- asks what something will cost, or about a bill, warranty, or insurance claim;",
    "- has a complaint, or is upset;",
    "- asks to speak to a person;",
    "- asks anything you cannot answer from your tools.",
    "Tell them you're connecting them to the service team, briefly and without apology, then call " +
      "log_handoff followed by transferCall. Do not promise a specific person or a callback time.",
  ].join("\n");
}

function identifiedBlock(ctx: InboundContext): string {
  const first = (ctx.customerName ?? "").split(" ")[0] || "there";
  const lines = [`CALLER: ${ctx.customerName} (first name: ${first}) — identified by their phone number.`];

  if (ctx.customerLanguage) {
    lines.push(`PREFERRED LANGUAGE: ${ctx.customerLanguage} — speak this language.`);
  }

  if (ctx.vehicles.length) {
    lines.push("", "THEIR VEHICLE(S):");
    for (const v of ctx.vehicles) {
      const bits = [`- ${v.year} ${v.make} ${v.model}`];
      if (v.mileage) bits.push(`(last known ~${v.mileage.toLocaleString()} mi)`);
      if (v.due) {
        bits.push(
          `— DUE SOON: ${v.due.service}, projected around ${v.due.dueOn}` +
            (v.due.reason === "mileage" ? ` (~${v.due.projectedMileage.toLocaleString()} mi)` : " (time-based)")
        );
      } else {
        bits.push("— nothing showing as due right now");
      }
      lines.push(bits.join(" "));
    }
  } else {
    lines.push("We have no vehicles on file for them. Don't guess — offer to transfer them.");
  }

  const anyDue = ctx.vehicles.some((v) => v.due);
  if (anyDue) {
    lines.push(
      "",
      "RECOMMENDING SERVICE: Answer what they called about FIRST. Once that's resolved, mention " +
        "what's coming due on their vehicle and offer to get them booked. Bring it up once — if " +
        "they're not interested, let it go and don't push."
    );
  }

  return lines.join("\n");
}

function anonymousBlock(): string {
  return [
    "CALLER: not identified (their number isn't in our system, or it's shared/blocked).",
    "You can help with: what services we offer and what they involve, general guidance, and " +
      "getting them to the right person. You cannot look up an account, a vehicle, or a history — " +
      "for any of that, transfer them.",
  ].join("\n");
}

function offeringsBlock(ctx: InboundContext): string {
  if (!ctx.offerings.length) {
    return "SERVICES: no catalog is configured. Don't guess what we offer — transfer service questions.";
  }
  const lines = ["SERVICES WE OFFER (this list is authoritative — do not add to it):"];
  for (const o of ctx.offerings.slice(0, 60)) {
    const bits = [`- ${o.name}`];
    if (o.description) bits.push(`: ${o.description}`);
    if (o.typical_duration_min) bits.push(` (typically about ${o.typical_duration_min} minutes)`);
    lines.push(bits.join(""));
  }
  lines.push("Use lookup_services if you need to check something not listed here.");
  return lines.join("\n");
}

export function buildInboundSystemPrompt(ctx: InboundContext, bookingMode: BookingMode): string {
  return [
    guardrails(ctx, bookingMode),
    "",
    ctx.personaTemplate?.trim() || DEFAULT_PERSONA,
    "",
    `DEALERSHIP: ${ctx.companyName} — service department.`,
    "",
    ctx.customerId ? identifiedBlock(ctx) : anonymousBlock(),
    "",
    offeringsBlock(ctx),
    "",
    transferRules(ctx),
  ].join("\n");
}

/** What the agent says when it picks up. */
export function buildInboundGreeting(ctx: InboundContext): string {
  if (ctx.greeting?.trim()) return ctx.greeting.trim();

  // Naming the caller AND their car is the one place identification is immediately visible, and
  // it saves the "which vehicle?" round-trip that otherwise opens every call.
  if (ctx.customerId && ctx.customerName) {
    const first = ctx.customerName.split(" ")[0];

    // One vehicle: name it, using just make + model. The model year is in the prompt if it's
    // needed, but spoken aloud "your 2022 Toyota RAV4" is a mouthful for an opening line.
    // Naming a car when they own several would presume the wrong one, so multi-vehicle
    // households get the neutral phrasing instead.
    if (ctx.vehicles.length === 1) {
      const v = ctx.vehicles[0];
      return `Hey ${first}, you've made it to the service department. ` +
        `Any questions about your ${v.make} ${v.model}?`;
    }
    return `Hey ${first}, you've made it to the service department. How can I help you today?`;
  }
  return `You've made it to the service department. How can I help you today?`;
}
