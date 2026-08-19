/**
 * Point the inbound agent at a specific TTS voice.
 *
 *   npx tsx scripts/set-voice.ts cartesia <voice-id>
 *   npx tsx scripts/set-voice.ts vapi                  # back to the built-in default
 *
 * Writes companies.settings.inbound.voice, which resolveVoice() prefers over the env default.
 * Per-dealership, so different dealerships can sound different.
 *
 * NOTE: for cartesia/11labs the API key lives in VAPI's provider settings, not our .env —
 * Vapi makes the TTS call, we only name the voice.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

async function main() {
  const provider = process.argv[2];
  const voiceId = process.argv[3];
  if (!provider) { console.error("usage: set-voice.ts <provider> [voiceId]"); process.exit(1); }
  if (provider !== "vapi" && !voiceId) { console.error(`a voiceId is required for ${provider}`); process.exit(1); }

  const sb = createClient((process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false }, realtime: { transport: ws as any } });

  const { data: co } = await sb.from("companies").select("id, name, settings").limit(1).single();
  if (!co) { console.error("no company found"); process.exit(1); }

  const settings = { ...((co.settings ?? {}) as any) };
  settings.inbound = { ...(settings.inbound ?? {}) };
  settings.inbound.voice = provider === "vapi"
    ? null                                   // null ⇒ fall through to the built-in default
    : { provider, voice_id: voiceId };

  const { error } = await sb.from("companies").update({ settings }).eq("id", co.id);
  if (error) { console.error("failed:", error.message); process.exit(1); }

  console.log(`${co.name}: voice -> ${provider}${voiceId ? ` / ${voiceId}` : " (built-in)"}`);
  console.log("Next call picks it up — no restart needed.");
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
