// ShapesOS — ProjectDevSandbox lifecycle (in-product browser "Dev preview"
// v1). Pure-logic test: withWorkspaceScope is module-mocked onto an
// in-memory row map; the provider is a stubbed PersistentSandboxProvider.
// Pins the owner constraints: resume is the ONLY wake (never traffic-driven
// autoResume), autoPause is requested at create, and a create race destroys
// the duplicate sandbox.
// Run: npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/dev-sandbox.test.ts

import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { DevSandboxRow } from "../dev-sandbox";
import type { Sandbox, SandboxProvider } from "../types";
import type { PauseCapable, PersistentSandboxOptions } from "../persistence";

const rows = new Map<string, DevSandboxRow>();
let seq = 0;

mock.module("@/lib/substrate/memory/rls", {
  namedExports: {
    withWorkspaceScope: async (_ws: string, fn: (tx: unknown) => unknown) =>
      fn({
        projectDevSandbox: {
          findFirst: async ({ where }: { where: { projectId: string } }) => rows.get(where.projectId) ?? null,
          findMany: async ({ where }: { where: { status?: { in: string[] }; mode?: string } }) =>
            [...rows.values()].filter((r) => (!where.status || where.status.in.includes(r.status)) && (!where.mode || r.mode === where.mode)),
          create: async ({ data }: { data: Partial<DevSandboxRow> & { projectId: string } }) => {
            if (rows.has(data.projectId)) throw Object.assign(new Error("unique"), { code: "P2002" });
            const row = { id: `pds-${++seq}`, ttlSeconds: 900, mode: "production", createCount: 1, exposedPorts: [], secretEnc: null, createdAt: new Date(), lastResumedAt: null, pausedAt: null, destroyedAt: null, ...data } as DevSandboxRow;
            rows.set(data.projectId, row);
            return row;
          },
          updateMany: async ({ where, data }: { where: { projectId: string; status?: { in: string[] } | string }; data: Partial<DevSandboxRow> }) => {
            const row = rows.get(where.projectId);
            const matches = typeof where.status === "string" ? row?.status === where.status : !where.status || where.status.in.includes(row?.status ?? "");
            if (!row || !matches) return { count: 0 };
            const merged = { ...row } as Record<string, unknown>;
            for (const [k, v] of Object.entries(data)) {
              merged[k] = v && typeof v === "object" && "increment" in (v as Record<string, unknown>)
                ? (row as unknown as Record<string, number>)[k] + (v as { increment: number }).increment
                : v;
            }
            rows.set(where.projectId, merged as unknown as DevSandboxRow);
            return { count: 1 };
          },
        },
      }),
  },
});

let ensureDevSandbox: typeof import("../dev-sandbox").ensureDevSandbox;
let pauseDevSandbox: typeof import("../dev-sandbox").pauseDevSandbox;
let listLiveDevSandboxes: typeof import("../dev-sandbox").listLiveDevSandboxes;
let reconcileDevSandboxes: typeof import("../dev-sandbox").reconcileDevSandboxes;
let devSandboxSpendAllowed: typeof import("../dev-sandbox").devSandboxSpendAllowed;
let TEST_BOUNDS: typeof import("../dev-sandbox").TEST_BOUNDS;
let setSandboxProviderForTests: typeof import("../index").setSandboxProviderForTests;
before(async () => {
  ({ ensureDevSandbox, pauseDevSandbox, listLiveDevSandboxes, reconcileDevSandboxes, devSandboxSpendAllowed, TEST_BOUNDS } = await import("../dev-sandbox"));
  ({ setSandboxProviderForTests } = await import("../index"));
});

interface StubCalls { createPersistent: PersistentSandboxOptions[]; resume: number; pause: number; destroy: number }

function stubSandbox(id: string, calls: StubCalls): Sandbox & PauseCapable {
  return {
    id,
    workspaceId: "ws1",
    runId: "dev:p1",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async readFile() { return ""; },
    async writeFile() { /* noop */ },
    async destroy() { calls.destroy++; },
    async pause() { calls.pause++; },
    async resume() { calls.resume++; },
  } as unknown as Sandbox & PauseCapable;
}

