// Marketr — Phase 17 slice 5 tests: HR essentials (team directory +
// leave requests), gate-on-approve, transition guard, HR RLS.
// Run: npx tsx --test lib/ops/__tests__/hr.test.ts
// RLS block also needs: OPS_SCRATCH=1 DATABASE_URL=<ops_slice1_scratch url>

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { approvalClaimDelegate } from "./approval-claims";

import { OPS_ENTITY_MAP } from "../entities";
import { OPS_MONEY_ACTION_MAP, opsBindingFor, type OpsGatePort } from "../gate";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { assertLegalLeaveTransition } from "../hr";
import { NotFoundError } from "@/lib/api/errors";

const ACTOR: OpsActor = { workspaceId: "ws_hr5", userId: "user_hr5" };
const MEMBERS = OPS_ENTITY_MAP["team-members"];
const LEAVES = OPS_ENTITY_MAP["leave-requests"];

const MEMBER_ROW = {
  id: "mem_1",
  workspaceId: ACTOR.workspaceId,
  name: "Ada Lovelace",
  title: "Engineer",
  email: "ada@example.com",
  startDate: new Date("2026-01-05T00:00:00Z").toISOString(),
  status: "active",
  createdAt: new Date().toISOString(),
};

const LEAVE_REQUESTED = {
  id: "leave_1",
  workspaceId: ACTOR.workspaceId,
  memberId: "mem_1",
  type: "vacation",
  startDate: new Date("2026-12-20T00:00:00Z").toISOString(),
  endDate: new Date("2026-12-27T00:00:00Z").toISOString(),
  status: "requested",
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date().toISOString(),
};

/** Stub gate port with a configurable approval record. */
function portWith(
  approval: { status: string; proposedArgs: unknown; expiresAt?: Date } | null,
): OpsGatePort {
  return {
    propose: async () => ({ id: "ap_1", status: "pending", riskTier: "medium" }),
    getApproval: async (_ws, id) => {
      if (!approval) throw new NotFoundError("Approval not found");
      return {
        id,
        status: approval.status,
        expiresAt: approval.expiresAt ?? new Date(Date.now() + 3600_000),
        proposedArgs: approval.proposedArgs,
      };
    },
  };
}

function approvedLeavePort(): OpsGatePort {
  return portWith({
    status: "approved",
    proposedArgs: opsBindingFor({
      entity: "leave-requests",
      entityId: "leave_1",
      slug: "OPS_LEAVE_APPROVE",
      mutation: { id: "leave_1", status: "approved" },
    }),
  });
}

/** Proxy stub tx: generic delegates + audit capture + update spy. */
function makeStubTx(existing: Record<string, unknown>, opts: { createdId?: string } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const claims = approvalClaimDelegate();
  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "composioActionApproval") return claims;
        if (prop === "opsAuditEvent") {
          return {
            create: async (a: { data: Record<string, unknown> }) => {
              audits.push(a.data);
              return a.data;
            },
          };
        }
        return {
          findFirst: async () => ({ ...existing }),
          findMany: async () => [{ ...existing }],
          create: async (a: { data: Record<string, unknown> }) => {
            const row = { ...a.data, id: opts.createdId ?? "hr_new" };
            created.push(row);
            return row;
          },
          update: async (args: { data: Record<string, unknown> }) => {
            return { ...existing, ...args.data };
          },
        };
      },
    },
  );
  return { tx: tx as unknown as Prisma.TransactionClient, created, audits };
}

