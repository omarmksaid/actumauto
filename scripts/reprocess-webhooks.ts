/**
 * Re-enqueue unprocessed webhook_events.
 *
 * This is the payoff of the durable-inbox design (PLAN.md §5b): the raw payloads were stored even
 * though the processing job never ran, so nothing was lost — fix the cause, replay from here.
 *
 *   npx tsx scripts/reprocess-webhooks.ts
 */
import "dotenv/config";
import { boss } from "../src/jobs/queue";
import { processWebhookEvent } from "../src/calls/events";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const { data } = await supabaseAdmin
    .from("webhook_events").select("id, event_type")
    .is("processed_at", null).eq("signature_valid", true)
    .order("received_at", { ascending: true });

  const rows = data ?? [];
  console.log(`${rows.length} unprocessed event(s)`);

  let ok = 0, failed = 0;
  for (const ev of rows) {
    try { await processWebhookEvent(ev.id); ok++; }
    catch (e: any) { failed++; console.error(`  ${ev.event_type}: ${e.message}`); }
  }
  console.log(`processed ${ok}, failed ${failed}`);
  await boss.stop({ graceful: false }).catch(() => {});
}
main().catch((e) => { console.error(e.message); process.exit(1); });
