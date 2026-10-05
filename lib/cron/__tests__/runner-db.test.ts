// ShapesOS — in-app cron runner against real Postgres (Phase 6): the per-tick
// advisory lock lets only one of two runners execute a tick, claims are
// durable across runners (no double-fire, no overlap), results are recorded,
// abandoned "running" rows are reclaimed and old rows are pruned.
// Fake clock + fake caller (no HTTP); the store is the real prismaCronStore.
// Run (as the least-privilege app role): DATABASE_URL=… npx tsx --test lib/cron/__tests__/runner-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { CronRunner, STALE_GRACE_MS, type CallResult, type Clock, type JobCaller } from "../runner";
import { CRON_LOCK_ID, CRON_LOCK_NAMESPACE, CRON_RUN_RETENTION_DAYS, lastRunPerJob, prismaCronStore } from "../store";
import type { CronJob } from "../jobs";
import type { RunnerLogger } from "../runner";

const PREFIX = "p6test-";
const minuteJob: CronJob = { key: `${PREFIX}minute`, path: "/api/cron/x", cron: "* * * * *", source: "picked", note: "db test", timeoutMs: 5 * 60_000 };
const hourlyJob: CronJob = { key: `${PREFIX}hourly`, path: "/api/cron/y", cron: "5 * * * *", source: "picked", note: "db test", timeoutMs: 5 * 60_000 };
const JOBS = [minuteJob, hourlyJob];
const ENV = { CRON_SECRET: "s3cret" } as unknown as NodeJS.ProcessEnv;
const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Settable clock; timers never fire unless the test fires them. */
class ManualClock implements Clock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    if (ms <= 0) queueMicrotask(fn);
    return 0;
  }
  clearTimeout() {}
}

function recordingCaller(answer: () => Promise<CallResult> = async () => ({ status: 200, excerpt: "" })) {
  const calls: string[] = [];
  const call: JobCaller = async (job) => {
    calls.push(job.key);
    return answer();
  };
  return { calls, call };
}

function makeRunner(clock: Clock, call: JobCaller, jobs: CronJob[] = JOBS) {
  return new CronRunner({ store: prismaCronStore(), call, jobs, clock, random: () => 0, logger: quiet, env: ENV });
}

const rows = () => prisma.cronRun.findMany({ where: { job: { startsWith: PREFIX } }, orderBy: { startedAt: "asc" } });

before(async () => {
  await prisma.cronRun.deleteMany({ where: { job: { startsWith: PREFIX } } });
});
beforeEach(async () => {
  await prisma.cronRun.deleteMany({ where: { job: { startsWith: PREFIX } } });
});
after(async () => {
  await prisma.cronRun.deleteMany({ where: { job: { startsWith: PREFIX } } });
  await prisma.$disconnect();
});

