// ShapesOS — in-app cron runner: planning, start rules, no-overlap and
// timeouts (Phase 6). Fake clock, in-memory store, fake caller — no DB, no
// network (the httpCaller check talks to a throwaway server on 127.0.0.1).
// The Postgres store and its advisory lock are covered by runner-db.test.ts.
// Run: npx tsx --test lib/cron/__tests__/runner.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CronRunner,
  cronRunnerDecision,
  httpCaller,
  planTick,
  slotFor,
  STALE_GRACE_MS,
  type CallResult,
  type ClaimArgs,
  type ClaimedRun,
  type Clock,
  type CronStore,
  type JobCaller,
  type LastRun,
  type RunResult,
} from "../runner";
import type { CronJob } from "../jobs";
import type { Logger } from "@/lib/observability/log";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(start: Date) {
    this.t = start.getTime();
  }
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers.delete(h as number);
  }
  /** Move time forward, firing due timers in order and letting promises settle. */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const next = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

interface Row extends LastRun {
  job: string;
  result?: RunResult;
}

/** In-memory CronStore using the real planner; `lockHeld` simulates another replica. */
class MemoryStore implements CronStore {
  rows: Row[] = [];
  lockHeld = false;
  private seq = 0;
  async claimDue(args: ClaimArgs): Promise<ClaimedRun[] | null> {
    if (this.lockHeld) return null;
    const latest = new Map<string, LastRun>();
    for (const r of this.rows) {
      const cur = latest.get(r.job);
      if (!cur || r.startedAt >= cur.startedAt) latest.set(r.job, r);
    }
    const plan = planTick(args.jobs, latest, args.now, args.baseline, args.localRunning);
    for (const r of this.rows) if (plan.stale.includes(r.runId)) r.status = "timeout";
    return plan.due.map((job) => {
      const row: Row = { runId: `run-${++this.seq}`, job: job.key, scheduledFor: slotFor(args.now), startedAt: args.now, status: "running" };
      this.rows.push(row);
      return { runId: row.runId, job, scheduledFor: row.scheduledFor };
    });
  }
  async finish(runId: string, result: RunResult) {
    const r = this.rows.find((x) => x.runId === runId)!;
    r.status = result.status;
    r.result = result;
  }
  runsOf(job: string) {
    return this.rows.filter((r) => r.job === job);
  }
}

function silentLogger(): Logger & { lines: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => void lines.push({ level, msg, fields });
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } as never;
}

const everyMinute: CronJob = { key: "t-minute", path: "/api/cron/t-minute", cron: "* * * * *", source: "picked", note: "test", timeoutMs: 120_000 };
const hourly: CronJob = { key: "t-hourly", path: "/api/cron/t-hourly", cron: "5 * * * *", source: "picked", note: "test", timeoutMs: 600_000 };
const ENV = { CRON_SECRET: "s3cret", OTHER_SECRET: "" } as unknown as NodeJS.ProcessEnv;

