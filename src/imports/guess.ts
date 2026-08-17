/**
 * Fuzzy column → target-field auto-guess (PLAN.md §3 step 3).
 *
 * Dealership CSV exports have vague, unordered, inconsistently-named columns. We normalize each
 * source header and score it against every target field's synonym list, then greedily assign the
 * best matches (each source column and each target field used at most once). The user always
 * confirms/overrides in the mapping UI — this is a starting guess, not the final word.
 */

import { TARGET_FIELDS, TargetField } from "./fields";

/** Lowercase, strip punctuation/underscores, collapse whitespace. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[_\-./]+/g, " ").replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

/** Token-overlap + substring similarity in [0,1] between a normalized header and a synonym. */
function similarity(header: string, synonym: string): number {
  if (header === synonym) return 1;
  if (header.includes(synonym) || synonym.includes(header)) return 0.85;

  const ht = new Set(header.split(" "));
  const st = new Set(synonym.split(" "));
  let shared = 0;
  for (const t of st) if (ht.has(t)) shared++;
  const denom = Math.max(ht.size, st.size);
  return denom ? shared / denom : 0;
}

/** Best score of a header against any of a field's synonyms (also tries the field key/label). */
function scoreField(headerNorm: string, field: TargetField): number {
  const candidates = [field.key, normalize(field.label), ...field.synonyms.map(normalize)];
  let best = 0;
  for (const c of candidates) best = Math.max(best, similarity(headerNorm, c));
  return best;
}

export interface Guess {
  /** target field key → source header (the shape stored in imports.column_map) */
  columnMap: Record<string, string>;
  /** per-target-field confidence 0..1, for surfacing "low confidence" hints in the UI */
  confidence: Record<string, number>;
}

const THRESHOLD = 0.5;

/**
 * Greedy best-first assignment. Produces { target_field: source_header }.
 * Each source header and each target field are used at most once.
 */
export function guessMapping(headers: string[]): Guess {
  const normHeaders = headers.map(normalize);

  // Build all (field, header) candidate pairs above threshold.
  const pairs: { field: string; header: string; score: number }[] = [];
  for (const field of TARGET_FIELDS) {
    normHeaders.forEach((nh, i) => {
      const score = scoreField(nh, field);
      if (score >= THRESHOLD) pairs.push({ field: field.key, header: headers[i], score });
    });
  }
  pairs.sort((a, b) => b.score - a.score);

  const columnMap: Record<string, string> = {};
  const confidence: Record<string, number> = {};
  const usedFields = new Set<string>();
  const usedHeaders = new Set<string>();

  for (const p of pairs) {
    if (usedFields.has(p.field) || usedHeaders.has(p.header)) continue;
    columnMap[p.field] = p.header;
    confidence[p.field] = Number(p.score.toFixed(2));
    usedFields.add(p.field);
    usedHeaders.add(p.header);
  }
  return { columnMap, confidence };
}
