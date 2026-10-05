// ShapesOS — the cron schedule table covers every cron route (Phase 6).
// Fails when a route is added under app/api/cron/ without a schedule entry
// in lib/cron/jobs.ts, or when an entry points at a route that's gone.
// Run: npx tsx --test lib/cron/__tests__/jobs.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CRON_JOBS, jobMaxJitterMs, jobSchedule } from "../jobs";
import { TICK_MS } from "../runner";
import { cronMatches } from "@/lib/scheduler/cron";
import { TIER_LIMITS } from "@/lib/api/rate-limit";

const ROOT = join(__dirname, "..", "..", "..");

function cronRouteDirs(): string[] {
  const base = join(ROOT, "app/api/cron");
  return readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory() && existsSync(join(base, d, "route.ts")));
}

describe("cron schedule table", () => {
  it("has a schedule for every app/api/cron/* route", () => {
    const scheduled = new Set(CRON_JOBS.map((j) => j.path));
    const missing = cronRouteDirs()
      .map((d) => `/api/cron/${d}`)
      .filter((p) => !scheduled.has(p));
    assert.deepEqual(missing, [], `add these routes to lib/cron/jobs.ts: ${missing.join(", ")}`);
  });

  it("also schedules the scheduler tick, the webhooks queue and the context.dev monitors", () => {
    const paths = new Set(CRON_JOBS.map((j) => j.path));
    for (const p of ["/api/scheduler/tick", "/api/cron/webhooks", "/api/cron/contextdev-monitors"]) {
      assert.ok(paths.has(p), p);
    }
  });

  it("every entry points at a real route with a POST handler", () => {
    for (const j of CRON_JOBS) {
      const file = join(ROOT, "app", j.path, "route.ts");
      assert.ok(existsSync(file), `${j.key}: ${file} does not exist`);
      assert.match(readFileSync(file, "utf8"), /export (async )?function POST\(/, `${j.key}: no POST handler`);
    }
  });

  it("keys and paths are unique, cadences parse, timeouts are sane", () => {
    assert.equal(new Set(CRON_JOBS.map((j) => j.key)).size, CRON_JOBS.length);
    assert.equal(new Set(CRON_JOBS.map((j) => j.path)).size, CRON_JOBS.length);
    for (const j of CRON_JOBS) {
      assert.match(j.key, /^[a-z0-9-]+$/, j.key);
      assert.doesNotThrow(() => jobSchedule(j), j.key);
      assert.ok(j.timeoutMs >= 60_000 && j.timeoutMs <= 60 * 60_000, `${j.key} timeout`);
    }
  });

  it("every cadence not copied from DEPLOY.md says why it was picked", () => {
    for (const j of CRON_JOBS.filter((x) => x.source === "picked")) {
      assert.ok((j.note ?? "").length > 20, `${j.key} needs a note`);
    }
  });

  it("DEPLOY.md cadences are copied verbatim", () => {
    const deploy = readFileSync(join(ROOT, "DEPLOY.md"), "utf8");
    for (const j of CRON_JOBS.filter((x) => x.source === "deploy")) {
      const re = new RegExp(`${j.cron.replace(/[*/]/g, (c) => `\\${c}`)} curl[^\\n]*${j.path}\\b`);
      assert.match(deploy, re, `${j.key}: DEPLOY.md has no "${j.cron} … ${j.path}" line`);
    }
  });

  it("every-minute jobs start inside the minute they are due (tick + jitter < 60s)", () => {
    for (const j of CRON_JOBS.filter((x) => x.cron === "* * * * *")) {
      assert.ok(TICK_MS + jobMaxJitterMs(j) < 60_000, j.key);
    }
  });

  it("the busiest minute stays well under the write-tier rate limit for self-calls", () => {
    // Every minute of a 31-day month that starts on a Monday (2029-01-01).
    const start = Date.UTC(2029, 0, 1);
    let peak = 0;
    for (let m = 0; m < 31 * 24 * 60; m++) {
      const at = new Date(start + m * 60_000);
      const n = CRON_JOBS.filter((j) => cronMatches(jobSchedule(j), at)).length;
      if (n > peak) peak = n;
    }
    assert.ok(peak > 0);
    assert.ok(peak <= TIER_LIMITS.write.limit / 2, `peak ${peak} jobs in one minute`);
  });
});
