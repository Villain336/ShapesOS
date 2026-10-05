// ShapesOS — health checks behind GET /api/health (Phase 4a observability).
//
//   liveness   the process answers (GET /api/health/live): no I/O at all, so
//              an orchestrator only restarts the app when it is truly wedged.
//   readiness  GET /api/health: the database answers within a short timeout
//              and every migration shipped with this build is applied (and
//              none failed). 200 when ready, 503 otherwise. Deploy PR: also
//              503 (draining: true) once the process got SIGTERM, so the load
//              balancer stops routing here while it drains
//              (lib/runtime/shutdown.ts).
//
// Public and unauthenticated by design, so the body says nothing an outsider
// could use: status words, counts and a latency. No hostnames, error text,
// migration names, versions of dependencies or env values. version is the
// app's package version and commit the short build commit (MARKETR_GIT_COMMIT).

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import pkg from "../../package.json";
import { isDraining } from "@/lib/runtime/shutdown";

export type CheckStatus = "ok" | "fail" | "unknown";

export interface DatabaseCheck {
  status: CheckStatus;
  latencyMs: number | null;
}

export interface MigrationsCheck {
  status: CheckStatus;
  /** Migrations shipped with this build that the database hasn't applied. */
  pending: number | null;
  /** Migrations that started and never finished (need operator attention). */
  failed: number | null;
}

export interface HealthReport {
  status: "ok" | "unavailable";
  /** Present (true) while this instance is shutting down. */
  draining?: true;
  checks: { database: DatabaseCheck; migrations: MigrationsCheck };
  version: string;
  commit: string | null;
  uptimeSeconds: number;
  time: string;
}

export const DB_TIMEOUT_MS = 2000;

/** Resolve `p` or reject after `ms` (the timer never keeps the process alive). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Migration folder names in `dir`; null when the folder isn't there. */
export function listMigrations(dir: string): string[] | null {
  try {
    if (!existsSync(dir)) return null;
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "migration.sql")))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

// The image's migrations never change while it runs: read the folder once.
// (The runner image copies prisma/ next to server.js, i.e. into the cwd.)
let shippedCache: string[] | null | undefined;
export function shippedMigrations(): string[] | null {
  if (shippedCache === undefined) shippedCache = listMigrations(join(process.cwd(), "prisma", "migrations"));
  return shippedCache;
}

export interface AppliedRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/** Pure: compare what shipped with what the database recorded. */
export function compareMigrations(shipped: string[] | null, applied: AppliedRow[] | null): MigrationsCheck {
  if (applied === null) return { status: "unknown", pending: null, failed: null };
  const done = new Set(applied.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  const failed = applied.filter((r) => !r.finished_at && !r.rolled_back_at).length;
  if (shipped === null) {
    // No migrations folder in this image: only failures can be judged.
    return { status: failed ? "fail" : "unknown", pending: null, failed };
  }
  const pending = shipped.filter((n) => !done.has(n)).length;
  return { status: pending || failed ? "fail" : "ok", pending, failed };
}

/** Pure: overall status from the checks. "unknown" doesn't fail readiness. */
export function overallStatus(checks: HealthReport["checks"]): HealthReport["status"] {
  if (checks.database.status !== "ok") return "unavailable";
  if (checks.migrations.status === "fail") return "unavailable";
  return "ok";
}

export function buildCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const c = (env.MARKETR_GIT_COMMIT ?? "").trim();
  return /^[0-9a-f]{7,40}$/i.test(c) ? c.slice(0, 12) : null;
}

export async function checkDatabase(timeoutMs = DB_TIMEOUT_MS): Promise<DatabaseCheck> {
  const started = performance.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs);
    return { status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { status: "fail", latencyMs: null };
  }
}

export async function checkMigrations(timeoutMs = DB_TIMEOUT_MS): Promise<MigrationsCheck> {
  let applied: AppliedRow[] | null = null;
  try {
    applied = await withTimeout(
      prisma.$queryRaw<AppliedRow[]>`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`,
      timeoutMs,
    );
  } catch {
    applied = null;
  }
  return compareMigrations(shippedMigrations(), applied);
}

export async function readiness(): Promise<HealthReport> {
  const database = await checkDatabase();
  const migrations: MigrationsCheck =
    database.status === "ok" ? await checkMigrations() : { status: "unknown", pending: null, failed: null };
  const checks = { database, migrations };
  const draining = isDraining();
  return {
    status: draining ? "unavailable" : overallStatus(checks),
    ...(draining ? { draining: true as const } : {}),
    checks,
    version: String((pkg as { version?: string }).version ?? "0.0.0"),
    commit: buildCommit(),
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  };
}
