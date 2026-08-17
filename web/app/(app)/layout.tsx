"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient, isDemo } from "@/lib/supabase";
import { getCompanyId } from "@/lib/api";
import { Nav } from "./nav";

/**
 * Client-side route guard for the (app) group (PLAN.md §7 / STUBBED item 1).
 *
 * getSession() only reads localStorage — it does NOT hit the server — so a revoked user still
 * holds a cached session. The real check is membership: getCompanyId() runs a query, and RLS's
 * my_company_ids() re-reads memberships live, so a removed user gets zero rows immediately and
 * is bounced. In demo mode (no Supabase URL) the guard is a no-op so the UI runs with zero config.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(isDemo);

  useEffect(() => {
    if (isDemo) return;
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.replace("/login"); return; }

      const companyId = await getCompanyId();
      if (!companyId) {
        await supabase.auth.signOut();
        if (!cancelled) router.replace("/login?removed=1");
        return;
      }
      if (!cancelled) setReady(true);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") router.replace("/login");
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, [router, pathname]);

  if (!ready) return null;

  return (
    <div className="shell">
      <Nav />
      <main className="main">{children}</main>
    </div>
  );
}
