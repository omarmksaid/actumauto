import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { env } from "./env";

// Service-role client for workers/webhooks (bypasses RLS — server only, never ship to browser).
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws as any },
});
