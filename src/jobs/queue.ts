import PgBoss from "pg-boss";
import { env } from "../lib/env";

/**
 * pg-boss uses the Supabase Postgres directly — no Redis, one less service on Railway.
 *
 * DATABASE_URL MUST be the SESSION-mode pooler (port 5432), not transaction-mode PgBouncer:
 * pg-boss relies on LISTEN/NOTIFY + long-lived connections that break *silently* in
 * transaction mode (symptom: jobs never pick up). See PLAN.md §9.
 *
 * Own schema + retention keep the job tables from bloating (a busy pg-boss table degrades
 * as vague "everything is slow").
 */
export const boss = new PgBoss({
  connectionString: env.DATABASE_URL,
  schema: "pgboss",
  // Retention: archive completed jobs after 12h, delete archives after 7d.
  archiveCompletedAfterSeconds: 12 * 60 * 60,
  deleteAfterDays: 7,
});

boss.on("error", (e) => console.error("pg-boss error:", e.message));
