/**
 * Team API (PLAN.md §7). An admin invites service advisors under the dealership; they accept via
 * an emailed link, which creates their membership. Roles: owner | admin | advisor.
 *
 * requireAuth routes: GET / (members + pending invites), POST /invites, DELETE /invites  [admin].
 * Public (pre-membership): GET /team/invite?token (lookup), POST /team/accept (JWT-verified).
 */

import { Hono } from "hono";
import { randomBytes } from "crypto";
import { Resend } from "resend";
import { supabaseAdmin } from "../lib/supabase";
import { verifyJwt } from "../lib/auth";
import { env } from "../lib/env";

export const teamRoutes = new Hono();

const adminOnly = (c: any) => c.get("role") === "owner" || c.get("role") === "admin";

teamRoutes.get("/", async (c) => {
  const companyId = c.get("companyId" as never) as string;
  const [{ data: members }, { data: invites }] = await Promise.all([
    supabaseAdmin.from("memberships").select("user_id, email, role, phone").eq("company_id", companyId),
    supabaseAdmin.from("invites").select("email, role, expires_at, accepted_at")
      .eq("company_id", companyId).is("accepted_at", null),
  ]);
  return c.json({ members: members ?? [], invites: invites ?? [] });
});

async function sendInviteEmail(companyId: string, email: string, token: string) {
  if (!env.RESEND_API_KEY) return; // dev without email: the invite row still exists; link is logged.
  const { data: co } = await supabaseAdmin.from("companies").select("name").eq("id", companyId).single();
  const link = `${env.WEB_URL}/join?token=${token}`;
  console.log(`[invite] ${email} → ${link}`);
  const resend = new Resend(env.RESEND_API_KEY);
  await resend.emails.send({
    from: env.EMAIL_FROM,
    to: email,
    subject: `You've been invited to ${co?.name ?? "a dealership"} on Touchpoint Center`,
    text: `You've been invited to join ${co?.name ?? "the dealership"}'s Touchpoint Center workspace.\n\n` +
      `Accept here (link expires in 7 days):\n${link}`,
  });
}

teamRoutes.post("/invites", async (c) => {
  if (!adminOnly(c)) return c.json({ error: "admin required" }, 403);
  const companyId = c.get("companyId" as never) as string;
  const { email, role } = await c.req.json<{ email: string; role?: string }>();
  if (!email) return c.json({ error: "email required" }, 422);

  const token = randomBytes(24).toString("base64url");
  const { error } = await supabaseAdmin.from("invites").insert({
    company_id: companyId, email: email.toLowerCase(),
    role: role === "admin" || role === "owner" ? role : "advisor",
    token, invited_by: c.get("userId" as never) as string,
  });
  if (error) return c.json({ error: error.message }, 400);
  await sendInviteEmail(companyId, email, token);
  return c.json({ ok: true });
});

teamRoutes.delete("/invites", async (c) => {
  if (!adminOnly(c)) return c.json({ error: "admin required" }, 403);
  const companyId = c.get("companyId" as never) as string;
  const { email } = await c.req.json<{ email: string }>();
  await supabaseAdmin.from("invites")
    .delete().eq("company_id", companyId).eq("email", email.toLowerCase()).is("accepted_at", null);
  return c.json({ ok: true });
});

/** Public: resolve an invite token to the email + dealership name (locks the signup email). */
export async function lookupInvite(c: any) {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "missing token" }, 400);
  const { data: invites } = await supabaseAdmin
    .from("invites").select("email, company_id")
    .eq("token", token).is("accepted_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const invite = invites?.[0];
  if (!invite) return c.json({ error: "This invite link has expired or already been used." }, 400);
  const { data: co } = await supabaseAdmin.from("companies").select("name").eq("id", invite.company_id).single();
  return c.json({ email: invite.email, company: co?.name ?? null });
}

/** Public but JWT-verified (the user just signed up/in): create their membership from the invite. */
export async function acceptInvite(c: any) {
  const header = c.req.header("authorization") ?? "";
  const jwt = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!jwt) return c.json({ error: "Sign in first, then accept." }, 401);

  let userId: string, userEmail: string;
  try {
    const result = await verifyJwt(jwt);
    userId = result.sub;
    userEmail = result.email ?? "";
  } catch {
    return c.json({ error: "Your sign-in session isn't valid. Please try again." }, 401);
  }

  const body = (await c.req.json()) as { token?: string; phone?: string };
  const { token, phone } = body;
  if (!token) return c.json({ error: "This invite link is missing its token." }, 400);

  const { data: invites } = await supabaseAdmin
    .from("invites").select("*").eq("token", token)
    .is("accepted_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const invite = invites?.[0];
  if (!invite) return c.json({ error: "This invite link has expired or already been used." }, 400);

  // Create (or upsert) the membership, then mark the invite accepted.
  const { error: mErr } = await supabaseAdmin.from("memberships").upsert({
    user_id: userId, company_id: invite.company_id, role: invite.role,
    email: userEmail || invite.email, phone: phone ?? null,
  }, { onConflict: "user_id,company_id" });
  if (mErr) return c.json({ error: mErr.message }, 400);

  await supabaseAdmin.from("invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);
  return c.json({ ok: true, company_id: invite.company_id });
}
