// Marketr — Phase 17 slice 7: ops agent-tools tests.
// Run: npx tsx --test lib/chat/__tests__/ops-tools.test.ts
//
// The core functions take a stub tx + stub gate port (no prisma, no DB).
// The `execute` wrappers add withWorkspaceScope in production; they are not
// unit-tested here (RLS is covered by lib/ops/__tests__/ops-rls.test.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OPS_TOOLS,
  approveLeaveCore,
  draftInvoiceCore,
  launchWorkflowCore,
  markInvoicePaidCore,
  moneyWriteResult,
  sendInvoiceCore,
} from "../ops-tools";
import type { OpsGatePort } from "@/lib/ops/gate";

const ACTOR = { userId: "u_1", workspaceId: "ws_1" };

function stubPort(captured: { input?: unknown } = {}): OpsGatePort {
  return {
    propose: async (input) => {
      captured.input = input;
      return { id: "appr_1", status: "pending", riskTier: "medium" };
    },
    getApproval: async () => {
      throw new Error("not used");
    },
  };
}

function auditStub(calls: string[]) {
  return {
    create: async () => {
      calls.push("audit");
      return {};
    },
  };
}

describe("OPS_TOOLS registration contract", () => {
  it("exposes the full ops tool surface (15 tools)", () => {
    const names = OPS_TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ops_approve_leave",
      "ops_create_project",
      "ops_draft_invoice",
      "ops_draft_purchase_order",
      "ops_launch_workflow",
      "ops_list_invoices",
      "ops_list_products",
      "ops_list_projects",
      "ops_list_purchase_orders",
      "ops_list_team",
      "ops_list_workflow_runs",
      "ops_mark_invoice_paid",
      "ops_operations_summary",
      "ops_request_leave",
      "ops_send_invoice",
    ]);
  });

  it("names are unique and every tool declares kind/minRole/argsSchema", () => {
    const names = OPS_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool names");
    for (const t of OPS_TOOLS) {
      assert.ok(["safe", "spend", "publish", "destructive"].includes(t.kind), `${t.name}: bad kind`);
      assert.ok(["viewer", "editor", "admin", "owner"].includes(t.minRole), `${t.name}: bad minRole`);
      assert.ok(t.description && t.description.length > 10, `${t.name}: missing description`);
      assert.equal(t.argsSchema.type, "object", `${t.name}: argsSchema must be an object schema`);
    }
  });

  it("reads are safe/viewer; writes are publish/editor", () => {
    const byName = Object.fromEntries(OPS_TOOLS.map((t) => [t.name, t]));
    for (const n of [
      "ops_operations_summary",
      "ops_list_invoices",
      "ops_list_products",
      "ops_list_purchase_orders",
      "ops_list_projects",
      "ops_list_team",
      "ops_list_workflow_runs",
    ]) {
      assert.equal(byName[n].kind, "safe", n);
      assert.equal(byName[n].minRole, "viewer", n);
    }
    for (const n of [
      "ops_draft_invoice",
      "ops_draft_purchase_order",
      "ops_create_project",
      "ops_request_leave",
      "ops_send_invoice",
      "ops_mark_invoice_paid",
      "ops_approve_leave",
      "ops_launch_workflow",
    ]) {
      assert.equal(byName[n].kind, "publish", n);
      assert.equal(byName[n].minRole, "editor", n);
    }
  });
});

describe("draft creators (free, logged writes)", () => {
  it("ops_draft_invoice creates a draft and hints the generative card", async () => {
    const calls: string[] = [];
    const tx = {
      opsInvoice: {
        findMany: async () => [],
        create: async (args: { data: Record<string, unknown> }) => {
          calls.push("opsInvoice.create");
          return { id: "inv_1", status: "draft", ...args.data };
        },
      },
      opsAuditEvent: auditStub(calls),
    } as never;
    const r = await draftInvoiceCore(
      tx,
      ACTOR,
      {
        lineItems: JSON.stringify([{ description: "SEO retainer — Oct", qty: 1, priceCents: 150000 }]),
        taxCents: "15000",
      },
      stubPort(),
    );
    assert.ok(calls.includes("opsInvoice.create"), "draft must be written");
    assert.ok(calls.includes("audit"), "draft must be audited");
    assert.ok(r.summary.includes("inv_1"), `summary names the invoice: ${r.summary}`);
    assert.ok(r.summary.includes("ops_invoice_card"), "summary hints the generative card");
    assert.equal((r.details as { totalCents: number }).totalCents, 165000);
  });

  it("ops_draft_invoice rejects missing/invalid lineItems", async () => {
    const tx = { opsAuditEvent: auditStub([]) } as never;
    await assert.rejects(() => draftInvoiceCore(tx, ACTOR, {}, stubPort()), /lineItems/);
    await assert.rejects(
      () => draftInvoiceCore(tx, ACTOR, { lineItems: "not json" }, stubPort()),
      /valid JSON/,
    );
  });
});

