/**
 * Import API (PLAN.md §3). All routes are behind requireAuth — companyId comes from context,
 * never the body (§8 invariant 1).
 *
 *  POST /imports/upload        multipart CSV  → stores file, parses headers+sample, auto-guesses map
 *  GET  /imports               list imports for the dealership
 *  GET  /imports/:id           one import (status, column_map, stats, sample)
 *  PUT  /imports/:id/mapping   save the confirmed column_map, validate required fields
 *  POST /imports/:id/run       enqueue the import worker
 */

import { Hono } from "hono";
import Papa from "papaparse";
import { supabaseAdmin } from "../lib/supabase";
import { boss } from "../jobs/queue";
import { guessMapping } from "../imports/guess";
import { coerce } from "../imports/coerce";
import { TARGET_FIELDS, REQUIRED_FIELDS, fieldByKey } from "../imports/fields";

export const importRoutes = new Hono();

const SAMPLE_ROWS = 20;

/** Upload a CSV: store it, parse headers + a sample, return an auto-guessed mapping to confirm. */
importRoutes.post("/upload", async (c) => {
  const companyId = c.get("companyId" as never) as string;
  const userId = c.get("userId" as never) as string;

  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "no file" }, 400);
  const kind = (form["kind"] as string) === "ro" ? "ro" : "customers";

  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true, skipEmptyLines: true, preview: SAMPLE_ROWS,
  });
  const headers = parsed.meta.fields ?? [];
  if (!headers.length) return c.json({ error: "no columns detected" }, 400);

  // Store the raw file in the `imports` bucket under the company.
  const path = `${companyId}/${Date.now()}_${sanitize(file.name)}`;
  const { error: upErr } = await supabaseAdmin.storage.from("imports")
    .upload(path, new Blob([text], { type: "text/csv" }), { upsert: false });
  if (upErr) return c.json({ error: `storage: ${upErr.message}` }, 500);

  const guess = guessMapping(headers);

  const { data: imp, error } = await supabaseAdmin.from("imports").insert({
    company_id: companyId, filename: file.name, storage_path: path, kind,
    column_map: guess.columnMap, status: "parsing", created_by: userId,
    stats: { headers, confidence: guess.confidence },
  }).select("*").single();
  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    import: imp,
    headers,
    targetFields: TARGET_FIELDS,
    guess: guess.columnMap,
    confidence: guess.confidence,
    sample: parsed.data.slice(0, SAMPLE_ROWS),
  });
});

importRoutes.get("/", async (c) => {
  const companyId = c.get("companyId" as never) as string;
  const { data } = await supabaseAdmin.from("imports")
    .select("id, filename, kind, status, row_count, stats, created_at")
    .eq("company_id", companyId).order("created_at", { ascending: false }).limit(50);
  return c.json({ imports: data ?? [] });
});

importRoutes.get("/:id", async (c) => {
  const companyId = c.get("companyId" as never) as string;
  const { data: imp } = await supabaseAdmin.from("imports")
    .select("*").eq("id", c.req.param("id")).eq("company_id", companyId).maybeSingle();
  if (!imp) return c.json({ error: "not found" }, 404);
  return c.json({ import: imp, targetFields: TARGET_FIELDS });
});

/** Save the confirmed mapping. Validates that every required target field is mapped. */
importRoutes.put("/:id/mapping", async (c) => {
  const companyId = c.get("companyId" as never) as string;
  const body = await c.req.json<{ columnMap: Record<string, string> }>();
  const columnMap = body.columnMap ?? {};

  const missing = REQUIRED_FIELDS.filter(k => !columnMap[k]);
  if (missing.length) {
    return c.json({ error: "missing required mappings", missing }, 422);
  }
  // Reject unknown target keys (extensibility discipline — only registry fields allowed).
  const unknown = Object.keys(columnMap).filter(k => !fieldByKey(k));
  if (unknown.length) return c.json({ error: "unknown target fields", unknown }, 422);

  const { data, error } = await supabaseAdmin.from("imports")
    .update({ column_map: columnMap, status: "mapped" })
    .eq("id", c.req.param("id")).eq("company_id", companyId).select("id, status").maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, import: data });
});

/** Kick off the import worker. */
importRoutes.post("/:id/run", async (c) => {
  const companyId = c.get("companyId" as never) as string;
  const id = c.req.param("id");
  const { data: imp } = await supabaseAdmin.from("imports")
    .select("id, status").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (!imp) return c.json({ error: "not found" }, 404);
  if (imp.status !== "mapped") return c.json({ error: "confirm the column mapping first" }, 409);

  await boss.send("import", { importId: id }, { singletonKey: `import:${id}` });
  return c.json({ ok: true });
});

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}
