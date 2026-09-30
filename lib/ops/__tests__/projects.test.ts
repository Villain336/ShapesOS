// Marketr — Phase 17 slice 4 tests: projects, milestones, time ledger,
// status-flow guard, complete-with-nudge, lead linkage, project RLS.
// Run: npx tsx --test lib/ops/__tests__/projects.test.ts
// RLS block also needs: OPS_SCRATCH=1 DATABASE_URL=<ops_slice1_scratch url>

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import {
  addMilestone,
  assertLegalProjectTransition,
  completeProject,
  fmtMinutes,
  logTimeEntry,
  markTimeEntryBilled,
  projectProgress,
  projectTimeTotals,
  setMilestoneStatus,
} from "../projects";

const ACTOR: OpsActor = { workspaceId: "ws_proj4", userId: "user_proj4" };
const PROJECTS = OPS_ENTITY_MAP["projects"];

const BASE_PROJECT = {
  id: "proj_1",
  workspaceId: ACTOR.workspaceId,
  customerId: "lead_1",
  name: "Website redesign",
  milestones: [
    { title: "Kickoff", status: "done" },
    { title: "Design", status: "open" },
  ],
  status: "active",
  leadId: "lead_1",
  dealId: null,
  createdAt: new Date().toISOString(),
};

/** Stub tx: projects + time entries + audit capture. */
function makeStubTx(
  project: Record<string, unknown> = BASE_PROJECT,
  timeEntries: Array<Record<string, unknown>> = [],
) {
  const audits: Array<Record<string, unknown>> = [];
  const createdEntries: Array<Record<string, unknown>> = [];
  const state = { project: { ...project }, timeEntries: [...timeEntries] };
  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "opsAuditEvent") {
          return {
            create: async (a: { data: Record<string, unknown> }) => {
              audits.push(a.data);
              return a.data;
            },
          };
        }
        if (prop === "opsTimeEntry") {
          return {
            findMany: async () => [...state.timeEntries],
            findFirst: async (a: { where: { id: string } }) =>
              state.timeEntries.find((e) => e["id"] === a.where.id) ?? null,
            create: async (a: { data: Record<string, unknown> }) => {
              // Prisma applies the DB default (billed=false); the stub must too.
              const row = { billed: false, ...a.data, id: `te_${createdEntries.length + 1}` };
              createdEntries.push(row);
              state.timeEntries.push(row);
              return row;
            },
            update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
              const i = state.timeEntries.findIndex((e) => e["id"] === a.where.id);
              if (i === -1) throw new Error("not found");
              state.timeEntries[i] = { ...state.timeEntries[i], ...a.data };
              return state.timeEntries[i];
            },
          };
        }
        if (prop === "opsProject") {
          return {
            findFirst: async () => ({ ...state.project }),
            findMany: async () => [{ ...state.project }],
            create: async (a: { data: Record<string, unknown> }) => ({ ...a.data, id: "proj_new" }),
            update: async (a: { data: Record<string, unknown> }) => {
              state.project = { ...state.project, ...a.data };
              return { ...state.project };
            },
          };
        }
        throw new Error(`unexpected delegate ${prop}`);
      },
    },
  );
  return { tx: tx as unknown as Prisma.TransactionClient, audits, state };
}

describe("milestones (service conveniences)", () => {
  it("addMilestone appends and returns computed progress", async () => {
    const { tx, audits } = makeStubTx();
    const { project, progress } = await addMilestone(tx, ACTOR, "proj_1", { title: "Launch" });
    const ms = project.milestones as Array<{ title: string; status: string }>;
    assert.equal(ms.length, 3);
    assert.equal(ms[2]!.title, "Launch");
    assert.equal(ms[2]!.status, "open");
    assert.deepEqual(progress, { total: 3, done: 1, open: 2, pct: 33 });
    assert.ok(audits.some((a) => a["action"] === "milestone_added"));
  });

  it("addMilestone rejects empty titles and bad dueAt", async () => {
    const { tx } = makeStubTx();
    await assert.rejects(() => addMilestone(tx, ACTOR, "proj_1", { title: "  " }), (e: Error) =>
      e instanceof OpsError && e.status === 400,
    );
    await assert.rejects(
      () => addMilestone(tx, ACTOR, "proj_1", { title: "X", dueAt: "not-a-date" }),
      (e: Error) => e instanceof OpsError && e.status === 400,
    );
  });

  it("setMilestoneStatus completes and reopens; progress follows", async () => {
    const { tx } = makeStubTx();
    const done = await setMilestoneStatus(tx, ACTOR, "proj_1", 1, "done");
    assert.deepEqual(done.progress, { total: 2, done: 2, open: 0, pct: 100 });
    const reopened = await setMilestoneStatus(tx, ACTOR, "proj_1", 0, "open");
    assert.deepEqual(reopened.progress, { total: 2, done: 1, open: 1, pct: 50 });
  });

  it("setMilestoneStatus 404s on a bad index", async () => {
    const { tx } = makeStubTx();
    await assert.rejects(() => setMilestoneStatus(tx, ACTOR, "proj_1", 9, "done"), (e: Error) =>
      e instanceof OpsError && e.status === 404,
    );
  });

  it("projectProgress handles the empty list", () => {
    assert.deepEqual(projectProgress([]), { total: 0, done: 0, open: 0, pct: 0 });
  });
});

