"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient, isDemo } from "@/lib/supabase";

// Slice 1 ships Imports; the rest are placeholders that arrive in later slices (PLAN.md §6/§10).
const NAV = [
  { href: "/today", label: "Today" },
  { href: "/directory", label: "Customer Directory" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/imports", label: "Imports" },
  { href: "/calls", label: "Calls" },
  { href: "/handoffs", label: "Handoffs" },
  { href: "/schedules", label: "Service Schedules" },
  { href: "/insights", label: "Insights" },
  { href: "/team", label: "Team" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const path = usePathname();
  const router = useRouter();

  async function signOut() {
    if (isDemo) return;
    await createClient().auth.signOut();
    router.replace("/login");
  }

  return (
    <nav className="sidebar">
      <div className="brand">Touchpoint <em>Center</em></div>
      {NAV.map((item) => {
        const active = path === item.href || path.startsWith(item.href + "/");
        return (
          <Link key={item.href} href={item.href} className={`nav-item${active ? " active" : ""}`}>
            {item.label}
          </Link>
        );
      })}
      <div style={{ marginTop: "auto", paddingTop: 16 }}>
        <button className="nav-item" style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "none", border: "none", font: "inherit" }} onClick={signOut}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
