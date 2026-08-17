import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { requireAuth } from "./lib/auth";
import { importRoutes } from "./routes/imports";
import { agentRoutes } from "./routes/agent";
import { settingsRoutes } from "./routes/settings";
import { campaignRoutes } from "./routes/campaigns";
import { vapiWebhooks } from "./routes/webhooks/vapi";
import { telnyxWebhooks } from "./routes/webhooks/telnyx";
import { supabaseAdmin } from "./lib/supabase";
import { startWorker, stopWorker } from "./jobs/worker";

const app = new Hono();
app.use("/*", cors({
  origin: (origin) => origin ?? "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Company-Id"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
}));

app.get("/health", (c) => c.json({ ok: true }));

// ── Webhooks (provider-authenticated, NOT requireAuth) ──
app.route("/webhooks", vapiWebhooks);     // /webhooks/vapi   (thin durable handler, §5b)
app.route("/webhooks", telnyxWebhooks);   // /webhooks/telnyx (SMS status + inbound STOP)

// ── Unsubscribe (public, atomic opt-out) ──
app.get("/u/:customerId", async (c) => {
  await supabaseAdmin.from("customers")
    .update({ opted_out: true }).eq("id", c.req.param("customerId"));
  // Cancel any scheduled outreach for this customer across channels.
  await supabaseAdmin.from("touchpoints")
    .update({ status: "canceled" })
    .eq("customer_id", c.req.param("customerId")).in("status", ["scheduled", "claiming"]);
  return c.html("<p>You've been unsubscribed from service reminders. Thank you.</p>");
});

// ── Authenticated dashboard API (companyId/userId from context, never the body) ──
app.use("/imports/*", requireAuth);
app.route("/imports", importRoutes);
app.use("/agent/*", requireAuth);
app.route("/agent", agentRoutes);
app.use("/settings/*", requireAuth);
app.route("/settings", settingsRoutes);
app.use("/campaigns/*", requireAuth);
app.route("/campaigns", campaignRoutes);

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, () => console.log(`api listening on :${port}`));

startWorker().catch((e) =>
  console.error("worker failed to start (will retry on next deploy):", e.message));

// Graceful shutdown so Railway restarts don't strand in-flight jobs (§9).
async function shutdown() {
  console.log("SIGTERM received — draining…");
  await stopWorker();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
