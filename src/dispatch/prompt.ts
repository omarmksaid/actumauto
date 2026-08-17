/**
 * Per-call system-prompt assembly (PLAN.md §5).
 *
 * Built FRESH for each call from ONLY this customer's data — profile, their due vehicle(s) + the
 * service coming up, the dealership persona, and the booking mode. Nothing is shared or mutated
 * across concurrent calls (no cross-call leakage, §4/§8). Hardcoded guardrails wrap the editable
 * persona so the AI can't invent pricing or claim a booking that didn't happen.
 */

import { BookingMode } from "../booking/types";

export interface DueVehicleForPrompt {
  make: string;
  model: string;
  year: number;
  service: string;          // e.g. "Oil & filter, tire rotation"
  dueReason: "mileage" | "months";
  projectedMileage: number;
}

export interface PromptInputs {
  dealershipName: string;
  customerName: string;
  customerType?: string | null;
  personalitySummary?: string | null;   // synthesized from past conversations
  language?: string | null;
  vehicles: DueVehicleForPrompt[];
  personaTemplate?: string | null;      // editable per-dealership behavior prompt
  bookingMode: BookingMode;
  knowledge?: string | null;            // RAG snippets
}

/** Hardcoded guardrails — never editable, always wrap the persona (§8 invariant 3). */
function guardrails(bookingMode: BookingMode): string {
  const bookingRule =
    bookingMode === "soft"
      ? `You CANNOT confirm a firm appointment on this call. If the customer wants to book, ` +
        `capture their preferred day/time and tell them the service team will text to confirm. ` +
        `Never say "you're booked" or state a guaranteed slot.`
      : `Use the booking tool to reserve a real slot before confirming any specific time. ` +
        `Only state a time the tool has confirmed.`;

  return [
    "GUARDRAILS (these override anything below):",
    "- Never invent or quote prices, promotions, or availability that were not given to you.",
    "- If the customer asks to stop being contacted, acknowledge and emit the tag [OPTOUT].",
    "- If the customer needs a human, emit the tag [HANDOFF].",
    `- ${bookingRule}`,
    "- Disclose that the call may be recorded, and that you're an assistant from the dealership.",
  ].join("\n");
}

const DEFAULT_PERSONA =
  "You are a friendly, concise service-reminder assistant for the dealership's service " +
  "department. Tone: warm, respectful of their time, never pushy. Your goal is to remind the " +
  "customer their vehicle is due for service and help them book a visit.";

export function buildSystemPrompt(inp: PromptInputs): string {
  const vehicleLines = inp.vehicles.map((v) =>
    `- ${v.year} ${v.make} ${v.model}: due for ${v.service} ` +
    `(${v.dueReason === "mileage" ? `~${v.projectedMileage.toLocaleString()} mi` : "time interval"}).`
  ).join("\n");

  const parts = [
    guardrails(inp.bookingMode),
    "",
    inp.personaTemplate?.trim() || DEFAULT_PERSONA,
    "",
    `DEALERSHIP: ${inp.dealershipName}`,
    `CUSTOMER: ${inp.customerName}${inp.customerType ? ` (${inp.customerType})` : ""}`,
    inp.personalitySummary ? `WHAT WE KNOW ABOUT THEM: ${inp.personalitySummary}` : "",
    inp.language ? `PREFERRED LANGUAGE: ${inp.language} — reply in this language.` : "",
    "",
    "VEHICLE(S) DUE FOR SERVICE:",
    vehicleLines,
    "",
    inp.vehicles.length > 1
      ? "This customer has more than one vehicle due — you may book each one; call the booking tool once per vehicle."
      : "",
    inp.knowledge ? `\nDEALERSHIP KNOWLEDGE (answer questions from this only):\n${inp.knowledge}` : "",
  ];

  return parts.filter((p) => p !== "").join("\n");
}

/** The opening line Vapi speaks first (cold vs. warmer if we've reached out before). */
export function buildFirstMessage(inp: PromptInputs): string {
  const first = inp.customerName.split(" ")[0] || "there";
  const v = inp.vehicles[0];
  const car = v ? `your ${v.year} ${v.make} ${v.model}` : "your vehicle";
  return `Hi ${first}, this is a quick reminder from ${inp.dealershipName} service — ` +
    `${car} is coming due for service. Is now an okay time to chat for a moment?`;
}