describe("time ledger (append-only, integer minutes)", () => {
  it("logTimeEntry writes a row and audits it", async () => {
    const { tx, audits } = makeStubTx();
    const entry = await logTimeEntry(tx, ACTOR, "proj_1", {
      minutes: 90,
      description: "Homepage mockups",
    });
    assert.equal(entry.minutes, 90);
    assert.equal(entry.billed, false);
    assert.ok(audits.some((a) => a["action"] === "time_logged"));
  });

  it("logTimeEntry rejects non-positive, fractional, and absurd durations", async () => {
    const { tx } = makeStubTx();
    for (const minutes of [0, -30, 1.5, 24 * 60 * 32]) {
      await assert.rejects(() => logTimeEntry(tx, ACTOR, "proj_1", { minutes }), (e: Error) =>
        e instanceof OpsError && e.status === 400,
      );
    }
  });

  it("logTimeEntry rejects future occurredAt", async () => {
    const { tx } = makeStubTx();
    await assert.rejects(
      () =>
        logTimeEntry(tx, ACTOR, "proj_1", {
          minutes: 30,
          occurredAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        }),
      (e: Error) => e instanceof OpsError && e.status === 400,
    );
  });

  it("projectTimeTotals splits billed vs unbilled", async () => {
    const { tx } = makeStubTx(BASE_PROJECT, [
      { id: "te_1", minutes: 120, billed: true },
      { id: "te_2", minutes: 45, billed: false },
    ]);
    const totals = await projectTimeTotals(tx, ACTOR, "proj_1");
    assert.deepEqual(totals, { totalMinutes: 165, billedMinutes: 120, unbilledMinutes: 45, entries: 2 });
  });

  it("markTimeEntryBilled flips billed and is scoped to the project", async () => {
    const { tx } = makeStubTx(BASE_PROJECT, [{ id: "te_1", minutes: 60, billed: false }]);
    const row = await markTimeEntryBilled(tx, ACTOR, "proj_1", "te_1");
    assert.equal(row.billed, true);
    const totals = await projectTimeTotals(tx, ACTOR, "proj_1");
    assert.equal(totals.unbilledMinutes, 0);
  });
});

describe("complete project + unbilled nudge (info only, never a gate)", () => {
  it("completeProject transitions active → completed and nudges on unbilled time", async () => {
    const { tx, audits } = makeStubTx(BASE_PROJECT, [{ id: "te_1", minutes: 135, billed: false }]);
    const res = await completeProject(tx, ACTOR, "proj_1");
    assert.equal(res.project.status, "completed");
    assert.equal(res.unbilledMinutes, 135);
    assert.ok(res.nudge !== null && res.nudge.includes("2h 15m"));
    assert.ok(audits.some((a) => a["action"] === "completed"));
  });

  it("no nudge when everything is billed", async () => {
    const { tx } = makeStubTx(BASE_PROJECT, [{ id: "te_1", minutes: 60, billed: true }]);
    const res = await completeProject(tx, ACTOR, "proj_1");
    assert.equal(res.nudge, null);
    assert.equal(res.unbilledMinutes, 0);
  });

  it("completeProject is NOT gated — it always executes", async () => {
    const { tx } = makeStubTx(BASE_PROJECT, [{ id: "te_1", minutes: 30, billed: false }]);
    const res = await completeProject(tx, ACTOR, "proj_1");
    assert.equal(res.project.status, "completed", "no approval dance — just the nudge");
    assert.ok(res.nudge !== null);
  });

  it("completeProject is idempotent on an already-completed project", async () => {
    const { tx } = makeStubTx({ ...BASE_PROJECT, status: "completed" });
    const res = await completeProject(tx, ACTOR, "proj_1");
    assert.equal(res.project.status, "completed", "re-completing is a safe no-op, not a 422");
  });

  it("but leaving a terminal state through the generic route is still illegal", async () => {
    const { tx } = makeStubTx({ ...BASE_PROJECT, status: "completed" });
    await assert.rejects(
      () => opsPatch(tx, PROJECTS, ACTOR, { id: "proj_1", status: "active" }),
      (e: Error) => e instanceof OpsError && e.status === 422,
    );
  });
});

