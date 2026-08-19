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
  "You are the service center's phone assistant for the dealership. Tone: warm, efficient, " +
  "and genuinely helpful — you are answering someone who called in, so let them lead. Keep " +
  "answers short and conversational; this is a phone call, not an essay.";

/**
 * How much to say at once. Spoken detail can't be skimmed — a caller can't skip ahead the way a
 * reader can, so reciting what a service includes before they've asked buries the one thing they
 * actually wanted. Confirm, offer, wait.
 */
const PACING_RULES = [
  "HOW MUCH TO SAY:",
  "- Answer in one or two sentences, then stop. Let the caller steer.",
  "- Confirm we do something before describing it. \"Yes, we handle AC work — want me to tell",
  "  you what that includes?\" Only walk through the details if they say yes.",
  "- Never recite a list of services, durations, or what a job includes unless the caller asked",
  "  for it. One service, one sentence.",
  "- When they describe a symptom, ask what's happening before proposing a fix — the symptom",
  "  often points at a different service than the obvious one.",
  "- Don't stack a description AND a question in the same breath. Ask one thing at a time.",
  "- No markdown, bullets, or asterisks — every word here is spoken aloud.",
].join("\n");

/**
 * Hardcoded guardrails — never editable, always wrap the persona. The privacy and handoff rules
 * are the load-bearing ones for inbound (§16a/§16b).
 */
function guardrails(ctx: InboundContext, bookingMode: BookingMode): string {
  const bookingRule =
    bookingMode === "soft"
      ? `You CANNOT confirm a firm appointment. If they want to book, use the book_service tool ` +
        `to capture their preferred day/time, then tell them the service team will text to ` +
        `confirm. Never say "you're booked" or state a guaranteed slot. Before booking, say ` +
        `which vehicle it's for and let them correct you — never assume silently, even when ` +
        `they only have one car on file.`
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
    "- Disclose that you're an assistant with the dealership's service center, and that the " +
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

/**
 * Ending the call. Vapi exposes an end-call function, but without instruction the agent never
 * uses it — so a finished conversation just sits there with both parties waiting.
 */
const CLOSING_RULES = [
  "ENDING THE CALL:",
  "- When the caller's reason for calling is resolved and they have nothing else, close warmly",
  "  in one short line and END THE CALL. Don't leave the line open.",
  "- Before closing, ask once whether there's anything else. If they say no, that's your cue.",
  "- After a booking is captured, confirm what happens next in one sentence, offer any due",
  "  service ONCE, and if they decline or accept, wrap up and end the call.",
  "- If the caller says goodbye, thanks you, or says they're all set, end the call — don't",
  "  restart the conversation with another question.",
  "- Do NOT end the call while transferring; the transfer tool handles that.",
].join("\n");

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

/** Spoken opening hours, so the agent can refuse an out-of-hours time instead of accepting it. */
function hoursBlock(ctx: InboundContext): string {
  const DAYS: [string, string][] = [
    ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
    ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
  ];
  const say = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const hr = h % 12 === 0 ? 12 : h % 12;
    return m ? `${hr}:${String(m).padStart(2, "0")} ${ampm}` : `${hr} ${ampm}`;
  };

  const lines = [`TODAY IS ${ctx.todayLabel}.`, "", "WHEN WE'RE OPEN (dealership local time):"];
  let any = false;
  for (const [key, label] of DAYS) {
    const v = ctx.businessHours?.[key];
    if (v && Array.isArray(v)) { lines.push(`- ${label}: ${say(v[0])} to ${say(v[1])}`); any = true; }
    else lines.push(`- ${label}: closed`);
  }
  if (!any) return "";

  lines.push(
    "NEVER accept an appointment time outside these hours, and never one in the past. If the",
    "caller asks for a time we're closed, say so warmly, name the nearest time we ARE open, and",
    "let them choose. Only call book_service once the time is inside our hours.",
    "You know today's date, so work out what \"tomorrow\" or \"Friday\" means yourself — never ask",
    "the caller what day it is."
  );
  return lines.join("\n");
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
  // KILL SWITCH: don't hold a conversation. Say one line and hand off. Dead air would be worse
  // for the caller than a brief handoff, so we still answer — we just stop being an agent.
  if (!ctx.agentEnabled) {
    return [
      "You are a phone attendant for a car dealership's service center.",
      "Say exactly one short line: that you're connecting them to the service team, then",
      "immediately call log_handoff (reason: out_of_scope) followed by transferCall.",
      "Do NOT answer questions, look anything up, discuss services, or make small talk.",
      "If asked anything, repeat that you're connecting them and transfer.",
    ].join("\n");
  }

  return [
    guardrails(ctx, bookingMode),
    "",
    ctx.personaTemplate?.trim() || DEFAULT_PERSONA,
    "",
    PACING_RULES,
    "",
    `DEALERSHIP: ${ctx.companyName} — service center.`,
    "",
    ctx.customerId ? identifiedBlock(ctx) : anonymousBlock(),
    "",
    offeringsBlock(ctx),
    "",
    hoursBlock(ctx),
    "",
    CLOSING_RULES,
    "",
    transferRules(ctx),
  ].join("\n");
}

/** What the agent says when it picks up. */
export function buildInboundGreeting(ctx: InboundContext): string {
  if (!ctx.agentEnabled) {
    return "Thanks for calling the service center — let me get you to our team right away.";
  }
  if (ctx.greeting?.trim()) return ctx.greeting.trim();

  // Naming the caller AND their car is the one place identification is immediately visible, and
  // it saves the "which vehicle?" round-trip that otherwise opens every call.
  // Greet by name when we know them, then leave the floor open. Naming their vehicle here
  // narrows the conversation before the caller has said what they want — the agent already has
  // the car in its prompt and can raise it once their actual reason is handled.
  if (ctx.customerId && ctx.customerName) {
    const first = ctx.customerName.split(" ")[0];
    return `Hey ${first}, you've made it to the service center. How can I help you today?`;
  }
  return `You've made it to the service center. How can I help you today?`;
}
