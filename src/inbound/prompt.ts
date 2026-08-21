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
  "HOW TO TALK (spoken phone call — no markdown, no lists read aloud):",
  "- One or two sentences, then stop. Ask one thing at a time and let the caller steer.",
  "- Confirm we do something before describing it: \"Yes, we handle AC work — want the details?\"",
  "- On a symptom, ask AT MOST ONE clarifying question, then move to booking. You are not",
  "  diagnosing over the phone; a technician has to see the car either way.",
].join("\n");

/**
 * Hardcoded guardrails — never editable, always wrap the persona. The privacy and handoff rules
 * are the load-bearing ones for inbound (§16a/§16b).
 */
function guardrails(ctx: InboundContext, bookingMode: BookingMode): string {
  const bookingRule =
    bookingMode === "soft"
      ? `Never claim a firm booking. Use book_service to capture their preferred time, then say ` +
        `the team will text to confirm. Name the vehicle before booking so they can correct you, ` +
        `and always ask whether they'll wait at the dealership or drop the car off.`
      : `Reserve a real slot with book_service before confirming a time. Only state a time it ` +
        `confirmed back to you.`;

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

  // NOTE: no identified/anonymous branch here. This block is the cache prefix, so it must be
  // byte-identical for every caller at this dealership; the per-call privacy rule lives in the
  // dynamic section instead (see PRIVACY_RULE_* below).
  return lines.join("\n");
}

/**
 * Ending the call. Vapi exposes an end-call function, but without instruction the agent never
 * uses it — so a finished conversation just sits there with both parties waiting.
 */
const CLOSING_RULES = [
  "ENDING THE CALL (this call costs money per minute — converge):",
  "- Say what's booked ONCE. Don't re-summarize or re-confirm what they already confirmed.",
  "- When their reason is resolved, ask once if there's anything else; if not, close in one line",
  "  and END THE CALL. After you say goodbye you are done — never reopen with another question.",
  "- Do NOT end the call while transferring; the transfer tool handles that.",
  "- To change or cancel a visit: list_appointments, read back which one, confirm they're sure,",
  "  then cancel_appointment. Offer to rebook rather than just ending it.",
].join("\n");

/**
 * Rules for a caller we could NOT identify (dynamic — kept out of the cache prefix).
 *
 * These used to be pure refusal: no booking, don't even collect a name. That made an unrecognized
 * number a dead end — the caller was transferred for something the agent could otherwise handle
 * end to end. Now the agent can CREATE the record, so the rules are about the ORDER it does that
 * in, which is the part that decides whether the call feels like help or like an intake form.
 *
 * Reason first, details second. Four questions before the caller gets anything makes someone who
 * only wanted to know if we service transmissions sit through a form; and if they hang up mid-form
 * we've stored a half record for nothing. Their reason is also what tells us whether we need the
 * car at all.
 *
 * The one thing NOT to say is "I see you're a new customer." We don't know that. An unrecognized
 * number is equally a long-standing customer on a shared line, a blocked ID, or a new phone —
 * and telling a ten-year customer they're new is both wrong and audibly wrong.
 */
const PRIVACY_RULE_ANON = [
  "- IMPORTANT: this caller's number isn't on file, so you have NO record for them — no vehicles,",
  "  no history. Never speculate about what they drive or claim to look them up. Do NOT tell them",
  "  they're a new customer: the number may just be shared, blocked, or newly changed. If it comes",
  "  up, say only that you don't see this number on file.",
  "- Your opening line already asked for their name. Take whatever they give and move on — if they",
  "  only give a first name, that's fine for now, don't interrogate them for a surname up front.",
  "- THEN ASK WHAT THEY NEED, and handle it: lookup_services for what we offer, check_service_due",
  "  for what a car is due for. Answer the question they actually called with FIRST.",
  "- ONLY when it's relevant — they're booking, or you need it to answer — ask for the car's year,",
  "  make, and model. Don't collect it just to have it.",
  "- TO BOOK, you need their full name and the car. When they're ready to book: get their first and",
  "  last name if you don't have it yet, then call register_customer with the name and the",
  "  year/make/model. That creates their record. Then check_availability and book_service work",
  "  exactly as they would for an existing customer.",
  "- Offer the SOONEST slot first: call check_availability with NO date to get it. If that doesn't",
  "  suit them, it also returns times further out, or ask what day they'd prefer.",
  "- If they won't give a name or the car, don't push twice — log_handoff and transfer instead.",
  "- Anything needing real history (past visits, a car in the shop, a bill): transfer them.",
].join("\n");

/** Privacy rule for an identified caller. */
const PRIVACY_RULE_KNOWN =
  "- Only discuss the vehicles listed below. If they mention a vehicle that isn't listed, don't " +
  "assume it's theirs — offer to transfer them to the service team to sort it out.";

