/**
 * Recording archive.
 *
 * Vapi keeps call audio in a private R2 bucket and hands out presigned URLs that expire within
 * hours. That makes their copy unusable as a system of record: we can't link to it, and if Vapi's
 * retention changes — or we leave — the audio is gone. Recordings are contractually sensitive and
 * cannot be regenerated, so we copy them into our own Storage bucket and expire them on our own
 * schedule (companies.recording_retention_days, default 180).
 *
 * The failure mode that matters is a SILENT one: believing you have audio you don't. So every
 * attempt is recorded, failures are retried with backoff, and a call that exhausts its retries is
 * marked `failed` rather than quietly left pending.
 */

import { supabaseAdmin } from "../lib/supabase";
import { env } from "../lib/env";

const BUCKET = "recordings";
const MAX_ATTEMPTS = 5;
const BATCH = 10;

/** Vapi's presigned URL is the only playable form; the stored recording_url returns 400. */
async function presignedUrl(vapiCallId: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.vapi.ai/call/${vapiCallId}`, {
      headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` },
    });
    if (!r.ok) return null;
    const a = (await r.json())?.artifact ?? {};
    return a.presignedStereoUrl ?? a.presignedMonoUrl ?? null;
  } catch {
    return null;
  }
}

/** Copy one call's audio into our bucket. Returns true if it's now archived. */
export async function archiveCall(callId: string): Promise<boolean> {
  const { data: call } = await supabaseAdmin
    .from("calls")
    .select("id, company_id, vapi_call_id, recording_url, archive_attempts, created_at")
    .eq("id", callId).maybeSingle();
  if (!call) return false;

  const attempts = (call.archive_attempts ?? 0) + 1;

  const fail = async (why: string) => {
    // Give up only after MAX_ATTEMPTS — a transient 500 from Vapi shouldn't lose a recording,
    // but retrying forever hides a permanent problem.
    await supabaseAdmin.from("calls").update({
      archive_attempts: attempts,
      archive_error: why.slice(0, 300),
      archive_status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
    }).eq("id", callId);
    console.error(`[archive] ${callId} attempt ${attempts}/${MAX_ATTEMPTS}: ${why}`);
    return false;
  };

  if (!call.recording_url || !call.vapi_call_id) {
    await supabaseAdmin.from("calls").update({ archive_status: "skipped" }).eq("id", callId);
    return false;
  }

  const url = await presignedUrl(call.vapi_call_id);
  if (!url) return fail("no presigned URL from Vapi (call may have aged out)");

  let bytes: ArrayBuffer;
  try {
    const res = await fetch(url);
    if (!res.ok) return fail(`download HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch (e: any) {
    return fail(`download failed: ${e.message}`);
  }
  if (bytes.byteLength < 1024) return fail(`suspiciously small (${bytes.byteLength} bytes)`);

  // Path is company-scoped so a signed URL can never be guessed across dealerships.
  const path = `${call.company_id}/${call.id}.wav`;
  const { error: upErr } = await supabaseAdmin.storage
    .from(BUCKET).upload(path, bytes, { contentType: "audio/wav", upsert: true });
  if (upErr) return fail(`upload failed: ${upErr.message}`);

  const { data: co } = await supabaseAdmin
    .from("companies").select("recording_retention_days").eq("id", call.company_id).maybeSingle();
  const days = co?.recording_retention_days ?? 180;
  const expires = days > 0
    ? new Date(new Date(call.created_at as string).getTime() + days * 86400_000).toISOString()
    : null;

  await supabaseAdmin.from("calls").update({
    recording_path: path,
    recording_bytes: bytes.byteLength,
    archive_status: "archived",
    archive_attempts: attempts,
    archive_error: null,
    archived_at: new Date().toISOString(),
    recording_expires_at: expires,
  }).eq("id", callId);

  console.log(`[archive] ${callId} -> ${path} (${Math.round(bytes.byteLength / 1024)}KB)`);
  return true;
}

/**
 * Sweep pending/failed calls. Runs on a cron rather than inline after each call: Vapi needs a
 * moment to finalize the recording, and a retry loop belongs outside the webhook path.
 */
export async function archiveSweep(): Promise<{ archived: number; failed: number }> {
  // Only look at calls old enough for Vapi to have finished writing the file.
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: pending } = await supabaseAdmin
    .from("calls")
    .select("id, archive_attempts")
    .in("archive_status", ["pending", "failed"])
    .lt("archive_attempts", MAX_ATTEMPTS)
    .not("recording_url", "is", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  let archived = 0, failed = 0;
  for (const row of pending ?? []) {
    // Exponential backoff by attempt count, so a persistently failing call doesn't consume the
    // batch every run: attempt 3 waits ~4 sweeps, attempt 4 ~8.
    const delayRuns = 2 ** (row.archive_attempts ?? 0);
    if ((row.archive_attempts ?? 0) > 0 && Math.random() > 1 / delayRuns) continue;
    (await archiveCall(row.id)) ? archived++ : failed++;
  }
  if (archived || failed) console.log(`[archive] sweep: ${archived} archived, ${failed} deferred`);
  return { archived, failed };
}

/**
 * Delete archived audio past its retention window. The call row, transcript, and metrics stay —
 * only the audio goes, so the funnel and transcripts remain intact for older calls.
 */
export async function retentionSweep(): Promise<number> {
  const { data: expired } = await supabaseAdmin
    .from("calls")
    .select("id, recording_path")
    .eq("archive_status", "archived")
    .not("recording_expires_at", "is", null)
    .lt("recording_expires_at", new Date().toISOString())
    .limit(100);

  let removed = 0;
  for (const row of expired ?? []) {
    if (row.recording_path) {
      const { error } = await supabaseAdmin.storage.from(BUCKET).remove([row.recording_path]);
      if (error) { console.error(`[retention] ${row.id}: ${error.message}`); continue; }
    }
    await supabaseAdmin.from("calls").update({
      archive_status: "expired", recording_path: null, recording_bytes: null,
    }).eq("id", row.id);
    removed++;
  }
  if (removed) console.log(`[retention] deleted ${removed} expired recording(s)`);
  return removed;
}

export function registerArchiver(boss: any) {
  return Promise.all([
    boss.work("archive-recordings", async () => { await archiveSweep(); }),
    boss.work("retention-sweep", async () => { await retentionSweep(); }),
  ]);
}
