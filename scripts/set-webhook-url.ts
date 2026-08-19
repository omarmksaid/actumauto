/**
 * Point the Vapi phone number at this deployment.
 *
 *   npx tsx scripts/set-webhook-url.ts                       # uses APP_URL from env
 *   npx tsx scripts/set-webhook-url.ts https://api.up.railway.app
 *
 * Run after every deploy that changes APP_URL — a tunnel restart, or the first Railway deploy.
 * The number keeps pointing at the OLD url otherwise, and every call 404s or hits a dead tunnel
 * with no error on our side, because the request never arrives.
 */
import "dotenv/config";

async function main() {
  const base = (process.argv[2] ?? process.env.APP_URL ?? "").replace(/\/+$/, "");
  const key = process.env.VAPI_API_KEY ?? "";
  const secret = process.env.VAPI_WEBHOOK_SECRET ?? "";
  if (!base || !key || !secret) {
    console.error("need APP_URL, VAPI_API_KEY and VAPI_WEBHOOK_SECRET"); process.exit(1);
  }
  if (base.includes("localhost")) {
    console.error(`${base} is local — Vapi cannot reach it. Pass a public URL.`); process.exit(1);
  }

  const list = await fetch("https://api.vapi.ai/phone-number", {
    headers: { Authorization: `Bearer ${key}` },
  }).then((r) => r.json());
  const numbers = Array.isArray(list) ? list : [];
  if (!numbers.length) { console.error("no phone numbers in this Vapi account"); process.exit(1); }

  for (const n of numbers) {
    // Vapi silently DROPS server.secret; only server.headers persists (see SETUP).
    const res = await fetch(`https://api.vapi.ai/phone-number/${n.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        server: { url: `${base}/inbound/assistant`, headers: { "x-vapi-secret": secret } },
      }),
    });
    const body = await res.json();
    const ok = (body?.server?.url ?? "").startsWith(base);
    console.log(`  ${n.number}: ${ok ? "->" : "FAILED ->"} ${body?.server?.url ?? body?.message}`);
  }
  console.log(`\n  Verify: curl ${base}/health`);
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });
