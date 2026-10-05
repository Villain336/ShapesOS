// ShapesOS — Phase 10 (finance): finance agent tools (stub tx + stub gate
// port, no DB). Registration, tool groups / automation tiers, and the
// propose-only money writes.
// Run: npx tsx --test lib/chat/__tests__/ops-finance-tools.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPS_TOOLS } from "../ops-tools";
import { TOOL_ACTION, TOOL_GROUP } from "../tools";
import {
  FINANCE_OPS_TOOLS,
  accountingReportCore,
  draftQuoteCore,
  postJournalEntryCore,
  recordPaymentCore,
} from "../ops-finance-tools";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";
import type { OpsGatePort } from "@/lib/ops/gate";

const ACTOR = { userId: "u_1", workspaceId: "ws_1" };
const SETTINGS = { smallActionThresholdCents: 10_000, automationAllows: true };

function stubPort(seen: { input?: { toolName: string; args: Record<string, unknown> } } = {}): OpsGatePort {
  return {
    propose: async (input) => {
      seen.input = input as never;
      return { id: "appr_1", status: "pending", riskTier: "medium" };
    },
    getApproval: async () => {
      throw new Error("not used");
    },
  };
}

const audit = (calls: string[]) => ({ create: async () => void calls.push("audit") });

describe("finance tools registration", () => {
  const names = FINANCE_OPS_TOOLS.map((t) => t.name);
  it("are part of OPS_TOOLS (one registry)", () => {
    for (const n of names) assert.ok(OPS_TOOLS.some((t) => t.name === n), n);
    assert.deepEqual([...names].sort(), [
      "ops_accounting_report",
      "ops_convert_quote",
      "ops_draft_quote",
      "ops_draft_vendor_bill",
      "ops_post_journal_entry",
      "ops_record_payment",
      "ops_submit_expense_claim",
    ]);
  });
  it("every tool has a group; every write an automation action in the catalog", () => {
    for (const t of FINANCE_OPS_TOOLS) {
      assert.ok(TOOL_GROUP[t.name], `${t.name} group`);
      if (t.kind !== "safe") {
        assert.ok(TOOL_ACTION[t.name], `${t.name} action`);
        assert.ok(KNOWN_ACTIONS.some((a) => a.action === TOOL_ACTION[t.name]), `${t.name} in the automation catalog`);
      }
    }
    assert.equal(FINANCE_OPS_TOOLS.find((t) => t.name === "ops_accounting_report")!.kind, "safe");
  });
  it("money / posting tools are Tier 3 (never automated); drafts Tier 0; convert and submit Tier 2", () => {
    const tier = (n: string) => evaluateTier({ kind: TOOL_ACTION[n]!, description: `${n}: ${FINANCE_OPS_TOOLS.find((t) => t.name === n)!.description}` }, SETTINGS);
    assert.equal(tier("ops_record_payment"), 3);
    assert.equal(tier("ops_post_journal_entry"), 3);
    assert.equal(evaluateTier({ kind: "draft_quote" }, SETTINGS), 0);
    assert.equal(evaluateTier({ kind: "draft_vendor_bill" }, SETTINGS), 0);
    assert.equal(evaluateTier({ kind: "convert_quote" }, SETTINGS), 2);
    assert.equal(evaluateTier({ kind: "submit_expense_claim" }, SETTINGS), 2);
    assert.equal(KNOWN_ACTIONS.find((a) => a.action === "record_payment")?.tier, 3);
    assert.equal(KNOWN_ACTIONS.find((a) => a.action === "post_journal_entry")?.tier, 3);
  });
});

describe("propose-only money writes", () => {
  it("ops_record_payment proposes OPS_PAYMENT_RECORD_CHARGE and writes nothing", async () => {
    const calls: string[] = [];
    const seen: { input?: { toolName: string; args: Record<string, unknown> } } = {};
    const tx = { opsAuditEvent: audit(calls), opsPayment: { create: async () => calls.push("payment.create") } } as never;
    const r = await recordPaymentCore(tx, ACTOR, { invoiceId: "inv_1", amountCents: "2500" }, stubPort(seen));
    assert.equal(seen.input?.toolName, "OPS_PAYMENT_RECORD_CHARGE");
    assert.equal((seen.input?.args.mutation as Record<string, unknown>).invoiceId, "inv_1");
    assert.ok(!calls.includes("payment.create"));
    assert.equal((r.details as { approvalRequired: boolean }).approvalRequired, true);
  });

  it("ops_post_journal_entry resolves account codes and proposes OPS_JOURNAL_POST", async () => {
    const calls: string[] = [];
    const seen: { input?: { toolName: string; args: Record<string, unknown> } } = {};
    const tx = {
      opsAuditEvent: audit(calls),
      opsAccount: { findMany: async () => [{ id: "acc_cash", code: "1000" }, { id: "acc_eq", code: "3000" }] },
      opsJournalEntry: { createMany: async () => calls.push("journal.create") },
    } as never;
    const lines = JSON.stringify([
      { accountCode: "1000", debitCents: 50_000, creditCents: 0 },
      { accountCode: "3000", debitCents: 0, creditCents: 50_000 },
    ]);
    await postJournalEntryCore(tx, ACTOR, { lines, memo: "Owner contribution" }, stubPort(seen));
    assert.equal(seen.input?.toolName, "OPS_JOURNAL_POST");
    const mutation = seen.input?.args.mutation as { lines: Array<{ accountId: string }> };
    assert.deepEqual(mutation.lines.map((l) => l.accountId), ["acc_cash", "acc_eq"]);
    assert.ok(!calls.includes("journal.create"));
    await assert.rejects(postJournalEntryCore(tx, ACTOR, { lines: JSON.stringify([{ accountCode: "9999", debitCents: 1 }, { accountCode: "1000", creditCents: 1 }]) }, stubPort()), /unknown account 9999/);
  });
});

describe("drafts and reads", () => {
  it("ops_draft_quote creates a draft quote with server totals", async () => {
    const calls: string[] = [];
    const tx = {
      opsAuditEvent: audit(calls),
      opsQuote: {
        create: async (a: { data: Record<string, unknown> }) => {
          calls.push("quote.create");
          return { id: "quo_1", ...a.data };
        },
      },
    } as never;
    const r = await draftQuoteCore(tx, ACTOR, { lineItems: JSON.stringify([{ description: "Design", qty: 20, priceCents: 15_000 }]), taxCents: "3000" }, stubPort());
    assert.ok(calls.includes("quote.create"));
    assert.ok(calls.includes("audit"));
    assert.equal((r.details as { totalCents: number }).totalCents, 303_000);
    assert.match(r.summary, /needs a human approval/);
  });

  it("ops_accounting_report summarises the P&L", async () => {
    const tx = {
      opsAccount: {
        count: async () => 2,
        findMany: async () => [
          { id: "a_sales", code: "4000", name: "Sales", type: "income", parentId: null, systemKey: "sales", active: true },
          { id: "a_rent", code: "6100", name: "Rent", type: "expense", parentId: null, systemKey: "expense_rent", active: true },
        ],
      },
      opsJournalLine: {
        groupBy: async () => [
          { accountId: "a_sales", _sum: { debitCents: 0, creditCents: 100_000 } },
          { accountId: "a_rent", _sum: { debitCents: 30_000, creditCents: 0 } },
        ],
      },
    } as never;
    const r = await accountingReportCore(tx, ACTOR, { kind: "profit_and_loss", from: "2026-01-01", to: "2026-12-31" });
    assert.match(r.summary, /income \$1,000\.00, expenses \$300\.00, net \$700\.00/);
    await assert.rejects(accountingReportCore(tx, ACTOR, { kind: "cash_flow" }), /kind/);
  });
});