/** The transfer policy block (§16b) — the single most important inbound behavior. */
function transferRules(ctx: InboundContext): string {
  return [
    "HANDING OFF TO A PERSON — call log_handoff (to record why), then IMMEDIATELY transferCall.",
    "log_handoff alone does NOT move the call; stopping there strands the caller. Do this when they:",
    "- ask where their car is, if it's ready, or when it'll be done (you have no repair-order data);",
    "- ask what something costs, or about a bill, warranty, or insurance;",
    "- have a complaint, are upset, or ask for a person;",
    "- ask anything your tools can't answer.",
    "Say you're connecting them, briefly, then call both tools. Don't promise a person or a time.",
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

  if (ctx.inService) {
    lines.push(
      "",
      `IN THE SHOP RIGHT NOW: their ${ctx.inService.vehicle} is checked in` +
        (ctx.inService.ops.length ? ` for ${ctx.inService.ops.join(", ")}` : "") + ".",
      "You still have NO repair-order status — you can't say how far along it is or when it'll be",
      "ready. Acknowledge the car is here, then transfer for anything about progress or pickup.",
    );
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
    "CALLER: not identified — their number isn't in our system, or it's shared/blocked. Treat " +
      "them as someone we simply don't have on file, NOT as a confirmed new customer.",
    "You CAN: say what we offer and what it involves, work out what a car is due for from what " +
      "they tell you, take their name and car to create a record, and book them in.",
    "You CANNOT: look up any past visit, service history, or a vehicle in the shop — you have no " +
      "record to read. Transfer for any of that.",
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

  const lines = ["WHEN WE'RE OPEN (dealership local time):"];
  let any = false;
  for (const [key, label] of DAYS) {
    const v = ctx.businessHours?.[key];
    if (v && Array.isArray(v)) { lines.push(`- ${label}: ${say(v[0])} to ${say(v[1])}`); any = true; }
    else lines.push(`- ${label}: closed`);
  }
  if (!any) return "";

  lines.push(
    "Never book outside these hours or in the past — name the nearest open time instead.",
    "You know today's date; work out \"tomorrow\" or \"Friday\" yourself, never ask the caller."
  );
  return lines.join("\n");
}

/**
 * The services block. Full descriptions and durations for every service were 903 tokens — 38% of
 * the prompt — re-sent on EVERY turn of every call, which costs both money and time-to-first-token.
 *
 * Names only (~1/5 the size) is enough for the agent to know whether we do something; when it
 * needs what a service involves or how long it takes, lookup_services returns that on demand.
 * Above a threshold we drop even the names and rely entirely on the tool, since a very long list
 * is neither useful to read aloud nor worth re-sending.
 */
const INLINE_SERVICE_LIMIT = 40;

function offeringsBlock(ctx: InboundContext): string {
  if (!ctx.offerings.length) {
    return "SERVICES: no catalog is configured. Don't guess what we offer — transfer service questions.";
  }
  if (ctx.offerings.length > INLINE_SERVICE_LIMIT) {
    return [
      "SERVICES: we have a large catalog. Use lookup_services to check whether we do something",
      "before answering. Never guess — if the tool returns nothing, say we don't offer it and",
      "offer a transfer.",
    ].join("\n");
  }
  return [
    "SERVICES WE OFFER (authoritative — never add to this list):",
    ctx.offerings.map((o) => o.name).join(" · "),
    "Call lookup_services for what a service involves or how long it takes — don't guess either.",
  ].join("\n");
}

/**
 * Prompt caching (Anthropic, via Vapi).
 *
 * Caching keys on an exact PREFIX match, so anything that differs per call invalidates everything
 * after it. The caller's name sat ~1/4 of the way in, which meant ~6,700 chars of fixed rules —
 * guardrails, services, hours, closing and transfer policy — were re-billed on every turn of
 * every call (llmCachedPromptTokens: 0 across a 68k-token call).
 *
 * So the prompt is now strictly two halves:
 *   1. STATIC  — identical for every caller at this dealership, and cacheable.
 *   2. DYNAMIC — who called, what they drive, today's date. Appended last.
 *
 * STATUS: the prefix is ~2,150 tokens and 92% of the prompt, but Vapi still reports
 * llmCachedPromptTokens: 0. Vapi builds the Anthropic request on its own account (no BYO key
 * configured) and exposes no caching flag — cachingEnabled / promptCaching / cacheControl are all
 * rejected as unknown properties. So whether cache_control markers are sent is Vapi's call, not
 * ours. This structure is still correct and costs nothing; it means caching starts working the
 * moment Vapi enables it, or immediately if we move to a BYO Anthropic key.
 */
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

  // ── STATIC half: same bytes for every caller, so it can be cached ──
  const static_ = [
    guardrails(ctx, bookingMode),
    "",
    ctx.personaTemplate?.trim() || DEFAULT_PERSONA,
    "",
    PACING_RULES,
    "",
    `DEALERSHIP: ${ctx.companyName} — service center.`,
    "",
    offeringsBlock(ctx),
    "",
    hoursBlock(ctx),
    "",
    CLOSING_RULES,
    "",
    transferRules(ctx),
  ].join("\n");

  // ── DYNAMIC half: differs per call, so everything above it stays cacheable ──
  const dynamic = [
    "── THIS CALL (these override the general rules above) ──",
    ctx.customerId ? PRIVACY_RULE_KNOWN : PRIVACY_RULE_ANON,
    "",
    `TODAY IS ${ctx.todayLabel}.`,
    "",
    ctx.customerId ? identifiedBlock(ctx) : anonymousBlock(),
  ].join("\n");

  return `${static_}\n\n${dynamic}`;
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
    // Their car is here right now — say so. They're almost certainly calling about it, and
    // making them explain is the thing that annoys people about service lines.
    if (ctx.inService) {
      return `Hey ${first}, you've made it to the service center. I can see your ` +
        `${ctx.inService.vehicle} is with us today — any questions about it?`;
    }
    return `Hey ${first}, you've made it to the service center. How can I help you today?`;
  }
  // Unrecognized number: ask for the name in the greeting itself. It's the one thing we always
  // need from a caller with no record, and asking up front means we're never mid-booking with
  // nothing to attach it to. Note we do NOT say "I see you're new" — an unrecognized number is
  // just as often a long-standing customer on a shared, blocked, or newly-changed line.
  return `Welcome to ${ctx.companyName} service — who do I have the pleasure of speaking with today?`;
}
