import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

/** Demo mode: with no Supabase URL configured, pages render seeded demo data (PLAN.md §6).
 *  Baked at build time — see realtyAI's isDemo note. */
export const isDemo = !process.env.NEXT_PUBLIC_SUPABASE_URL;