describe("HR: team member directory", () => {
  it("member create is a free logged write; startDate parsed to a Date", async () => {
    const { tx, created, audits } = makeStubTx(MEMBER_ROW, { createdId: "mem_new" });
    const res = await opsCreate(tx, MEMBERS, ACTOR, {
      name: "Grace Hopper",
      title: "Admiral",
      startDate: "2026-02-01",
    });
    assert.equal(res.outcome, "done");
    assert.ok(created[0]!.startDate instanceof Date, "startDate must be a Date");
    assert.ok(audits.some((a) => a.action === "create"));
  });

  it("member create with an invalid startDate fails 400", async () => {
    const { tx } = makeStubTx(MEMBER_ROW);
    await assert.rejects(
      () => opsCreate(tx, MEMBERS, ACTOR, { name: "Nope", startDate: "not-a-date" }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
  });

  it("member status patch is a free write (active → inactive)", async () => {
    const { tx, audits } = makeStubTx(MEMBER_ROW);
    const res = await opsPatch(tx, MEMBERS, ACTOR, { id: "mem_1", status: "inactive" });
    assert.equal(res.outcome, "done");
    if (res.outcome === "done") assert.equal(res.row.status, "inactive");
    assert.ok(audits.some((a) => a.action === "update"));
  });
});

describe("HR: leave request lifecycle", () => {
  it("leave create is free; forces status requested; validates the date range", async () => {
    const { tx, created } = makeStubTx(LEAVE_REQUESTED, { createdId: "leave_new" });
    const res = await opsCreate(tx, LEAVES, ACTOR, {
      memberId: "mem_1",
      type: "vacation",
      startDate: "2026-12-20",
      endDate: "2026-12-27",
    });
    assert.equal(res.outcome, "done");
    assert.equal(created[0]!.status, "requested", "initial status is set explicitly, not by DB default");
    assert.ok(created[0]!.startDate instanceof Date);
  });

  it("leave create rejects endDate before startDate (400)", async () => {
    const { tx } = makeStubTx(LEAVE_REQUESTED);
    await assert.rejects(
      () =>
        opsCreate(tx, LEAVES, ACTOR, {
          memberId: "mem_1",
          type: "sick",
          startDate: "2026-12-27",
          endDate: "2026-12-20",
        }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
  });

  it("approve without an approvalId proposes OPS_LEAVE_APPROVE (202-style)", async () => {
    const { tx, audits } = makeStubTx(LEAVE_REQUESTED);
    const res = await opsPatch(tx, LEAVES, ACTOR, { id: "leave_1", status: "approved" }, {
      gatePort: portWith(null),
    });
    assert.equal(res.outcome, "approval_required");
    if (res.outcome === "approval_required") {
      assert.equal(res.classification.slug, "OPS_LEAVE_APPROVE");
      assert.equal(res.classification.tier, "medium");
      assert.ok(res.approval.id);
    }
    assert.ok(audits.some((a) => a.action === "gate_proposed"));
  });

  it("approve with an approved, binding-matching approvalId executes and records the decision", async () => {
    const { tx, audits } = makeStubTx(LEAVE_REQUESTED);
    const res = await opsPatch(
      tx,
      LEAVES,
      ACTOR,
      { id: "leave_1", status: "approved", approvalId: "ap_1" },
      { gatePort: approvedLeavePort() },
    );
    assert.equal(res.outcome, "done");
    if (res.outcome === "done") {
      assert.equal(res.row.status, "approved");
      assert.equal(res.row.decidedBy, ACTOR.userId, "decision author recorded");
      assert.ok(res.row.decidedAt instanceof Date, "decision timestamp recorded");
    }
    assert.ok(audits.some((a) => a.action === "gate_executed"));
  });

  it("deny is a free logged write (no gate)", async () => {
    const { tx, audits } = makeStubTx(LEAVE_REQUESTED);
    const res = await opsPatch(tx, LEAVES, ACTOR, { id: "leave_1", status: "denied" }, {
      gatePort: portWith(null),
    });
    assert.equal(res.outcome, "done");
    if (res.outcome === "done") assert.equal(res.row.status, "denied");
    assert.ok(!audits.some((a) => String(a.action).startsWith("gate_")));
  });

  it("taken from approved is a free logged write", async () => {
    const { tx } = makeStubTx({ ...LEAVE_REQUESTED, status: "approved" });
    const res = await opsPatch(tx, LEAVES, ACTOR, { id: "leave_1", status: "taken" }, {
      gatePort: portWith(null),
    });
    assert.equal(res.outcome, "done");
    if (res.outcome === "done") assert.equal(res.row.status, "taken");
  });
});

describe("HR: gate-bypass negatives on leave approve", () => {
  const attempt = (gatePort: OpsGatePort) => {
    const { tx } = makeStubTx(LEAVE_REQUESTED);
    return opsPatch(
      tx,
      LEAVES,
      ACTOR,
      { id: "leave_1", status: "approved", approvalId: "ap_1" },
      { gatePort },
    );
  };

  it("unknown approval id fails closed", async () => {
    await assert.rejects(() => attempt(portWith(null)), /Approval not found|OpsGateError|not found/i);
  });

  it("denied approval fails closed", async () => {
    await assert.rejects(
      () =>
        attempt(
          portWith({
            status: "denied",
            proposedArgs: opsBindingFor({
              entity: "leave-requests",
              entityId: "leave_1",
              slug: "OPS_LEAVE_APPROVE",
              mutation: { id: "leave_1", status: "approved" },
            }),
          }),
        ),
      (e: unknown) => e instanceof Error && /denied|closed/i.test(e.message),
    );
  });

  it("expired approval fails closed", async () => {
    await assert.rejects(
      () =>
        attempt(
          portWith({
            status: "approved",
            expiresAt: new Date(Date.now() - 1000),
            proposedArgs: opsBindingFor({
              entity: "leave-requests",
              entityId: "leave_1",
              slug: "OPS_LEAVE_APPROVE",
              mutation: { id: "leave_1", status: "approved" },
            }),
          }),
        ),
      (e: unknown) => e instanceof Error && /expir/i.test(e.message),
    );
  });

  it("binding mismatch (approve leave_1, execute leave_2) fails closed", async () => {
    await assert.rejects(
      () =>
        attempt(
          portWith({
            status: "approved",
            proposedArgs: opsBindingFor({
              entity: "leave-requests",
              entityId: "leave_2",
              slug: "OPS_LEAVE_APPROVE",
              mutation: { id: "leave_2", status: "approved" },
            }),
          }),
        ),
      (e: unknown) => e instanceof Error && /binding|mismatch/i.test(e.message),
    );
  });
});

describe("HR: leave transition guard", () => {
  it("requested → approved/denied is legal", () => {
    assertLegalLeaveTransition("requested", "approved");
    assertLegalLeaveTransition("requested", "denied");
  });

  it("approved → taken is legal", () => {
    assertLegalLeaveTransition("approved", "taken");
  });

  it("denied and taken are terminal", async () => {
    for (const from of ["denied", "taken"]) {
      for (const to of ["approved", "denied", "taken"]) {
        await assert.rejects(
          async () => assertLegalLeaveTransition(from, to),
          (e: unknown) => e instanceof OpsError && e.status === 422,
          `${from} → ${to} must be illegal`,
        );
      }
    }
  });

  it("taken directly from requested is illegal (must pass through approved)", async () => {
    const { tx } = makeStubTx(LEAVE_REQUESTED);
    await assert.rejects(
      () => opsPatch(tx, LEAVES, ACTOR, { id: "leave_1", status: "taken" }),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
  });

  it("OPS_LEAVE_APPROVE is pinned at medium", () => {
    assert.equal(OPS_MONEY_ACTION_MAP["OPS_LEAVE_APPROVE"]?.expectedTier, "medium");
  });
});

// ---------------------------------------------------------------------------
// RLS integration on the scratch DB (gated on OPS_SCRATCH=1 so the default
// suite never touches a live database).
// ---------------------------------------------------------------------------

const RUN_RLS = process.env.OPS_SCRATCH === "1";

(RUN_RLS ? describe : describe.skip)("HR RLS isolation (scratch DB)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let withWorkspaceScope: typeof import("@/lib/substrate/memory/rls").withWorkspaceScope;
  let countWithoutScope: typeof import("@/lib/substrate/memory/rls").countWithoutScope;

  const WS_A = "17s5-ws-a";
  const WS_B = "17s5-ws-b";

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

  it("ops_team_members and ops_leave_requests are tenant-isolated", async () => {
    const member = await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsTeamMember: { create(a: unknown): Promise<{ id: string }> } }).opsTeamMember.create({
        data: { workspaceId: WS_A, name: "Secret Staffer", status: "active" },
      }),
    );
    await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsLeaveRequest: { create(a: unknown): Promise<unknown> } }).opsLeaveRequest.create({
        data: {
          workspaceId: WS_A,
          memberId: member.id,
          type: "vacation",
          startDate: new Date("2026-12-20T00:00:00Z"),
          endDate: new Date("2026-12-27T00:00:00Z"),
          status: "requested",
        },
      }),
    );

    // Workspace B sees nothing.
    const seenMembers = await withWorkspaceScope(WS_B, (tx) =>
      (tx as unknown as { opsTeamMember: { findMany(a: unknown): Promise<unknown[]> } }).opsTeamMember.findMany({
        where: { workspaceId: WS_A },
      }),
    );
    assert.equal(seenMembers.length, 0, "workspace B must not see A's team members");
    const seenLeaves = await withWorkspaceScope(WS_B, (tx) =>
      (tx as unknown as { opsLeaveRequest: { findMany(a: unknown): Promise<unknown[]> } }).opsLeaveRequest.findMany({
        where: { workspaceId: WS_A },
      }),
    );
    assert.equal(seenLeaves.length, 0, "workspace B must not see A's leave requests");

    // Unscoped reads see nothing (FORCE RLS, no GUC).
    assert.equal(await countWithoutScope("ops_team_members"), 0);
    assert.equal(await countWithoutScope("ops_leave_requests"), 0);
  });

  it("cross-workspace INSERT is rejected", async () => {
    await assert.rejects(
      () =>
        withWorkspaceScope(WS_B, (tx) =>
          (tx as unknown as { opsTeamMember: { create(a: unknown): Promise<unknown> } }).opsTeamMember.create({
            data: { workspaceId: WS_A, name: "Sneaky", status: "active" },
          }),
        ),
      (e: unknown) => e instanceof Error,
    );
  });

  it("deleting a member cascades to their leave requests", async () => {
    const member = await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsTeamMember: { create(a: unknown): Promise<{ id: string }> } }).opsTeamMember.create({
        data: { workspaceId: WS_A, name: "Temp Staffer", status: "active" },
      }),
    );
    await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsLeaveRequest: { create(a: unknown): Promise<unknown> } }).opsLeaveRequest.create({
        data: {
          workspaceId: WS_A,
          memberId: member.id,
          type: "sick",
          startDate: new Date("2026-11-01T00:00:00Z"),
          endDate: new Date("2026-11-02T00:00:00Z"),
          status: "requested",
        },
      }),
    );
    await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsTeamMember: { delete(a: unknown): Promise<unknown> } }).opsTeamMember.delete({
        where: { id: member.id },
      }),
    );
    const remaining = await withWorkspaceScope(WS_A, (tx) =>
      (tx as unknown as { opsLeaveRequest: { count(a: unknown): Promise<number> } }).opsLeaveRequest.count({
        where: { memberId: member.id },
      }),
    );
    assert.equal(remaining, 0, "leave requests cascade with the member");
  });
});
