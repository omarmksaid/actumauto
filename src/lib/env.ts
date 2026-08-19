import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  /** This API's own public origin. Providers call back here (Vapi, Telnyx, myKaarma). */
  APP_URL: req("APP_URL"),
  /** The dashboard's origin. Anything a *person* clicks — invite links, booking links,
   *  unsubscribe — lives in the Next.js app, not here. */
  WEB_URL: process.env.WEB_URL || req("APP_URL"),

  // Supabase (session-mode pooler for pg-boss — see .env.example note).
  DATABASE_URL: req("DATABASE_URL"),
  SUPABASE_URL: req("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: req("SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_JWT_SECRET: req("SUPABASE_JWT_SECRET"),

  // Anthropic (BYO key). Haiku for the live voice loop, Sonnet for offline jobs (§15).
  ANTHROPIC_API_KEY: req("ANTHROPIC_API_KEY"),
  LLM_MODEL_CALL: process.env.LLM_MODEL_CALL ?? "claude-haiku-4-5-20251001",
  LLM_MODEL_OFFLINE: process.env.LLM_MODEL_OFFLINE ?? "claude-sonnet-4-6",

  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY ?? "",

  // Telnyx telephony (voice numbers + SMS) — §15.
  TELNYX_API_KEY: process.env.TELNYX_API_KEY ?? "",
  TELNYX_MESSAGING_PROFILE_ID: process.env.TELNYX_MESSAGING_PROFILE_ID ?? "",

  // Vapi voice orchestrator. BOTH are required: the inbound assistant/tools endpoints and the
  // webhook authenticate on VAPI_WEBHOOK_SECRET, and an empty secret rejects EVERY inbound call
  // with a 401 that looks like a Vapi problem rather than a config one. Fail at boot instead.
  VAPI_API_KEY: req("VAPI_API_KEY"),
  VAPI_WEBHOOK_SECRET: req("VAPI_WEBHOOK_SECRET"),
  DEFAULT_TTS_PROVIDER: process.env.DEFAULT_TTS_PROVIDER ?? "cartesia",
  DEFAULT_VOICE_ID: process.env.DEFAULT_VOICE_ID ?? "",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY ?? "",

  // Email.
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
  EMAIL_FROM: process.env.EMAIL_FROM ?? "",

  // myKaarma booking (later; `soft` mode until configured — §2).
  MYKAARMA_API_KEY: process.env.MYKAARMA_API_KEY ?? "",
  MYKAARMA_DEALER_ID: process.env.MYKAARMA_DEALER_ID ?? "",

  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE ?? "America/Los_Angeles",
};
