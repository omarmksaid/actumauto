"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Slice 1 ships Imports; the rest are placeholders that arrive in later slices (PLAN.md §6/§10).
const NAV = [
  { href: "/today", label: "Today" },
  { href: "/directory", label: "Customer Directory" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/imports", label: "Imports" },
  { href: "/calls", label: "Calls" },
  { href: "/schedules", label: "Service Schedules" },
  { href: "/insights", label: "Insights" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const path = usePathname();
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
    </nav>
  );
}