describe("cron runner (DB)", () => {
  it("only one runner gets the tick while another replica holds the advisory lock", async () => {
    const T = Date.UTC(2029, 0, 1, 10, 0, 30);
    const clock = new ManualClock(T);
    const { calls, call } = recordingCaller();
    const runner = makeRunner(clock, call);
    clock.t = T + 31_000; // 10:01:01 — the minute job is due

    // "Replica A" holds the tick lock in an open transaction.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let lockedByA!: () => void;
    const aHasLock = new Promise<void>((r) => (lockedByA = r));
    const replicaA = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CRON_LOCK_NAMESPACE}::int, ${CRON_LOCK_ID}::int)`;
        lockedByA();
        await held;
      },
      { timeout: 20_000 },
    );
    await aHasLock;
    assert.deepEqual(await runner.tick(), { leader: false, claimed: [] });
    assert.equal((await rows()).length, 0);

    release();
    await replicaA;
    assert.deepEqual(await runner.tick(), { leader: true, claimed: [minuteJob.key] });
    await runner.drain();
    assert.deepEqual(calls, [minuteJob.key]);
  });

  it("two runners ticking at once execute each due job exactly once", async () => {
    const T = Date.UTC(2029, 0, 1, 10, 0, 30);
    const clockA = new ManualClock(T);
    const clockB = new ManualClock(T);
    const a = recordingCaller();
    const b = recordingCaller();
    const runnerA = makeRunner(clockA, a.call);
    const runnerB = makeRunner(clockB, b.call);

    for (const t of [T + 5 * 60_000, T + 5 * 60_000 + 15_000, T + 6 * 60_000]) {
      clockA.t = clockB.t = t;
      const [ra, rb] = await Promise.all([runnerA.tick(), runnerB.tick()]);
      // Never both: at most one runner claims anything in a tick.
      assert.ok(!(ra.claimed.length && rb.claimed.length), `both claimed at ${new Date(t).toISOString()}`);
      await Promise.all([runnerA.drain(), runnerB.drain()]);
    }
    const all = [...a.calls, ...b.calls].sort();
    // 10:05:30 → minute + hourly(:05); 10:05:45 → nothing new; 10:06:30 → minute.
    assert.deepEqual(all, [hourlyJob.key, minuteJob.key, minuteJob.key].sort());
    const recorded = await rows();
    assert.equal(recorded.length, 3);
    assert.ok(recorded.every((r) => r.status === "ok" && r.httpStatus === 200 && r.finishedAt && r.durationMs !== null));
  });

  it("a job still running on another replica is not claimed again (no overlap)", async () => {
    const T = Date.UTC(2029, 0, 1, 10, 0, 30);
    // Replica B claimed the minute job at 10:01:01 and is still running it.
    await prisma.cronRun.create({
      data: { job: minuteJob.key, scheduledFor: new Date(T + 30_000), startedAt: new Date(T + 31_000), status: "running" },
    });
    const clock = new ManualClock(T + 3 * 60_000);
    const { calls, call } = recordingCaller();
    const runner = makeRunner(clock, call, [minuteJob]);
    assert.deepEqual((await runner.tick()).claimed, []);

    // Past its timeout + grace the row counts as abandoned: reclaimed once.
    clock.t = T + 31_000 + minuteJob.timeoutMs + STALE_GRACE_MS + 1_000;
    assert.deepEqual((await runner.tick()).claimed, [minuteJob.key]);
    await runner.drain();
    const recorded = await rows();
    assert.equal(recorded[0]!.status, "timeout");
    assert.match(recorded[0]!.error ?? "", /No result recorded/);
    assert.equal(recorded[1]!.status, "ok");
    assert.deepEqual(calls, [minuteJob.key]);
  });

  it("records failures with the HTTP status and an excerpt", async () => {
    const T = Date.UTC(2029, 0, 1, 10, 0, 30);
    const clock = new ManualClock(T);
    const { call } = recordingCaller(async () => ({ status: 503, excerpt: '{"error":"Service unavailable"}' }));
    const runner = makeRunner(clock, call);
    clock.t = T + 31_000;
    await runner.tick();
    await runner.drain();
    const [r] = await rows();
    assert.equal(r!.status, "failed");
    assert.equal(r!.httpStatus, 503);
    assert.match(r!.error ?? "", /^HTTP 503: /);
  });

  it("prunes finished runs past the retention window, never a running one", async () => {
    const T = Date.UTC(2029, 0, 20, 10, 0, 30);
    const old = new Date(T - (CRON_RUN_RETENTION_DAYS + 1) * 86_400_000);
    await prisma.cronRun.create({ data: { job: hourlyJob.key, scheduledFor: old, startedAt: old, status: "ok", finishedAt: old } });
    await prisma.cronRun.create({ data: { job: `${PREFIX}orphan`, scheduledFor: old, startedAt: old, status: "running" } });
    const clock = new ManualClock(T);
    const runner = makeRunner(clock, recordingCaller().call);
    await runner.tick(); // first tick of a fresh store prunes
    await runner.drain();
    const left = await rows();
    assert.ok(!left.some((r) => r.job === hourlyJob.key && r.startedAt.getTime() === old.getTime()));
    assert.ok(left.some((r) => r.job === `${PREFIX}orphan`));
  });

  it("lastRunPerJob lists every scheduled job (never-run ones as null)", async () => {
    const view = await lastRunPerJob();
    assert.ok(view.length > 30);
    assert.ok(view.every((v) => v.last === null || typeof v.last.status === "string"));
  });
});
