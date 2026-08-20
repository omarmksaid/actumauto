import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { requireAuth } from "./lib/auth";
import { importRoutes } from "./routes/imports";
import { agentRoutes } from "./routes/agent";
import { settingsRoutes } from "./routes/settings";
import { scheduleRoutes } from "./routes/schedules";
import { teamRoutes, acceptInvite, lookupInvite } from "./routes/team";
import { vapiWebhooks } from "./routes/webhooks/vapi";
import { inboundRoutes } from "./routes/inbound";
import { leadRoutes } from "./routes/leads";
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

// ── Inbound service line (§16) — provider-authenticated via the Vapi shared secret.
// Answers synchronously (assistant config + in-call tools), so it is NOT a durable-inbox path.
app.route("/inbound", inboundRoutes);     // /inbound/assistant, /inbound/tools

// ── Contact sales (public marketing form; rate-limited, service-role write) ──
app.route("/leads", leadRoutes);

// ── Unsubscribe (public) ──
// We no longer send outbound campaigns, so there is nothing to cancel — but the link still has to
// work: it appears in previously-sent email, and honoring it remains a legal obligation.
app.get("/u/:customerId", async (c) => {
  await supabaseAdmin.from("customers")
    .update({ opted_out: true }).eq("id", c.req.param("customerId"));
  return c.html("<p>You've been unsubscribed. Thank you.</p>");
});

// ── Authenticated dashboard API (companyId/userId from context, never the body) ──
app.use("/imports/*", requireAuth);
app.route("/imports", importRoutes);
app.use("/agent/*", requireAuth);
app.route("/agent", agentRoutes);
app.use("/settings/*", requireAuth);
app.route("/settings", settingsRoutes);
app.use("/schedules/*", requireAuth);
app.route("/schedules", scheduleRoutes);

// Team: accept/lookup are public (pre-membership); the rest require auth.
app.get("/team/invite", lookupInvite);   // token → the email it was issued to
app.post("/team/accept", acceptInvite);   // JWT-verified but pre-membership
app.use("/team/*", requireAuth);
app.route("/team", teamRoutes);

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
