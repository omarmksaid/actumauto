/**
 * Public "Contact sales" endpoint.
 *
 * Unauthenticated by design — it's a marketing form. That makes it the only route a stranger can
 * write to, so it validates hard, caps field lengths, and rate-limits by IP. Leads are stored
 * rather than emailed: Resend isn't configured, and a lead that exists only in an unsent email
 * is a lead lost.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";

export const leadRoutes = new Hono();

/** In-memory IP throttle. Resets on deploy, which is fine — it's a speed bump, not a wall. */
const recent = new Map<string, number[]>();
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear();   // crude bound on memory
  return hits.length > MAX_PER_WINDOW;
}

const clean = (v: unknown, max: number): string =>
  String(v ?? "").trim().slice(0, max);

leadRoutes.post("/", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip") ?? "unknown";
  if (rateLimited(ip)) return c.json({ error: "Too many requests. Please try again shortly." }, 429);

  const b = await c.req.json<any>().catch(() => ({}));

  const firstName = clean(b.first_name, 80);
  const lastName = clean(b.last_name, 80);
  const dealershipName = clean(b.dealership_name, 160);
  if (!firstName || !lastName || !dealershipName) {
    return c.json({ error: "First name, last name, and dealership name are required." }, 422);
  }

  const email = clean(b.email, 160);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "That email address doesn't look right." }, 422);
  }

  const { error } = await supabaseAdmin.from("sales_leads").insert({
    first_name: firstName,
    last_name: lastName,
    dealership_name: dealershipName,
    dealership_address: clean(b.dealership_address, 400) || null,
    email: email || null,
    phone: clean(b.phone, 40) || null,
    notes: clean(b.notes, 1000) || null,
    source_ip: ip,
    user_agent: clean(c.req.header("user-agent"), 300) || null,
  });

  if (error) {
    console.error("[leads] insert failed:", error.message);
    return c.json({ error: "Something went wrong. Please try again." }, 500);
  }

  console.log(`[leads] ${dealershipName} — ${firstName} ${lastName}`);
  return c.json({ ok: true });
});