describe("money-write tools (propose-only, never execute)", () => {
  function invoiceTx(calls: string[]) {
    return {
      opsInvoice: {
        findMany: async () => [],
        findFirst: async () => ({ id: "inv_1", status: "draft", totalCents: 10000 }),
        update: async () => {
          calls.push("opsInvoice.update");
          return {};
        },
      },
      opsAuditEvent: auditStub(calls),
    } as never;
  }

  it("ops_send_invoice proposes OPS_INVOICE_SEND and never updates the row", async () => {
    const calls: string[] = [];
    const captured: { input?: unknown } = {};
    const r = await sendInvoiceCore(invoiceTx(calls), ACTOR, { invoiceId: "inv_1" }, stubPort(captured));
    assert.equal((r.details as { approvalId: string }).approvalId, "appr_1");
    assert.ok(r.summary.includes("Approval required"), r.summary);
    assert.ok(!calls.includes("opsInvoice.update"), "money write must not execute");
    const input = captured.input as { toolName: string; appKey: string };
    assert.equal(input.toolName, "OPS_INVOICE_SEND");
    assert.equal(input.appKey, "ops");
  });

  it("ops_mark_invoice_paid proposes OPS_INVOICE_MARK_PAID and never updates the row", async () => {
    const calls: string[] = [];
    const captured: { input?: unknown } = {};
    const r = await markInvoicePaidCore(invoiceTx(calls), ACTOR, { invoiceId: "inv_1" }, stubPort(captured));
    assert.equal((r.details as { approvalId: string }).approvalId, "appr_1");
    assert.ok(!calls.includes("opsInvoice.update"), "money write must not execute");
    assert.equal((captured.input as { toolName: string }).toolName, "OPS_INVOICE_MARK_PAID");
  });

  it("ops_approve_leave proposes OPS_LEAVE_APPROVE and never updates the row", async () => {
    const calls: string[] = [];
    const captured: { input?: unknown } = {};
    const tx = {
      opsLeaveRequest: {
        findMany: async () => [],
        findFirst: async () => ({ id: "lr_1", status: "requested" }),
        update: async () => {
          calls.push("opsLeaveRequest.update");
          return {};
        },
      },
      opsAuditEvent: auditStub(calls),
    } as never;
    const r = await approveLeaveCore(tx, ACTOR, { requestId: "lr_1" }, stubPort(captured));
    assert.equal((r.details as { approvalId: string }).approvalId, "appr_1");
    assert.ok(!calls.includes("opsLeaveRequest.update"), "leave approval must not execute");
    assert.equal((captured.input as { toolName: string }).toolName, "OPS_LEAVE_APPROVE");
  });

  it("moneyWriteResult throws if a service ever returned 'done' (fail-closed)", () => {
    assert.throws(
      () =>
        moneyWriteResult({
          outcome: "done",
          row: { id: "x" },
          classification: { mode: "free", label: "X" },
        } as never),
      /without a Phase 14 approval/,
    );
    const proposed = moneyWriteResult({
      outcome: "approval_required",
      approval: { id: "appr_1", status: "pending", riskTier: "medium" },
      classification: { mode: "gated", label: "Send invoice", slug: "OPS_INVOICE_SEND" },
    } as never);
    assert.equal((proposed.details as { approvalId: string }).approvalId, "appr_1");
  });
});

describe("ops_launch_workflow (propose-only)", () => {
  it("proposes OPS_WORKFLOW_RUN with the step/rollback plan and never creates a run", async () => {
    const calls: string[] = [];
    const captured: { input?: unknown } = {};
    const tx = {
      opsOrder: {
        findFirst: async () => ({ id: "ord_1", status: "draft", totalCents: 5000 }),
      },
      opsWorkflowRun: {
        findFirst: async () => null,
        create: async () => {
          calls.push("opsWorkflowRun.create");
          return {};
        },
      },
      opsAuditEvent: auditStub(calls),
    } as never;
    const r = await launchWorkflowCore(
      tx,
      ACTOR,
      {
        workflowName: "order-payment-fulfillment",
        runKey: "rk_1",
        inputs: JSON.stringify({ orderId: "ord_1" }),
      },
      stubPort(captured),
    );
    assert.equal((r.details as { approvalId: string }).approvalId, "appr_1");
    assert.ok(!calls.includes("opsWorkflowRun.create"), "workflow must not launch");
    assert.ok(r.summary.includes("Actions queue"), r.summary);
    const input = captured.input as { toolName: string; args: Record<string, unknown> };
    assert.equal(input.toolName, "OPS_WORKFLOW_RUN");
  });

  it("rejects unknown workflows and missing runKey", async () => {
    const tx = { opsAuditEvent: auditStub([]) } as never;
    await assert.rejects(
      () => launchWorkflowCore(tx, ACTOR, { workflowName: "nope", runKey: "rk" }, stubPort()),
      /Unknown workflow/,
    );
    await assert.rejects(
      () => launchWorkflowCore(tx, ACTOR, { workflowName: "order-payment-fulfillment" }, stubPort()),
      /runKey/,
    );
  });
});
