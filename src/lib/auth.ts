import { MiddlewareHandler } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { supabaseAdmin } from "./supabase";
import { env } from "./env";

/**
 * Auth model (unchanged from realtyAI — the pattern is sound):
 * 1. Dashboard sends the Supabase session JWT as `Authorization: Bearer <jwt>`.
 * 2. Verify via Supabase's JWKS endpoint (ES256) with an HS256 fallback.
 * 3. Resolve memberships and pin the request to ONE company (dealership):
 *    - `X-Company-Id` header if the user belongs to it (multi-dealership users),
 *    - otherwise their single membership.
 * 4. Handlers read companyId/userId from context — NEVER from the request body.
 *
 * Webhook routes (/webhooks/*) do NOT use this — they authenticate the provider
 * instead (Vapi shared secret, Telnyx signature, myKaarma key).
 */

const JWKS = createRemoteJWKSet(
  new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);
const hmacSecret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

/** One verifier, one place to fix. Exported so acceptInvite can reuse it. */
export async function verifyJwt(token: string): Promise<{ sub: string; email?: string }> {
  try {
    const { payload } = await jwtVerify(token, JWKS);
    return { sub: payload.sub as string, email: (payload as any).email };
  } catch {}
  try {
    const { payload } = await jwtVerify(token, hmacSecret, { audience: "authenticated" });
    return { sub: payload.sub as string, email: (payload as any).email };
  } catch {}
  try {
    const { payload } = await jwtVerify(token, hmacSecret);
    return { sub: payload.sub as string, email: (payload as any).email };
  } catch (err) {
    throw err;
  }
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "missing bearer token" }, 401);

  let userId: string;
  try {
    const result = await verifyJwt(token);
    userId = result.sub;
    if (!userId) throw new Error("no sub");
  } catch (err) {
    console.error("JWT verification failed:", (err as Error).message);
    return c.json({ error: "invalid or expired token" }, 401);
  }

  const { data: memberships } = await supabaseAdmin
    .from("memberships").select("company_id, role").eq("user_id", userId);
  if (!memberships?.length) return c.json({ error: "no company membership" }, 403);

  const requested = c.req.header("x-company-id");
  const membership = requested
    ? memberships.find(m => m.company_id === requested)
    : memberships[0];
  if (!membership) return c.json({ error: "not a member of that company" }, 403);

  c.set("userId", userId);
  c.set("companyId", membership.company_id);
  c.set("role", membership.role);
  await next();
};

/** Restrict a route to owners/admins (e.g. changing prompts, voices, cadences, number pool). */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const role = c.get("role");
  if (role !== "owner" && role !== "admin") return c.json({ error: "admin required" }, 403);
  await next();
};

/** Platform operator gate: verified JWT + a row in platform_admins. */
export const requirePlatformAdmin: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "missing bearer token" }, 401);
  let userId: string;
  try {
    const result = await verifyJwt(token);
    userId = result.sub;
    if (!userId) throw new Error("no sub");
  } catch { return c.json({ error: "invalid or expired token" }, 401); }

  const { data } = await supabaseAdmin
    .from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (!data) return c.json({ error: "platform admin required" }, 403);
  c.set("userId", userId);
  await next();
};
