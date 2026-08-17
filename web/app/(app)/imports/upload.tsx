"use client";

import { useRef, useState } from "react";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";

export function UploadCard({ onUploaded }: { onUploaded: (importId: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please upload a .csv file.");
      return;
    }
    if (isDemo) {
      setError("Demo mode — connect Supabase to upload real files. Showing sample data below.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "customers");
      const { import: imp } = await apiCall<{ import: { id: string } }>("/imports/upload", {
        method: "POST", body: fd,
      });
      onUploaded(imp.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <div
        className="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
      >
        {busy ? "Uploading & parsing…" : (
          <>
            <div style={{ fontWeight: 600, color: "var(--ink)" }}>Drop a CSV here, or click to choose</div>
            <div className="hint" style={{ marginTop: 6 }}>
              Customer + vehicle export from your DMS. Columns can be in any order.
            </div>
          </>
        )}
      </div>
      <input
        ref={inputRef} type="file" accept=".csv,text/csv" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      {error && <div className="banner banner-warn" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  );
}