/** A caller whose calls stay pending until the test settles them. */
function controllableCaller() {
  const calls: { job: string; signal: AbortSignal; resolve: (r: CallResult) => void; reject: (e: unknown) => void }[] = [];
  const call: JobCaller = (job, { signal }) =>
    new Promise<CallResult>((resolve, reject) => {
      calls.push({ job: job.key, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  return { calls, call };
}

const T0 = new Date("2029-01-01T10:00:30Z"); // 30s into a minute

function runnerWith(opts: { jobs: CronJob[]; call: JobCaller; clock: FakeClock; store?: MemoryStore; env?: NodeJS.ProcessEnv }) {
  const store = opts.store ?? new MemoryStore();
  const logger = silentLogger();
  const runner = new CronRunner({ store, call: opts.call, jobs: opts.jobs, clock: opts.clock, random: () => 0, logger, env: opts.env ?? ENV });
  return { runner, store, logger };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planTick", () => {
  const now = new Date("2029-01-01T10:05:10Z");
  const baseline = new Date("2029-01-01T10:00:00Z");

  it("a job that never ran is due at its first slot after the runner started", () => {
    assert.deepEqual(planTick([hourly], new Map(), now, baseline).due.map((j) => j.key), ["t-hourly"]);
    assert.deepEqual(planTick([hourly], new Map(), new Date("2029-01-01T10:04:59Z"), baseline).due, []);
  });

  it("a slot that already ran is not due again; the next slot is", () => {
    const last: LastRun = { runId: "r1", scheduledFor: new Date("2029-01-01T10:05:00Z"), startedAt: new Date("2029-01-01T10:05:00Z"), status: "ok" };
    const latest = new Map([["t-hourly", last]]);
    assert.deepEqual(planTick([hourly], latest, now, baseline).due, []);
    assert.equal(planTick([hourly], latest, new Date("2029-01-01T11:05:01Z"), baseline).due.length, 1);
  });

  it("after downtime a job fires once, not once per missed slot", () => {
    const last: LastRun = { runId: "r1", scheduledFor: new Date("2029-01-01T01:05:00Z"), startedAt: new Date("2029-01-01T01:05:00Z"), status: "ok" };
    const plan = planTick([hourly], new Map([["t-hourly", last]]), now, baseline);
    assert.equal(plan.due.length, 1); // one claim; its slot (now) moves the schedule past every missed hour
  });

  it("a running job is never claimed again until its timeout plus grace has passed", () => {
    const startedAt = new Date("2029-01-01T10:04:00Z");
    const running: LastRun = { runId: "r9", scheduledFor: startedAt, startedAt, status: "running" };
    const latest = new Map([["t-minute", running]]);
    assert.deepEqual(planTick([everyMinute], latest, now, baseline), { due: [], stale: [] });
    const later = new Date(startedAt.getTime() + everyMinute.timeoutMs + STALE_GRACE_MS + 1);
    const plan = planTick([everyMinute], latest, later, baseline);
    assert.deepEqual(plan.stale, ["r9"]);
    assert.equal(plan.due.length, 1);
  });

  it("jobs running in this process are skipped", () => {
    assert.deepEqual(planTick([everyMinute], new Map(), now, baseline, new Set(["t-minute"])).due, []);
  });
});

describe("cronRunnerDecision", () => {
  const prod = { NODE_ENV: "production", NEXT_RUNTIME: "nodejs", CRON_SECRET: "x" };
  const d = (env: Record<string, string>) => cronRunnerDecision(env as unknown as NodeJS.ProcessEnv);

  it("defaults to internal on a production server, at 127.0.0.1:$PORT", () => {
    assert.deepEqual(d(prod), { start: true, origin: "http://127.0.0.1:3000" });
    assert.deepEqual(d({ ...prod, PORT: "8080" }), { start: true, origin: "http://127.0.0.1:8080" });
    assert.deepEqual(d({ ...prod, CRON_RUNNER: "internal", CRON_RUNNER_ORIGIN: "http://app:3000/x" }), { start: true, origin: "http://app:3000" });
  });

  it("stays off when external/off, in dev by default, and on bad config", () => {
    assert.equal(d({ ...prod, CRON_RUNNER: "external" }).start, false);
    assert.equal(d({ ...prod, CRON_RUNNER: "off" }).start, false);
    assert.equal(d({ ...prod, NODE_ENV: "development" }).start, false);
    assert.equal(d({ ...prod, NODE_ENV: "development", CRON_RUNNER: "internal" }).start, true);
    const bad = d({ ...prod, CRON_RUNNER: "sometimes" });
    assert.equal(bad.start, false);
    assert.equal(!bad.start && bad.level, "warn");
    assert.equal(d({ ...prod, CRON_RUNNER_ORIGIN: "ftp://x" }).start, false);
  });

  it("never starts during next build, in tests or outside the Node.js runtime", () => {
    assert.equal(d({ ...prod, NEXT_PHASE: "phase-production-build" }).start, false);
    assert.equal(d({ ...prod, NODE_ENV: "test" }).start, false);
    assert.equal(d({ ...prod, NODE_TEST_CONTEXT: "child-v8" }).start, false);
    assert.equal(d({ ...prod, NEXT_RUNTIME: "edge" }).start, false);
  });

  it("stays off, with a warning, when CRON_SECRET is unset — never invents one", () => {
    const r = d({ ...prod, CRON_SECRET: "  " });
    assert.equal(r.start, false);
    assert.ok(!r.start && r.level === "warn" && /CRON_SECRET/.test(r.reason));
  });
});

describe("CronRunner", () => {
  it("never overlaps a job with itself; the next slot runs once the first finishes", async () => {
    const clock = new FakeClock(T0);
    const { calls, call } = controllableCaller();
    const slow = { ...everyMinute, timeoutMs: 10 * 60_000 }; // outlives the minutes below
    const { runner, store } = runnerWith({ jobs: [slow], call, clock });

    assert.deepEqual((await runner.tick()).claimed, [], "not due until the next minute");
    await clock.advance(31_000); // 10:01:01
    assert.deepEqual((await runner.tick()).claimed, ["t-minute"]);
    await flush();
    assert.equal(calls.length, 1);

    // Two more minutes pass while the first call is still pending: no second run.
    await clock.advance(60_000);
    assert.deepEqual((await runner.tick()).claimed, []);
    await clock.advance(60_000);
    assert.deepEqual((await runner.tick()).claimed, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(runner.inFlight, ["t-minute"]);

    calls[0]!.resolve({ status: 200, excerpt: "{}" });
    await flush();
    assert.equal(store.runsOf("t-minute")[0]!.status, "ok");
    assert.deepEqual(runner.inFlight, []);

    // Missed minutes are not replayed: exactly one new run.
    assert.deepEqual((await runner.tick()).claimed, ["t-minute"]);
    assert.deepEqual((await runner.tick()).claimed, []);
    await flush();
    assert.equal(calls.length, 2);
    calls[1]!.resolve({ status: 204, excerpt: "" });
    await runner.drain();
    assert.deepEqual(store.runsOf("t-minute").map((r) => r.status), ["ok", "ok"]);
  });

  it("times a run out after timeoutMs, aborts the call and records it", async () => {
    const clock = new FakeClock(T0);
    const { calls, call } = controllableCaller();
    const { runner, store, logger } = runnerWith({ jobs: [everyMinute], call, clock });
    await clock.advance(31_000);
    await runner.tick();
    await flush();
    assert.equal(calls.length, 1);

    await clock.advance(everyMinute.timeoutMs - 1);
    assert.equal(store.runsOf("t-minute")[0]!.status, "running");
    assert.equal(calls[0]!.signal.aborted, false);

    await clock.advance(1);
    await runner.drain();
    const row = store.runsOf("t-minute")[0]!;
    assert.equal(row.status, "timeout");
    assert.equal(row.result!.httpStatus, null);
    assert.equal(row.result!.durationMs, everyMinute.timeoutMs);
    assert.match(row.result!.error!, /No answer within 120s/);
    assert.equal(calls[0]!.signal.aborted, true);
    assert.ok(logger.lines.some((l) => l.level === "warn" && l.fields?.job === "t-minute" && l.fields?.status === "timeout"));

    // The job is free again for its next slot.
    assert.deepEqual((await runner.tick()).claimed, ["t-minute"]);
  });

  it("a call that ignores the abort signal still times out", async () => {
    const clock = new FakeClock(T0);
    const call: JobCaller = () => new Promise<CallResult>(() => {}); // never settles
    const { runner, store } = runnerWith({ jobs: [everyMinute], call, clock });
    await clock.advance(31_000);
    await runner.tick();
    await clock.advance(everyMinute.timeoutMs);
    await runner.drain();
    assert.equal(store.runsOf("t-minute")[0]!.status, "timeout");
  });

  it("records non-2xx answers and network errors as failed", async () => {
    const clock = new FakeClock(T0);
    const answers: (() => Promise<CallResult>)[] = [
      async () => ({ status: 401, excerpt: '{"error":"Unauthorized"}' }),
      async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
      },
    ];
    const call: JobCaller = () => answers.shift()!();
    const { runner, store } = runnerWith({ jobs: [everyMinute], call, clock });
    await clock.advance(31_000);
    await runner.tick();
    await runner.drain();
    await clock.advance(60_000);
    await runner.tick();
    await runner.drain();
    const [a, b] = store.runsOf("t-minute");
    assert.equal(a!.status, "failed");
    assert.equal(a!.result!.httpStatus, 401);
    assert.match(a!.result!.error!, /^HTTP 401: \{"error":"Unauthorized"\}/);
    assert.equal(b!.status, "failed");
    assert.equal(b!.result!.httpStatus, null);
    assert.match(b!.result!.error!, /ECONNREFUSED/);
  });

  it("does nothing when another replica holds the tick lock", async () => {
    const clock = new FakeClock(T0);
    const { calls, call } = controllableCaller();
    const store = new MemoryStore();
    store.lockHeld = true;
    const { runner } = runnerWith({ jobs: [everyMinute], call, clock, store });
    await clock.advance(31_000);
    assert.deepEqual(await runner.tick(), { leader: false, claimed: [] });
    assert.equal(calls.length, 0);
  });

  it("waits out the start jitter before calling", async () => {
    const clock = new FakeClock(T0);
    const { calls, call } = controllableCaller();
    const store = new MemoryStore();
    const runner = new CronRunner({ store, call, jobs: [hourly], clock, random: () => 0.5, logger: silentLogger(), env: ENV });
    await clock.advance(5 * 60_000); // 10:05:30 — past the :05 slot
    await runner.tick();
    await clock.advance(14_999);
    assert.equal(calls.length, 0);
    await clock.advance(1); // 0.5 × 30s jitter
    assert.equal(calls.length, 1);
    calls[0]!.resolve({ status: 200, excerpt: "" });
    await runner.drain();
  });

  it("skips (and warns once about) jobs whose bearer secret is unset", async () => {
    const clock = new FakeClock(T0);
    const { call } = controllableCaller();
    const own: CronJob = { ...everyMinute, key: "t-own", secretEnv: "OTHER_SECRET" };
    const { runner, logger } = runnerWith({ jobs: [everyMinute, own], call, clock });
    assert.deepEqual(runner.scheduledJobs, ["t-minute"]);
    assert.equal(logger.lines.filter((l) => l.level === "warn" && l.fields?.job === "t-own").length, 1);
  });

  it("start() ticks on its own timer and stop() stops it", async () => {
    const clock = new FakeClock(T0);
    let ticks = 0;
    const store: CronStore = {
      async claimDue() {
        ticks++;
        return [];
      },
      async finish() {},
    };
    const runner = new CronRunner({ store, call: async () => ({ status: 200, excerpt: "" }), jobs: [everyMinute], clock, logger: silentLogger(), env: ENV, tickMs: 15_000, firstTickDelayMs: 10_000 });
    runner.start();
    await clock.advance(9_999);
    assert.equal(ticks, 0);
    await clock.advance(1);
    assert.equal(ticks, 1);
    await clock.advance(30_000);
    assert.equal(ticks, 3);
    runner.stop();
    await clock.advance(60_000);
    assert.equal(ticks, 3);
  });
});

describe("httpCaller", () => {
  it("POSTs to the route on its own origin with the job's bearer", async () => {
    const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        res.writeHead(req.url === "/api/cron/t-minute" ? 200 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: req.url === "/api/cron/t-minute" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const caller = httpCaller(`http://127.0.0.1:${port}`, { CRON_SECRET: "s3cret", OWN: "own-secret" } as unknown as NodeJS.ProcessEnv);
      const ok = await caller(everyMinute, { signal: new AbortController().signal });
      assert.equal(ok.status, 200);
      const bad = await caller({ ...hourly, secretEnv: "OWN" }, { signal: new AbortController().signal });
      assert.equal(bad.status, 500);
      assert.match(bad.excerpt, /"ok":false/);
      assert.deepEqual(seen, [
        { method: "POST", url: "/api/cron/t-minute", auth: "Bearer s3cret", body: "{}" },
        { method: "POST", url: "/api/cron/t-hourly", auth: "Bearer own-secret", body: "{}" },
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
