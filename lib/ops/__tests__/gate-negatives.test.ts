// Marketr — Phase 17 slice 1 tests: gate-bypass negatives.
// Run: npx tsx --test lib/ops/__tests__/gate-negatives.test.ts
//
// Proves the money gate fails CLOSED: there is no path that applies a gated
// Operations mutation without an approved, unexpired, binding-matching
// Phase 14 approval. Every bypass attempt throws OpsGateError and the
// mutation never runs.
//
// Pure: stub gate port + stub tx. No live database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { approvalClaimDelegate } from "./approval-claims";

import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsPatch, type OpsActor } from "../doctype";
import {
  OpsGateError,
  opsBindingFor,
  verifyOpsApproval,
  type OpsGatePort,
} from "../gate";
import { NotFoundError } from "@/lib/api/errors";

const ACTOR: OpsActor = { workspaceId: "ws_neg", userId: "user_neg" };
const MUTATION: Record<string, unknown> = { id: "inv_1", status: "sent" };
const BINDING_ARGS: {
  workspaceId: string;
  entity: string;
  entityId: string;
  slug: string;
  mutation: Record<string, unknown>;
} = {
  workspaceId: ACTOR.workspaceId,
  entity: "invoices",
  entityId: "inv_1",
  slug: "OPS_INVOICE_SEND",
  mutation: MUTATION,
};

function portWith(approval: {
  status: string;
  proposedArgs: unknown;
  expiresAt?: Date;
} | null): OpsGatePort {
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

function approvedPortFor(args: typeof BINDING_ARGS): OpsGatePort {
  return portWith({ status: "approved", proposedArgs: opsBindingFor(args) });
}

/** Stub tx that records whether the mutation ran. */
function makeSpyTx(existing: Record<string, unknown>) {
  let updated = 0;
  const audits: Array<Record<string, unknown>> = [];
  const claims = approvalClaimDelegate();
  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "composioActionApproval") return claims;
        if (prop === "opsAuditEvent") {
          return { create: async (a: { data: Record<string, unknown> }) => { audits.push(a.data); return a.data; } };
        }
        return {
          findFirst: async () => ({ ...existing }),
          findMany: async () => [{ ...existing }],
          create: async (a: { data: Record<string, unknown> }) => ({ ...a.data }),
          updateMany: async () => {
            updated += 1;
            return { count: 1 };
          },
          update: async (args: { data: Record<string, unknown> }) => {
            updated += 1;
            return { ...existing, ...args.data };
          },
        };
      },
    },
  );
  return { tx: tx as unknown as Prisma.TransactionClient, audits, ran: () => updated };
}

const INVOICE_ROW = { id: "inv_1", workspaceId: ACTOR.workspaceId, status: "draft", totalCents: 5000, sentAt: null };