function stubProvider(opts: { persistent: boolean }): { provider: SandboxProvider; calls: StubCalls; live: Map<string, Sandbox & PauseCapable> } {
  const calls: StubCalls = { createPersistent: [], resume: 0, pause: 0, destroy: 0 };
  const live = new Map<string, Sandbox & PauseCapable>();
  const provider = {
    name: opts.persistent ? "e2b" : "docker",
    async available() { return { ok: true as const }; },
    async create() { throw new Error("plain create must not be used for dev sandboxes"); },
    async get(id: string) { return live.get(id) ?? null; },
    ...(opts.persistent
      ? {
          async createPersistent(_ctx: unknown, o: PersistentSandboxOptions) {
            calls.createPersistent.push(o);
            const sb = stubSandbox(`sb-${calls.createPersistent.length}`, calls);
            live.set(sb.id, sb);
            return sb;
          },
        }
      : {}),
  } as unknown as SandboxProvider;
  return { provider, calls, live };
}

describe("dev sandbox lifecycle", () => {
  beforeEach(() => rows.clear());

  it("creates with autoPause + TTL when the project has none", async () => {
    const { provider, calls } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    const r = await ensureDevSandbox("ws1", "p1", { bounds: { ...TEST_BOUNDS, ttlSeconds: 600 } });
    assert.ok(r.ok);
    assert.equal(r.woke, "created");
    assert.deepEqual(calls.createPersistent, [{ autoPause: true, timeoutSeconds: 600 }]);
    assert.equal(rows.get("p1")?.status, "running");
    assert.equal(rows.get("p1")?.ttlSeconds, 600);
    assert.equal(rows.get("p1")?.mode, "test", "created under test bounds");
  });

  it("resumes a paused row via the explicit path only (no second create)", async () => {
    const { provider, calls } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    const r1 = await ensureDevSandbox("ws1", "p1");
    assert.ok(r1.ok);
    await pauseDevSandbox("ws1", "p1");
    assert.equal(calls.pause, 1);
    assert.equal(rows.get("p1")?.status, "paused");
    const r2 = await ensureDevSandbox("ws1", "p1");
    assert.ok(r2.ok);
    assert.equal(r2.woke, "resumed");
    assert.equal(calls.resume, 1);
    assert.equal(calls.createPersistent.length, 1, "no new sandbox on resume");
  });

  it("is a no-op when already running", async () => {
    const { provider, calls } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    await ensureDevSandbox("ws1", "p1");
    const r = await ensureDevSandbox("ws1", "p1");
    assert.ok(r.ok && r.woke === "already-running");
    assert.equal(calls.createPersistent.length, 1);
  });

  it("refuses plainly on a non-persistent provider", async () => {
    const { provider } = stubProvider({ persistent: false });
    setSandboxProviderForTests(provider);
    const r = await ensureDevSandbox("ws1", "p1");
    assert.ok(!r.ok);
    assert.match(r.reason, /can't pause/);
    assert.equal(rows.size, 0, "no row written when the provider can't persist");
  });

  it("destroys the duplicate when a create race is lost", async () => {
    const { provider, calls, live } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    // Pre-seed a winner that appears between create and insert.
    const origCreate = (provider as { createPersistent: Function }).createPersistent;
    (provider as { createPersistent: Function }).createPersistent = async (ctx: unknown, o: PersistentSandboxOptions) => {
      const sb = await origCreate(ctx, o);
      rows.set("p1", { id: "pds-winner", workspaceId: "ws1", projectId: "p1", provider: "e2b", sandboxId: "sb-winner", status: "running", ttlSeconds: 900, exposedPorts: [], secretEnc: null, createdAt: new Date(), lastResumedAt: new Date(), pausedAt: null, destroyedAt: null });
      live.set("sb-winner", stubSandbox("sb-winner", calls));
      return sb;
    };
    const r = await ensureDevSandbox("ws1", "p1");
    assert.ok(r.ok);
    assert.equal(r.sandbox.id, "sb-winner");
    assert.equal(calls.destroy, 1, "losing sandbox destroyed");
  });

  it("resumes an auto-paused E2B-style sandbox instead of recreating (get() hides paused)", async () => {
    const { provider, calls, live } = stubProvider({ persistent: true });
    // E2B semantics: get() returns null once the provider auto-pauses.
    const aware = provider as unknown as Record<string, unknown>;
    aware.sandboxState = async () => "paused";
    aware.attachPaused = async (id: string) => stubSandbox(id, calls); // real E2B rebuilds the handle from the API
    setSandboxProviderForTests(provider);
    const r1 = await ensureDevSandbox("ws1", "p1");
    assert.ok(r1.ok);
    await pauseDevSandbox("ws1", "p1");
    live.delete(r1.sandbox.id); // get() can no longer see it, like a real auto-pause
    const r2 = await ensureDevSandbox("ws1", "p1");
    assert.ok(r2.ok);
    assert.equal(r2.woke, "resumed", "paused row resumed via attachPaused, not recreated");
    assert.equal(calls.createPersistent.length, 1);
    assert.equal(r2.sandbox.id, r1.sandbox.id, "same sandbox woke");
  });

  it("lists only live rows", async () => {
    const { provider } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    await ensureDevSandbox("ws1", "p1");
    await ensureDevSandbox("ws1", "p2");
    await pauseDevSandbox("ws1", "p2");
    const liveRows = await listLiveDevSandboxes("ws1");
    assert.deepEqual(liveRows.map((r) => r.projectId).sort(), ["p1", "p2"]);
  });
});

describe("dev sandbox spend gate + reconcile cleanup", () => {
  beforeEach(() => rows.clear());

  it("spend gate: off by default, test needs an immutable future deadline, prod separate", () => {
    assert.deepEqual(devSandboxSpendAllowed({}), { allowed: false, bounds: null, mode: "off" });
    // Test flag alone is NOT enough: no window deadline -> closed.
    const noUntil = devSandboxSpendAllowed({ SHAPES_DEV_PREVIEW_TEST: "1" });
    assert.ok(!noUntil.allowed);
    // A past deadline fails closed and cannot be restarted from inside.
    const past = devSandboxSpendAllowed({ SHAPES_DEV_PREVIEW_TEST: "1", SHAPES_DEV_PREVIEW_TEST_UNTIL: "2026-10-25T20:00:00Z" }, new Date("2026-10-25T21:00:00Z"));
    assert.ok(!past.allowed && /ended/.test(past.reason ?? ""));
    // Flag + future deadline opens the bounded window.
    const test = devSandboxSpendAllowed({ SHAPES_DEV_PREVIEW_TEST: "1", SHAPES_DEV_PREVIEW_TEST_UNTIL: "2026-10-25T22:00:00Z" }, new Date("2026-10-25T21:00:00Z"));
    assert.ok(test.allowed && test.mode === "test");
    assert.equal(test.bounds?.maxConcurrentPerWorkspace, 1);
    assert.equal(test.bounds?.ttlSeconds, 300);
    const prod = devSandboxSpendAllowed({ SHAPES_DEV_PREVIEW_SPEND: "1" });
    assert.ok(prod.allowed && prod.mode === "production");
  });

  it("aggregate test bound: destroy/recreate loops hit the total-create cap", async () => {
    const { provider } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    for (let i = 0; i < 3; i++) {
      const r = await ensureDevSandbox("ws1", `p${i}`, { bounds: TEST_BOUNDS });
      assert.ok(r.ok, `create ${i}`);
      rows.get(`p${i}`)!.status = "destroyed"; // destroyed rows still count
    }
    const fourth = await ensureDevSandbox("ws1", "p3", { bounds: TEST_BOUNDS });
    assert.ok(!fourth.ok);
    assert.match(fourth.reason, /3 dev sandbox\(es\) in total/);
    // Production bounds are NOT capped by the test counter.
    const prod = await ensureDevSandbox("ws1", "p3");
    assert.ok(prod.ok);
  });

  it("concurrency bound refuses a second live sandbox in test mode", async () => {
    const { provider } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    const r1 = await ensureDevSandbox("ws1", "p1", { bounds: TEST_BOUNDS });
    assert.ok(r1.ok);
    const r2 = await ensureDevSandbox("ws1", "p2", { bounds: TEST_BOUNDS });
    assert.ok(!r2.ok);
    assert.match(r2.reason, /limit 1/);
  });

  function seedRow(over: Partial<DevSandboxRow>) {
    const row = {
      id: `pds-${++seq}`, workspaceId: "ws1", projectId: "p1", provider: "e2b", sandboxId: "sb-1",
      status: "running", ttlSeconds: 900, mode: "production", exposedPorts: [], secretEnc: null,
      createdAt: new Date(), lastResumedAt: null, pausedAt: null, destroyedAt: null, ...over,
    } as DevSandboxRow;
    rows.set(row.projectId, row);
    return row;
  }

  it("reconcile: provider-auto-paused running row flips to paused (no wake)", async () => {
    const { provider } = stubProvider({ persistent: true });
    (provider as unknown as Record<string, unknown>).sandboxState = async () => "paused";
    (provider as unknown as Record<string, unknown>).attachPaused = async () => null;
    setSandboxProviderForTests(provider);
    seedRow({});
    const r = await reconcileDevSandboxes("ws1");
    assert.equal(r.markedPaused, 1);
    assert.equal(rows.get("p1")?.status, "paused");
  });

  it("reconcile: missing provider sandbox destroys the row (running AND paused)", async () => {
    const { provider } = stubProvider({ persistent: true });
    (provider as unknown as Record<string, unknown>).sandboxState = async () => "gone";
    (provider as unknown as Record<string, unknown>).attachPaused = async () => null;
    setSandboxProviderForTests(provider);
    seedRow({ projectId: "p1", status: "running" });
    seedRow({ projectId: "p2", status: "paused", sandboxId: "sb-2" });
    const r = await reconcileDevSandboxes("ws1");
    assert.equal(rows.get("p1")?.status, "destroyed", "running row with gone provider destroyed");
    assert.equal(r.markedPaused, 0);
  });

  it("reconcile: created-at ceiling destroys row AND provider sandbox", async () => {
    const { provider, calls, live } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    const sb = stubSandbox("sb-old", calls);
    live.set("sb-old", sb);
    seedRow({ sandboxId: "sb-old", createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000) });
    const r = await reconcileDevSandboxes("ws1");
    assert.equal(r.ceilingDestroyed, 1);
    assert.equal(calls.destroy, 1, "provider sandbox destroyed at the ceiling");
    assert.equal(rows.get("p1")?.status, "destroyed");
  });

  it("reconcile: a test-mode row keeps its tighter 20-minute ceiling", async () => {
    const { provider, calls, live } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    const sb = stubSandbox("sb-test", calls);
    live.set("sb-test", sb);
    seedRow({ sandboxId: "sb-test", mode: "test", createdAt: new Date(Date.now() - 25 * 60 * 1000) });
    const r = await reconcileDevSandboxes("ws1");
    assert.equal(r.ceilingDestroyed, 1, "25-minute-old test row is past the 20-minute test ceiling");
  });

  it("revive loop on the SAME project still hits the aggregate test cap", async () => {
    const { provider } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    for (let i = 0; i < 3; i++) {
      const r = await ensureDevSandbox("ws1", "p1", { bounds: TEST_BOUNDS });
      assert.ok(r.ok, `revive ${i}`);
      rows.get("p1")!.status = "destroyed"; // same row revived in place each time
    }
    assert.equal(rows.size, 1, "same project reuses its one row");
    const blocked = await ensureDevSandbox("ws1", "p1", { bounds: TEST_BOUNDS });
    assert.ok(!blocked.ok, "fourth creation blocked by the summed createCount");
    assert.match(blocked.reason, /in total/);
  });

  it("restart: after destroy, ensure creates a fresh sandbox", async () => {
    const { provider, calls } = stubProvider({ persistent: true });
    setSandboxProviderForTests(provider);
    const r1 = await ensureDevSandbox("ws1", "p1");
    assert.ok(r1.ok);
    rows.get("p1")!.status = "destroyed";
    const r2 = await ensureDevSandbox("ws1", "p1");
    assert.ok(r2.ok && r2.woke === "created");
    assert.equal(calls.createPersistent.length, 2, "destroyed row allows a fresh create");
    assert.notEqual(r2.sandbox.id, r1.sandbox.id);
  });
});
