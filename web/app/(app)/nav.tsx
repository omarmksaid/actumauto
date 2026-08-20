"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient, isDemo } from "@/lib/supabase";
import { apiCall } from "@/lib/api";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/calls", label: "Calls" },
  { href: "/handoffs", label: "Handoffs" },
  { href: "/directory", label: "Customer Directory" },
  { href: "/imports", label: "Imports" },
  { href: "/schedules", label: "Services" },
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
      <div className="brand">Actum<em>Auto</em></div>
      {NAV.map((item) => {
        const active = path === item.href || path.startsWith(item.href + "/");
        return (
          <Link key={item.href} href={item.href} className={`nav-item${active ? " active" : ""}`}>
            {item.label}
          </Link>
        );
      })}
      <div style={{ marginTop: "auto", paddingTop: 16 }}>
        <AgentToggle />
        <button className="nav-item" style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "none", border: "none", font: "inherit" }} onClick={signOut}>
          Sign out
        </button>
      </div>
    </nav>
  );
}

/**
 * Agent kill switch, pinned above Sign out so it's reachable from every page.
 *
 * When something goes wrong on a live call you want this in one click, not buried three levels
 * into Settings. OFF still answers the phone — callers hear one line and are transferred.
 */
function AgentToggle() {
  const [on, setOn] = useState<boolean | null>(isDemo ? true : null);
  const [busy, setBusy] = useState(false);
  const [canEdit, setCanEdit] = useState(isDemo);

  useEffect(() => {
    if (isDemo) return;
    Promise.all([
      apiCall<any>("/settings").catch(() => null),
      apiCall<{ role: string }>("/agent/me").catch(() => ({ role: "advisor" })),
    ]).then(([s, me]) => {
      if (s) setOn(s.agent_enabled !== false);
      setCanEdit(me.role === "owner" || me.role === "admin");
    });
  }, []);

  async function toggle() {
    if (!canEdit || on === null) return;
    const next = !on;
    setBusy(true); setOn(next);                       // optimistic: the switch must feel instant
    try {
      if (!isDemo) await apiCall("/settings", { method: "PUT", body: JSON.stringify({ agent_enabled: next }) });
    } catch {
      setOn(!next);                                    // roll back if the server refused
    } finally { setBusy(false); }
  }

  if (on === null) return null;

  return (
    <div style={{
      padding: "10px 12px", marginBottom: 8, borderRadius: "var(--radius)",
      background: on ? "var(--ok-wash)" : "var(--hot-wash)",
      border: `1px solid ${on ? "var(--ok)" : "var(--hot)"}22`,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: on ? "var(--ok)" : "var(--hot)" }}>
            Agent {on ? "on" : "off"}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.35, marginTop: 1 }}>
            {on ? "Answering calls" : "Transferring everyone"}
          </div>
        </div>
        <button onClick={toggle} disabled={busy || !canEdit}
          title={canEdit ? (on ? "Stop the agent answering" : "Resume answering") : "Admins only"}
          aria-label={`Turn agent ${on ? "off" : "on"}`}
          style={{
            width: 38, height: 22, borderRadius: 999, border: "none", flexShrink: 0, padding: 2,
            cursor: canEdit && !busy ? "pointer" : "not-allowed",
            opacity: canEdit ? 1 : 0.45,
            background: on ? "var(--ok)" : "var(--muted)",
            display: "flex", justifyContent: on ? "flex-end" : "flex-start", alignItems: "center",
            transition: "background .15s",
          }}>
          <span style={{ width: 18, height: 18, borderRadius: "50%", background: "#fff", display: "block" }} />
        </button>
      </div>
    </div>
  );
}