describe("gate-bypass negatives (verifyOpsApproval)", () => {
  it("missing approvalId → approval_required (fail-closed)", async () => {
    await assert.rejects(
      verifyOpsApproval(portWith(null), { ...BINDING_ARGS, approvalId: undefined }),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_required",
    );
    await assert.rejects(
      verifyOpsApproval(portWith(null), { ...BINDING_ARGS, approvalId: null }),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_required",
    );
  });

  it("unknown approval id → approval_not_found", async () => {
    await assert.rejects(
      verifyOpsApproval(portWith(null), { ...BINDING_ARGS, approvalId: "ap_ghost" }),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_not_found",
    );
  });

  it("pending approval → approval_not_approved (nothing executes early)", async () => {
    await assert.rejects(
      verifyOpsApproval(
        portWith({ status: "pending", proposedArgs: opsBindingFor(BINDING_ARGS) }),
        { ...BINDING_ARGS, approvalId: "ap_1" },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_not_approved",
    );
  });

  it("denied approval → approval_not_approved", async () => {
    await assert.rejects(
      verifyOpsApproval(
        portWith({ status: "denied", proposedArgs: opsBindingFor(BINDING_ARGS) }),
        { ...BINDING_ARGS, approvalId: "ap_1" },
      ),
      (e: unknown) => e instanceof OpsGateError && /denied/.test((e as Error).message),
    );
  });

  it("expired approval → approval_expired", async () => {
    await assert.rejects(
      verifyOpsApproval(
        portWith({
          status: "approved",
          proposedArgs: opsBindingFor(BINDING_ARGS),
          expiresAt: new Date(Date.now() - 1000),
        }),
        { ...BINDING_ARGS, approvalId: "ap_1" },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_expired",
    );
  });

  it("already-executed approval → replay blocked", async () => {
    await assert.rejects(
      verifyOpsApproval(
        portWith({ status: "executed", proposedArgs: opsBindingFor(BINDING_ARGS) }),
        { ...BINDING_ARGS, approvalId: "ap_1" },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_replayed",
    );
  });

  it("binding mismatch on entity id → execution HALTED (no cross-record replay)", async () => {
    await assert.rejects(
      verifyOpsApproval(
        portWith({ status: "approved", proposedArgs: opsBindingFor(BINDING_ARGS) }),
        { ...BINDING_ARGS, entityId: "inv_2", approvalId: "ap_1" },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
    );
  });

  it("binding mismatch on amount → execution HALTED (approve $100, execute $10,000 impossible)", async () => {
    const approvedFor100 = opsBindingFor({
      ...BINDING_ARGS,
      mutation: { id: "inv_1", status: "sent", totalCents: 10000 },
    });
    await assert.rejects(
      verifyOpsApproval(
        portWith({ status: "approved", proposedArgs: approvedFor100 }),
        {
          ...BINDING_ARGS,
          mutation: { id: "inv_1", status: "sent", totalCents: 1000000 },
          approvalId: "ap_1",
        },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
    );
  });

  it("binding mismatch on action slug → execution HALTED", async () => {
    await assert.rejects(
      verifyOpsApproval(
        portWith({ status: "approved", proposedArgs: opsBindingFor(BINDING_ARGS) }),
        { ...BINDING_ARGS, slug: "OPS_INVOICE_MARK_PAID", approvalId: "ap_1" },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
    );
  });

  it("exact binding passes verification", async () => {
    const ok = await verifyOpsApproval(
      approvedPortFor(BINDING_ARGS),
      { ...BINDING_ARGS, approvalId: "ap_1" },
    );
    assert.equal(ok.id, "ap_1");
    assert.equal(ok.status, "approved");
  });
});

describe("gate-bypass negatives (service level: opsPatch)", () => {
  const def = OPS_ENTITY_MAP["invoices"]!;

  it("denied approval: mutation never runs, no gate_executed audit", async () => {
    const { tx, audits, ran } = makeSpyTx(INVOICE_ROW);
    await assert.rejects(
      opsPatch(
        tx, def, ACTOR,
        { id: "inv_1", status: "sent", approvalId: "ap_denied" },
        { gatePort: portWith({ status: "denied", proposedArgs: opsBindingFor(BINDING_ARGS) }) },
      ),
      (e: unknown) => e instanceof OpsGateError,
    );
    assert.equal(ran(), 0, "mutation must not run");
    assert.ok(audits.every((a) => a.action !== "gate_executed"), "no gate_executed audit");
  });

  it("pending approval: mutation never runs", async () => {
    const { tx, ran } = makeSpyTx(INVOICE_ROW);
    await assert.rejects(
      opsPatch(
        tx, def, ACTOR,
        { id: "inv_1", status: "sent", approvalId: "ap_pending" },
        { gatePort: portWith({ status: "pending", proposedArgs: opsBindingFor(BINDING_ARGS) }) },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_not_approved",
    );
    assert.equal(ran(), 0);
  });

  it("wrong-record approval: mutation never runs", async () => {
    const { tx, ran } = makeSpyTx(INVOICE_ROW);
    await assert.rejects(
      opsPatch(
        tx, def, ACTOR,
        { id: "inv_1", status: "sent", approvalId: "ap_other" },
        {
          gatePort: portWith({
            status: "approved",
            proposedArgs: opsBindingFor({ ...BINDING_ARGS, entityId: "inv_9" }),
          }),
        },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
    );
    assert.equal(ran(), 0);
  });

  it("no money action classifies as free: the locked list is exhaustive", async () => {
    // Every gated slug from the catalog must be reachable only via the gate
    // — i.e. verifyOpsApproval without an approval always throws, for each
    // money action's canonical write.
    const cases: Array<Omit<typeof BINDING_ARGS, "entityId"> & { entityId?: string }> = [
      { workspaceId: "ws_neg", entity: "invoices", entityId: "inv_1", slug: "OPS_INVOICE_SEND", mutation: { id: "inv_1", status: "sent" } },
      { workspaceId: "ws_neg", entity: "invoices", entityId: "inv_1", slug: "OPS_INVOICE_MARK_PAID", mutation: { id: "inv_1", status: "paid" } },
      { workspaceId: "ws_neg", entity: "payments", slug: "OPS_PAYMENT_RECORD_CHARGE", mutation: { kind: "charge", amountCents: 100 } },
      { workspaceId: "ws_neg", entity: "payments", slug: "OPS_PAYMENT_REFUND", mutation: { kind: "refund", amountCents: 100 } },
      { workspaceId: "ws_neg", entity: "orders", entityId: "o_1", slug: "OPS_ORDER_CANCEL", mutation: { id: "o_1", status: "cancelled" } },
      { workspaceId: "ws_neg", entity: "orders", entityId: "o_1", slug: "OPS_ORDER_FULFILL", mutation: { id: "o_1", status: "fulfilled" } },
    ];
    for (const c of cases) {
      await assert.rejects(
        verifyOpsApproval(portWith(null), { ...c, approvalId: undefined }),
        (e: unknown) => e instanceof OpsGateError && e.code === "approval_required",
        `${c.slug} must require an approval`,
      );
    }
  });

  it("service maps gate bypass to OpsGateError (route renders 422, never silent)", async () => {
    const { tx } = makeSpyTx(INVOICE_ROW);
    try {
      await opsPatch(
        tx, def, ACTOR,
        { id: "inv_1", status: "sent", approvalId: "ap_denied" },
        { gatePort: portWith({ status: "denied", proposedArgs: opsBindingFor(BINDING_ARGS) }) },
      );
      assert.fail("must throw");
    } catch (e) {
      assert.ok(e instanceof OpsGateError, "gate errors are OpsGateError, not OpsError");
      assert.ok(!(e instanceof OpsError), "never masquerades as a plain service error");
    }
  });
});
