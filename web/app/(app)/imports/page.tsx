"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoImports, ImportRow } from "@/lib/data";
import { UploadCard } from "./upload";

const STATUS_CHIP: Record<string, string> = {
  done: "chip-ok", importing: "chip-ai", mapped: "chip-muted",
  parsing: "chip-muted", failed: "chip-hot",
};

export default function ImportsPage() {
  const router = useRouter();
  const [imports, setImports] = useState<ImportRow[]>(isDemo ? demoImports : []);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (isDemo) return;
    try {
      const { imports } = await apiCall<{ imports: ImportRow[] }>("/imports");
      setImports(imports);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  return (
    <div>
      <h1 className="page-title">Imports</h1>
      <p className="page-sub">
        Upload a CSV of past service customers. We&apos;ll guess the columns — you confirm the mapping.
      </p>

      <UploadCard onUploaded={(id) => router.push(`/imports/${id}`)} />

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-pad row-between">
          <div className="section-label" style={{ margin: 0 }}>Recent imports</div>
          {isDemo && <span className="chip chip-muted">demo data</span>}
        </div>
        {error && <div className="card-pad"><div className="banner banner-error">{error}</div></div>}
        {loading ? (
          <div className="card-pad muted">Loading…</div>
        ) : imports.length === 0 ? (
          <div className="card-pad muted">No imports yet. Upload a CSV to get started.</div>
        ) : (
          <table>
            <thead>
              <tr><th>File</th><th>Type</th><th>Status</th><th>Rows</th><th>Result</th><th>When</th></tr>
            </thead>
            <tbody>
              {imports.map((im) => (
                <tr key={im.id} className="rowlink" onClick={() => router.push(`/imports/${im.id}`)}>
                  <td>{im.filename}</td>
                  <td><span className="chip chip-muted">{im.kind}</span></td>
                  <td><span className={`chip ${STATUS_CHIP[im.status] ?? "chip-muted"}`}>{im.status}</span></td>
                  <td>{im.row_count ?? "—"}</td>
                  <td className="hint">{resultSummary(im)}</td>
                  <td className="hint">{new Date(im.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function resultSummary(im: ImportRow): string {
  const s = im.stats ?? {};
  if (im.status !== "done") return "—";
  const parts: string[] = [];
  if (s.customers_upserted != null) parts.push(`${s.customers_upserted} customers`);
  if (s.vehicles_upserted != null) parts.push(`${s.vehicles_upserted} vehicles`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  return parts.join(" · ") || "done";
}
