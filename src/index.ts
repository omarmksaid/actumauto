import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { requireAuth } from "./lib/auth";
import { importRoutes } from "./routes/imports";
import { startWorker, stopWorker } from "./jobs/worker";

const app = new Hono();
app.use("/*", cors({
  origin: (origin) => origin ?? "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Company-Id"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
}));

app.get("/health", (c) => c.json({ ok: true }));

// ── Authenticated dashboard API (companyId/userId from context, never the body) ──
app.use("/imports/*", requireAuth);
app.route("/imports", importRoutes);

// Webhook routes (Vapi/Telnyx/myKaarma) — provider-authenticated — land in later slices.

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