describe("status-flow guard (generic PATCH path)", () => {
  it("planning → active is legal; active → completed is legal", () => {
    assertLegalProjectTransition("planning", "active");
    assertLegalProjectTransition("active", "completed");
    assertLegalProjectTransition("active", "on_hold");
    assertLegalProjectTransition("on_hold", "active");
  });

  it("skipping states and exiting terminal states are illegal", () => {
    assert.throws(() => assertLegalProjectTransition("planning", "completed"), (e: Error) =>
      e instanceof OpsError && e.status === 422,
    );
    assert.throws(() => assertLegalProjectTransition("completed", "active"), (e: Error) =>
      e instanceof OpsError && e.status === 422,
    );
    assert.throws(() => assertLegalProjectTransition("cancelled", "on_hold"), (e: Error) =>
      e instanceof OpsError && e.status === 422,
    );
  });

  it("opsPatch enforces the guard on the generic route", async () => {
    const { tx } = makeStubTx({ ...BASE_PROJECT, status: "planning" });
    // planning → completed skips active: must fail.
    await assert.rejects(
      () => opsPatch(tx, PROJECTS, ACTOR, { id: "proj_1", status: "completed" }),
      (e: Error) => e instanceof OpsError && e.status === 422,
    );
  });

  it("opsPatch allows legal transitions and non-status patches on terminal projects", async () => {
    const { tx } = makeStubTx({ ...BASE_PROJECT, status: "planning" });
    const ok = await opsPatch(tx, PROJECTS, ACTOR, { id: "proj_1", status: "active" });
    assert.equal(ok.outcome, "done");

    const { tx: tx2 } = makeStubTx({ ...BASE_PROJECT, status: "completed" });
    const nameOk = await opsPatch(tx2, PROJECTS, ACTOR, { id: "proj_1", name: "Renamed" });
    assert.equal(nameOk.outcome, "done", "renaming a completed project is fine");
  });
});

describe("project create: CRM lead linkage", () => {
  it("create stores customerId + leadId (lead-turned-customer, no parallel table)", async () => {
    const { tx } = makeStubTx();
    const res = await opsCreate(tx, PROJECTS, ACTOR, {
      name: "Brand sprint",
      customerId: "lead_9",
      leadId: "lead_9",
      milestones: [{ title: "Discovery", status: "open" }],
    });
    assert.equal(res.outcome, "done");
    if (res.outcome === "done") {
      const row = res.row as Record<string, unknown>;
      assert.equal(row["customerId"], "lead_9");
      assert.equal(row["leadId"], "lead_9");
      assert.equal(row["status"], "planning", "new projects start in planning");
    }
  });
});

describe("fmtMinutes", () => {
  it("renders minutes, hours, and mixed durations", () => {
    assert.equal(fmtMinutes(45), "45 min");
    assert.equal(fmtMinutes(60), "1h");
    assert.equal(fmtMinutes(135), "2h 15m");
  });
});

// ---------------------------------------------------------------------------
// RLS integration on the scratch DB (gated on OPS_SCRATCH=1 so the default
// suite never touches a live database).
// ---------------------------------------------------------------------------

const RUN_RLS = process.env.OPS_SCRATCH === "1";

(RUN_RLS ? describe : describe.skip)("project RLS isolation (scratch DB)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let withWorkspaceScope: typeof import("@/lib/substrate/memory/rls").withWorkspaceScope;
  let countWithoutScope: typeof import("@/lib/substrate/memory/rls").countWithoutScope;

  const WS_A = "17s4-ws-a";
  const WS_B = "17s4-ws-b";

  before(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ withWorkspaceScope, countWithoutScope } = await import("@/lib/substrate/memory/rls"));
    await prisma.$executeRawUnsafe(
      `INSERT INTO workspaces (id) VALUES ('${WS_A}'), ('${WS_B}') ON CONFLICT DO NOTHING`,
    );
  });

  after(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM workspaces WHERE id IN ('${WS_A}', '${WS_B}')`);
    await prisma.$disconnect();
  });

  it("ops_projects and ops_time_entries are tenant-isolated", async () => {
    const project = await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsProject: { create(a: unknown): Promise<{ id: string }> } }).opsProject.create({
        data: { workspaceId: WS_A, name: "Secret project", milestones: [] },
      }),
    );
    await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsTimeEntry: { create(a: unknown): Promise<unknown> } }).opsTimeEntry.create({
        data: { workspaceId: WS_A, projectId: project.id, minutes: 30 },
      }),
    );

    // Workspace B sees nothing.
    const seenByB = await withWorkspaceScope(WS_B, (tx) =>
      (tx as unknown as { opsProject: { count(a: unknown): Promise<number> } }).opsProject.count({
        where: { id: project.id },
      }),
    );
    assert.equal(seenByB, 0);
    const entriesByB = await withWorkspaceScope(WS_B, (tx) =>
      (tx as unknown as { opsTimeEntry: { count(a: unknown): Promise<number> } }).opsTimeEntry.count({
        where: { projectId: project.id },
      }),
    );
    assert.equal(entriesByB, 0);

    // Unscoped sessions see zero rows on both new tables.
    assert.equal(await countWithoutScope("ops_projects"), 0);
    assert.equal(await countWithoutScope("ops_time_entries"), 0);

    // Deleting the project cascades to its time ledger.
    await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsProject: { delete(a: unknown): Promise<unknown> } }).opsProject.delete({
        where: { id: project.id },
      }),
    );
    const remaining = await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsTimeEntry: { count(a: unknown): Promise<number> } }).opsTimeEntry.count({
        where: { projectId: project.id },
      }),
    );
    assert.equal(remaining, 0, "time entries cascade-delete with their project");
  });
});
