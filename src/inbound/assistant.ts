/**
 * Inbound Vapi assistant config (PLAN.md §16e).
 *
 * Returned synchronously from the `assistant-request` webhook. Same provider defaults as outbound
 * (§15: BYO Anthropic key + Haiku for the live loop, Deepgram STT, Cartesia/Aura-2 TTS).
 *
 * THE TOOL CONTRACT (§8 invariant 2, extended to inbound): no tool takes a company_id or a
 * customer_id. Identity is resolved server-side from the Vapi call id and pinned to the call, so
 * the model cannot widen its own access by claiming to be someone else — and an anonymous call
 * gets nothing back regardless of what it asks for.
 */

import { env } from "../lib/env";
import type { InboundContext } from "./identify";
import { buildInboundSystemPrompt, buildInboundGreeting } from "./prompt";
import { getBookingProvider } from "../booking";

/** Recording the handoff — offered in both normal and kill-switch mode. */
function HANDOFF_TOOL(server: any) {
  return (
    // Logs WHY we're handing off and writes the recoverable handoff row. It does NOT move the
    // call — a tool result is just text to the model. The actual leg transfer is Vapi's native
    // transferCall tool below.
    {
      type: "function",
      function: {
        name: "log_handoff",
        description:
          "Record why this caller needs a human, then immediately call transferCall. Use for: " +
          "where is my car / is it ready, pricing or billing, complaints, a request for a person, " +
          "or anything you can't answer.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              enum: ["where_is_my_car", "pricing", "complaint", "requested_human", "out_of_scope", "other"],
              description: "Why you're transferring.",
            },
            vehicle_hint: {
              type: "string",
              description: "Any vehicle the caller mentioned, in their words (e.g. 'silver RAV4'). Optional.",
            },
            notes: { type: "string", description: "One line of context for the advisor picking up." },
          },
          required: ["reason"],
        },
      },
      server,
    }
  );
}

/** Tools the inbound agent can call. The server resolves identity; these carry only intent. */
function toolDefinitions(ctx: InboundContext) {
  const url = `${env.APP_URL}/inbound/tools`;
  // Vapi persists `headers`, not `secret` — a `secret` here is silently dropped and every tool
  // call would arrive unauthenticated (same failure mode as the phone-number config, see SETUP).
  const server = { url, headers: { "x-vapi-secret": env.VAPI_WEBHOOK_SECRET } };

  // With the kill switch on the agent must not answer anything, so the services tool is withheld.
  const tools: any[] = ctx.agentEnabled ? [
    {
      type: "function",
      function: {
        name: "lookup_services",
        description:
          "Look up services this dealership offers. Use when the caller asks whether we do " +
          "something, or what a service involves. Returns only real catalog entries — never prices.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What the caller asked about, e.g. 'brakes', 'alignment'." },
          },
          required: ["query"],
        },
      },
      server,
    },
  ] : [];

  // Recording the handoff works in both modes.
  tools.push(HANDOFF_TOOL(server));

  // Vapi's NATIVE transfer. Only this actually moves the call leg; without it the agent says
  // "connecting you now" and the caller sits there — which is worse than refusing outright.
  if (ctx.transferNumber) {
    tools.push({
      type: "transferCall",
      destinations: [{
        type: "number",
        number: ctx.transferNumber,
        message: "Connecting you to our service team now.",
      }],
    });
  }

  // Customer-scoped tools are only OFFERED on an identified call, and never while the kill
  // switch is on. They also refuse server-side (defense in depth) — but not advertising them
  // keeps the model from trying.
  if (ctx.customerId && ctx.agentEnabled) {
    tools.push(
      {
        type: "function",
        function: {
          name: "get_my_vehicles",
          description:
            "Get the caller's vehicles on file. Use if they ask what we have for them, or you " +
            "need to confirm which car they mean.",
          parameters: { type: "object", properties: {} },
        },
        server,
      },
      {
        type: "function",
        function: {
          name: "get_due_service",
          description:
            "Get what service is coming due on the caller's vehicles, and what it involves. Use " +
            "after resolving what they called about, to recommend service.",
          parameters: { type: "object", properties: {} },
        },
        server,
      },
      {
        type: "function",
        function: {
          name: "book_service",
          description:
            "Capture a service appointment request for the caller. Call once per vehicle. Use the " +
            "wording this tool returns — do not promise a firm time it didn't confirm.",
          parameters: {
            type: "object",
            properties: {
              preferred_time: {
                type: "string",
                description: "The day/time the caller asked for, in their words (e.g. 'Tuesday morning').",
              },
              vehicle_id: {
                type: "string",
                description: "The id from get_my_vehicles for the car being booked. Omit if only one vehicle.",
              },
              service_ops: {
                type: "array",
                items: { type: "string" },
                description: "What they're coming in for.",
              },
              notes: { type: "string", description: "Anything the advisor should know." },
            },
            required: ["preferred_time"],
          },
        },
        server,
      }
    );
  }

  return tools;
}


/**
 * Vapi's TTS block. A provider with an EMPTY voiceId fails the pipeline instantly
 * (`pipeline-error-<provider>-voice-failed`) and the caller hears silence, so never emit one:
 * fall back to a provider/voice pair that works out of the box with no extra credentials.
 */
function resolveVoice(voice: { provider: string; voice_id: string }) {
  if (voice.voice_id?.trim()) {
    const v: any = { provider: voice.provider, voiceId: voice.voice_id.trim() };
    // Vapi's own voices default to the legacy V1 model unless version is set. V2 is both better
    // quality and much cheaper — TTS was $0.12 of a $0.36 call at V1 rates.
    if (voice.provider === "vapi") v.version = 2;
    return v;
  }
  // No voice configured — fall back to a Vapi-managed one, which needs no provider credentials.
  return { provider: "vapi", voiceId: "Elliot", version: 2 };
}

export function buildInboundAssistant(ctx: InboundContext, voice: { provider: string; voice_id: string }) {
  const bookingMode = getBookingProvider().mode;

  return {
    name: `${ctx.companyName} — inbound service`,
    firstMessage: buildInboundGreeting(ctx),
    model: {
      provider: "anthropic",
      model: env.LLM_MODEL_CALL,                 // Haiku: cheaper AND lower latency in a voice loop (§15)
      messages: [{ role: "system", content: buildInboundSystemPrompt(ctx, bookingMode) }],
      tools: toolDefinitions(ctx),
    },
    voice: resolveVoice(voice),
    transcriber: { provider: "deepgram", language: "multi" },
    maxDurationSeconds: 900,                     // inbound runs longer than a reminder call
    endCallFunctionEnabled: true,
    recordingEnabled: true,
    // Identifiers only — no per-caller content in metadata (§4 no-leakage rule).
    metadata: {
      direction: "inbound",
      companyId: ctx.companyId,
      customerId: ctx.customerId,
    },
    server: {
      url: `${env.APP_URL}/webhooks/vapi`,
      headers: { "x-vapi-secret": env.VAPI_WEBHOOK_SECRET },
    },
  };
}
