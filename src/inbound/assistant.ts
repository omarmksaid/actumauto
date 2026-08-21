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
          "Record why they need a human, then immediately call transferCall.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              enum: ["where_is_my_car", "pricing", "complaint", "requested_human", "out_of_scope", "other"],
              description: "Why you're transferring.",
            },
            vehicle_hint: { type: "string", description: "Vehicle they mentioned." },
            notes: { type: "string", description: "One line for the advisor." },
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

  // Suppress Vapi's spoken filler while a tool runs. Left to the model, a real call produced
  // "Just a sec." then "Hold on a sec." as separate utterances before a single lookup, and
  // "Hold on a sec." again on the next one. Our tools return in well under a second, so the
  // filler takes longer than the work it covers. An explicit empty request-start message beats
  // a prompt rule the model can ignore — attached to every function tool below.
  const quiet = [{ type: "request-start", content: "" }];

  // With the kill switch on the agent must not answer anything, so the services tool is withheld.
  const tools: any[] = ctx.agentEnabled ? [
    {
      type: "function",
      function: {
        name: "lookup_services",
        description:
          "Search the service catalog. Real entries only, never prices.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What they asked about, e.g. 'brakes'." },
          },
          required: ["query"],
        },
      },
      server,
      messages: quiet,
    },
  ] : [];

  // Works for anonymous callers too — it reasons from what they tell us about the car, not from
  // any stored record, so nothing about an unidentified account can leak.
  if (ctx.agentEnabled) {
    tools.push({
      type: "function",
      function: {
        name: "check_service_due",
        description:
          "What a vehicle is due for, from details the caller states. Use when you don't have " +
          "their record. Needs make/model/year plus mileage or months since last service.",
        parameters: {
          type: "object",
          properties: {
            make: { type: "string" },
            model: { type: "string" },
            year: { type: "number" },
            mileage: { type: "number", description: "Current odometer." },
            last_service_months_ago: { type: "number" },
            mileage_at_last_service: { type: "number" },
          },
          required: ["make", "model", "year"],
        },
      },
      server,
      messages: quiet,
    });
  }

  // INTAKE. Creating a customer mid-call is what turns an unrecognized number from a dead end
  // into a booking: an appointment needs a record to attach to, and a new caller has none. Only
  // offered when the caller ISN'T already identified — a known customer's record must never be
  // rewritten from a name heard over the phone.
  if (ctx.agentEnabled && !ctx.customerId) {
    tools.push({
      type: "function",
      function: {
        name: "register_customer",
        description:
          "Save a new caller so you can book for them. Needs their full name (first and last). " +
          "Include year/make/model once you know the car — call again to add it later.",
        parameters: {
          type: "object",
          properties: {
            full_name: { type: "string", description: "First and last name, as they said it." },
            callback_number: {
              type: "string",
              description: "ONLY when their caller ID is withheld and you asked for a number to " +
                "reach them on. Never pass a number for a caller whose ID we already have.",
            },
            make: { type: "string" },
            model: { type: "string" },
            year: { type: "number" },
            mileage: { type: "number", description: "Current odometer, if they know it." },
          },
          required: ["full_name"],
        },
      },
      server,
      messages: quiet,
    });
  }

  // BOOKING TOOLS — offered to identified callers AND to new callers, who become identified the
  // moment register_customer runs. Vapi fixes the tool list when the call starts, so withholding
  // these from an anonymous caller would leave the agent unable to book someone it had just
  // registered. book_service still refuses server-side until a customer exists, so offering them
  // early costs nothing.
  if (ctx.agentEnabled) {
    tools.push(
      {
        type: "function",
        function: {
          name: "check_availability",
          description:
            "Open appointment times. Omit `date` for the soonest opening (and the week ahead); " +
            "pass a date, weekday, or 'tomorrow' for a specific day. Always call before offering " +
            "a time, and call it AGAIN with `time` when the caller asks for a particular one — " +
            "results from an earlier call are a sample, not the full schedule.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "Optional. YYYY-MM-DD, a weekday name, or 'tomorrow'. " +
                  "Leave it out to get the next available slot.",
              },
              // Without this the model cannot check a specific time, so it answers "not available"
              // from whatever short sample the previous call returned — on a day that is wide open.
              time: {
                type: "string",
                description: "A specific time the caller asked for, e.g. '11:00 AM'. Pass it " +
                  "with `date` whenever they name a time — never judge availability yourself.",
              },
              days: { type: "number", description: "How many days ahead to scan; default 7." },
              service_minutes: { type: "number", description: "Expected duration; default 45." },
            },
          },
        },
        server,
        messages: quiet,
      },
      {
        type: "function",
        function: {
          name: "book_service",
          description:
            "Capture an appointment request. Use the wording it returns.",
          parameters: {
            type: "object",
            properties: {
              preferred_time: { type: "string", description: "Day/time in their words." },
              starts_at: {
                type: "string",
                description: "The exact slot as YYYY-MM-DDTHH:MM local, from check_availability. " +
                  "Include it whenever you know the specific time — it reserves the slot.",
              },
              vehicle_id: { type: "string", description: "id from get_my_vehicles." },
              vehicle_confirmed: {
                type: "boolean",
                description: "True once the caller has told you which car — including earlier in " +
                  "this call. Never assume; but don't re-ask what they already answered.",
              },
              other_vehicle: {
                type: "string",
                description: "If it's a car we don't have on file, their description of it (e.g. '2024 Tacoma').",
              },
              service_ops: { type: "array", items: { type: "string" } },
              drop_off: { type: "string", enum: ["waiting", "dropping_off"] },
              notes: { type: "string" },
              service_minutes: { type: "number", description: "Expected duration; default 45." },
            },
            required: ["preferred_time"],
          },
        },
        server,
        messages: quiet,
      }
    );
  }

  // Unrecognized callers only. Creates a NEW record; it can never modify an existing customer,
  // which is the write we're not willing to make from an unverified phone call.
  if (ctx.agentEnabled && !ctx.customerId) {
    tools.push({
      type: "function",
      function: {
        name: "create_profile",
        description:
          "Start a record for a caller we don't have on file, so you can book them. Collect their " +
          "name and what they drive first.",
        parameters: {
          type: "object",
          properties: {
            full_name: { type: "string", description: "Their name as they gave it." },
            make: { type: "string", description: "e.g. Toyota" },
            model: { type: "string", description: "e.g. RAV4" },
            year: { type: "number" },
            mileage: { type: "number", description: "Current odometer, if they know it." },
            email: { type: "string" },
          },
          required: ["full_name"],
        },
      },
      server,
      messages: quiet,
    });
  }

  // Recording the handoff works in both modes.
  tools.push({ ...HANDOFF_TOOL(server), messages: quiet });

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
            "The caller's vehicles.",
          parameters: { type: "object", properties: {} },
        },
        server,
        messages: quiet,
      },
      {
        type: "function",
        function: {
          name: "get_due_service",
          description:
            "What's coming due on the caller's vehicles.",
          parameters: { type: "object", properties: {} },
        },
        server,
        messages: quiet,
      },
      {
        type: "function",
        function: {
          name: "list_appointments",
          description:
            "The caller's upcoming appointments.",
          parameters: { type: "object", properties: {} },
        },
        server,
        messages: quiet,
      },
      {
        type: "function",
        function: {
          name: "cancel_appointment",
          description:
            "Cancel an appointment. Confirm which one first.",
          parameters: {
            type: "object",
            properties: {
              appointment_id: { type: "string", description: "id from list_appointments." },
              reason: { type: "string" },
            },
            required: ["appointment_id"],
          },
        },
        server,
        messages: quiet,
      },
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

  // KILL SWITCH: forward the call and say nothing.
  //
  // This used to greet, run an LLM turn, call log_handoff, then transferCall — so the caller
  // heard "let me get you to our team right away" and waited through a model round-trip before
  // anything moved. With the agent switched off there is nothing for a model to decide: the
  // only correct action is to hand the call to a person. Vapi's forwardingPhoneNumber does that
  // at the telephony layer, with no assistant, no greeting, and no tokens spent.
  if (!ctx.agentEnabled && ctx.transferNumber) {
    return { forwardingPhoneNumber: ctx.transferNumber } as any;
  }

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
    // nova-3 handles proper nouns markedly better than nova-2-phonecall, which mangled a caller
    // spelling out a surname letter by letter. A name is the one field we cannot guess from
    // context and the one an advisor needs right — worth the small latency difference.
    // `smartFormat` cleans up numbers and times, which matters because callers say "9 AM".
    transcriber: {
      provider: "deepgram",
      model: "nova-3",
      language: "en",
      smartFormat: true,
      // Cut the pause we wait for before deciding the caller has finished. Vapi's default errs
      // long; a service call is short exchanges, not monologues.
      endpointing: 150,
    },
    // A caller who goes quiet should not sit on an open, billed line. Vapi's default is
    // generous; a service call has no reason to hold 30s of silence.
    silenceTimeoutSeconds: 20,
    // Vapi's default summary narrates the call ("X called to schedule an oil change...") and
    // repeats who/what/when, all of which the appointment row already states. The advisor reads
    // this attached to that row, so the only thing worth writing is what ISN'T in the fields:
    // what they asked that went unanswered, and anything they mentioned about the vehicle.
    analysisPlan: {
      summaryPlan: {
        messages: [
          {
            role: "system",
            content:
              "You are writing a note for a service advisor who is looking at this customer's " +
              "appointment. The row ALREADY shows their name, phone, vehicle, the work requested, " +
              "the time, and whether they're waiting or dropping off. Never repeat any of that, " +
              "and never narrate the call.\n\n" +
              "Write ONLY what the advisor could not otherwise know, as short bullet points:\n" +
              "- questions the caller asked that the assistant could not answer (pricing, how " +
              "long it takes, warranty, loaners, status of a car in the shop)\n" +
              "- symptoms or vehicle details they described (noises, warning lights, mileage)\n" +
              "- anything they asked to be called back about, or seemed unhappy with\n" +
              "- constraints they mentioned (needs it by a time, dropping off early, no ride)\n\n" +
              "If there is nothing beyond the booking itself, reply with exactly: No extra notes.\n" +
              "Be terse. No preamble, no greeting, no summary sentence. Under 40 words.",
          },
          { role: "user", content: "Transcript:\n\n{{transcript}}" },
        ],
      },
    },
    maxDurationSeconds: 900,                     // inbound runs longer than a reminder call
    // Speak the first chunk as soon as a sentence is ready instead of waiting for the whole
    // response — the largest perceived-latency win, since 1.6s of LLM time is otherwise silence.
    responseDelaySeconds: 0,
    llmRequestDelaySeconds: 0,
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
