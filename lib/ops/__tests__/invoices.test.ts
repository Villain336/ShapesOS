// Marketr — Phase 17 slice 2 tests: invoicing lifecycle, gate-on-send,
// overdue sweep, payment reminders, server-computed totals, invoice RLS.
// Run: npx tsx --test lib/ops/__tests__/invoices.test.ts
// RLS block also needs: OPS_SCRATCH=1 DATABASE_URL=<ops_slice1_scratch url>

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { approvalClaimDelegate } from "./approval-claims";

import { OPS_ENTITY_MAP } from "../entities";
import {
  OpsError,
  opsCreate,
  opsPatch,
  type OpsActor,
} from "../doctype";
import {
  OpsGateError,
  assertPhase14TierMeetsPin,
  opsBindingFor,
  type OpsGatePort,
} from "../gate";
import {
  executeInvoiceReminder,
  markOverdueInvoices,
  proposeInvoiceReminder,
} from "../invoices";
import { NotFoundError } from "@/lib/api/errors";

const ACTOR: OpsActor = { workspaceId: "ws_inv2", userId: "user_inv2" };
const INVOICES = OPS_ENTITY_MAP["invoices"];

const DRAFT_ROW = {
  id: "inv_1",
  workspaceId: ACTOR.workspaceId,
  customerId: "lead_1",
  status: "draft",
  totalCents: 5500,
  taxCents: 500,
  lineItems: [{ description: "Retainer", qty: 1, priceCents: 5000 }],
  sentAt: null,
  dueAt: null,
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

function approvedSendPort(): OpsGatePort {
  return portWith({
    status: "approved",
    proposedArgs: opsBindingFor({
      entity: "invoices",
      entityId: "inv_1",
      slug: "OPS_INVOICE_SEND",
      mutation: { id: "inv_1", status: "sent" },
    }),
  });
}

/** Proxy stub tx: generic delegates + audit capture + update spy. */
function makeStubTx(existing: Record<string, unknown>, opts: { createdId?: string } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let updated = 0;
  const claims = approvalClaimDelegate();
  // Mutable copy: guarded writes (updateMany) land here and findFirst
  // re-reads them, the way the database would.
  const state: Record<string, unknown> = { ...existing };
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
        if (prop === "lead") {
          return {
            findMany: async () => [{ id: "lead_1", name: "Acme Co", company: "Acme" }],
          };
        }
        return {
          findFirst: async () => ({ ...state }),
          findMany: async () => [{ ...state }],
          create: async (a: { data: Record<string, unknown> }) => {
            const row = { ...a.data, id: opts.createdId ?? "inv_new" };
            created.push(row);
            return row;
          },
          updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            if (!Object.entries(args.where).every(([k, v]) => state[k] === v)) return { count: 0 };
            updated += 1;
            Object.assign(state, args.data);
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
  return {
    tx: tx as unknown as Prisma.TransactionClient,
    created,
    audits,
    updated: () => updated,
  };
}

describe("invoice lifecycle: draft → gate → send", () => {
  it("create is a free draft write with server-computed totals", async () => {
    const { tx, created } = makeStubTx(DRAFT_ROW);
    const res = await opsCreate(
      tx,
      INVOICES,
      ACTOR,
      {
        customerId: "lead_1",
        lineItems: [
          { description: "Retainer", qty: 2, priceCents: 2500 },
          { description: "Setup", qty: 1, priceCents: 1000 },
        ],
        taxCents: 500,
        // A hostile client cannot set totals — the schema strips them.
        totalCents: 999_999_999,
      },
      { gatePort: portWith(null) },
    );
    assert.equal(res.outcome, "done");
    assert.equal(created.length, 1);
    const data = created[0]!;
    assert.equal(data["status"], "draft");
    assert.equal(data["totalCents"], 2 * 2500 + 1000 + 500);
  });

  it("PATCH status=sent without approval proposes (202-style), never executes", async () => {
    const { tx, updated, audits } = makeStubTx(DRAFT_ROW);
    const res = await opsPatch(
      tx,
      INVOICES,
      ACTOR,
      { id: "inv_1", status: "sent" },
      { gatePort: portWith(null) },
    );
    assert.equal(res.outcome, "approval_required");
    if (res.outcome === "approval_required") {
      assert.equal(res.classification.slug, "OPS_INVOICE_SEND");
      assert.equal(res.approval.id, "ap_1");
    }
    assert.equal(updated(), 0, "the send must not execute without approval");
    assert.ok(audits.some((a) => a["action"] === "gate_proposed"));
  });

  it("PATCH status=sent with an approved approval executes: sent + sentAt + net-30 dueAt", async () => {
    const { tx, updated } = makeStubTx(DRAFT_ROW);
    const before = Date.now();
    const res = await opsPatch(
      tx,
      INVOICES,
      ACTOR,
      { id: "inv_1", status: "sent", approvalId: "ap_1" },
      { gatePort: approvedSendPort() },
    );
    assert.equal(res.outcome, "done");
    assert.equal(updated(), 1);
    if (res.outcome === "done") {
      const row = res.row as Record<string, unknown>;
      assert.equal(row["status"], "sent");
      const sentAt = (row["sentAt"] as Date).getTime();
      const dueAt = (row["dueAt"] as Date).getTime();
      assert.ok(Math.abs(sentAt - before) < 60_000, "sentAt is now");
      assert.ok(
        Math.abs(dueAt - sentAt - 30 * 24 * 3600_000) < 60_000,
        "dueAt defaults to sentAt + 30 days",
      );
    }
  });

  it("explicit dueAt survives the send (not overwritten by net-30)", async () => {
    const explicit = new Date("2026-12-25T00:00:00Z");
    const { tx } = makeStubTx({ ...DRAFT_ROW, dueAt: explicit });
    const res = await opsPatch(
      tx,
      INVOICES,
      ACTOR,
      { id: "inv_1", status: "sent", approvalId: "ap_1" },
      { gatePort: approvedSendPort() },
    );
    assert.equal(res.outcome, "done");
    if (res.outcome === "done") {
      assert.equal((res.row as Record<string, unknown>)["dueAt"], explicit);
    }
  });

  it("create with explicit dueAt stores it; invalid dueAt → 400", async () => {
    const { tx, created } = makeStubTx(DRAFT_ROW);
    await opsCreate(
      tx,
      INVOICES,
      ACTOR,
      {
        lineItems: [{ description: "X", qty: 1, priceCents: 100 }],
        dueAt: "2026-11-01T00:00:00Z",
      },
      { gatePort: portWith(null) },
    );
    assert.equal(
      (created[0]!["dueAt"] as Date).toISOString(),
      "2026-11-01T00:00:00.000Z",
    );

    await assert.rejects(
      opsCreate(
        tx,
        INVOICES,
        ACTOR,
        { lineItems: [{ description: "X", qty: 1, priceCents: 100 }], dueAt: "not-a-date" },
        { gatePort: portWith(null) },
      ),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
  });
});

describe("invoice gate-bypass negatives", () => {
  it("denied / expired / replayed / mismatched approvals all fail closed", async () => {
    const cases: Array<{ name: string; port: OpsGatePort; code: string }> = [
      {
        name: "denied",
        port: portWith({
          status: "denied",
          proposedArgs: opsBindingFor({
            entity: "invoices", entityId: "inv_1", slug: "OPS_INVOICE_SEND",
            mutation: { id: "inv_1", status: "sent" },
          }),
        }),
        code: "approval_not_approved",
      },
      {
        name: "expired",
        port: portWith({
          status: "approved",
          expiresAt: new Date(Date.now() - 1000),
          proposedArgs: opsBindingFor({
            entity: "invoices", entityId: "inv_1", slug: "OPS_INVOICE_SEND",
            mutation: { id: "inv_1", status: "sent" },
          }),
        }),
        code: "approval_expired",
      },
      {
        name: "replayed",
        port: portWith({
          status: "executed",
          proposedArgs: opsBindingFor({
            entity: "invoices", entityId: "inv_1", slug: "OPS_INVOICE_SEND",
            mutation: { id: "inv_1", status: "sent" },
          }),
        }),
        code: "approval_replayed",
      },
      {
        name: "binding mismatch (approved for paid, executing send)",
        port: portWith({
          status: "approved",
          proposedArgs: opsBindingFor({
            entity: "invoices", entityId: "inv_1", slug: "OPS_INVOICE_MARK_PAID",
            mutation: { id: "inv_1", status: "paid" },
          }),
        }),
        code: "binding_mismatch",
      },
    ];
    for (const c of cases) {
      const { tx, updated } = makeStubTx(DRAFT_ROW);
      await assert.rejects(
        opsPatch(tx, INVOICES, ACTOR, { id: "inv_1", status: "sent", approvalId: "ap_1" }, { gatePort: c.port }),
        (e: unknown) => e instanceof OpsGateError && e.code === c.code,
        c.name,
      );
      assert.equal(updated(), 0, `${c.name}: mutation must not run`);
    }
  });

  it("OPS_INVOICE_REMIND is pinned and the Phase 14 derivation meets the pin", () => {
    const pins = assertPhase14TierMeetsPin();
    const remind = pins.find((p) => p.slug === "OPS_INVOICE_REMIND");
    assert.ok(remind, "OPS_INVOICE_REMIND is in the money-action catalog");
    assert.equal(remind.expected, "medium");
  });
});

describe("overdue sweep", () => {
  function sweepTx(rows: Array<Record<string, unknown>>) {
    const updated: string[] = [];
    const audits: Array<Record<string, unknown>> = [];
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
          return {
            // Honors the sweep's where clause the way Prisma would:
            // status = "sent" AND dueAt < now.
            findMany: async (args: { where?: { status?: string; dueAt?: { lt?: Date } } }) => {
              const where = args?.where ?? {};
              return rows
                .filter((r) => {
                  if (where.status && r["status"] !== where.status) return false;
                  const lt = where.dueAt?.lt;
                  if (lt && !(r["dueAt"] && new Date(String(r["dueAt"])).getTime() < lt.getTime())) {
                    return false;
                  }
                  return true;
                })
                .map((r) => ({ ...r }));
            },
            // Guarded like Prisma: only rows still matching the where move.
            updateMany: async (args: { where: { id: string; status?: string } }) => {
              const row = rows.find((r) => r["id"] === args.where.id);
              if (!row || (args.where.status && row["status"] !== args.where.status)) return { count: 0 };
              row["status"] = "overdue";
              updated.push(args.where.id);
              return { count: 1 };
            },
          };
        },
      },
    );
    return { tx: tx as unknown as Prisma.TransactionClient, updated, audits };
  }

  it("flips only sent invoices past their due date", async () => {
    const past = new Date(Date.now() - 24 * 3600_000).toISOString();
    const future = new Date(Date.now() + 24 * 3600_000).toISOString();
    const { tx, updated, audits } = sweepTx([
      { id: "past-due", status: "sent", dueAt: past, totalCents: 1000 },
      { id: "not-yet", status: "sent", dueAt: future, totalCents: 2000 },
      { id: "draft-past", status: "draft", dueAt: past, totalCents: 3000 },
      { id: "paid-past", status: "paid", dueAt: past, totalCents: 4000 },
      { id: "no-due", status: "sent", dueAt: null, totalCents: 5000 },
    ]);
    const res = await markOverdueInvoices(tx, ACTOR);
    assert.deepEqual(res.ids, ["past-due"]);
    assert.equal(res.swept, 1);
    assert.deepEqual(updated, ["past-due"]);
    assert.ok(audits.some((a) => a["action"] === "overdue_sweep" && a["entityId"] === "past-due"));
  });
});

describe("payment reminders (gated money comms)", () => {
  const SENT_ROW = { ...DRAFT_ROW, status: "sent", sentAt: new Date().toISOString() };

  it("reminding a draft invoice → 422 (only sent/overdue)", async () => {
    const { tx } = makeStubTx(DRAFT_ROW);
    await assert.rejects(
      proposeInvoiceReminder(tx, ACTOR, "inv_1", "Please pay.", { gatePort: portWith(null) }),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
  });

  it("propose without approval → approval_required (OPS_INVOICE_REMIND)", async () => {
    const { tx, audits } = makeStubTx(SENT_ROW);
    const res = await proposeInvoiceReminder(tx, ACTOR, "inv_1", "Please pay soon.", {
      gatePort: portWith(null),
    });
    assert.equal(res.outcome, "approval_required");
    if (res.outcome === "approval_required") assert.equal(res.approval.id, "ap_1");
    assert.ok(audits.some((a) => a["action"] === "gate_proposed"));
  });

  it("execute with approved approval records the dispatch; wrong text → binding mismatch", async () => {
    const text = "Please pay soon.";
    const port = portWith({
      status: "approved",
      // The binding the propose path would have created.
      proposedArgs: opsBindingFor({
        entity: "invoices",
        entityId: "inv_1",
        slug: "OPS_INVOICE_REMIND",
        mutation: { id: "inv_1", reminderText: text },
      }),
    });
    const { tx, audits } = makeStubTx(SENT_ROW);
    const res = await executeInvoiceReminder(tx, ACTOR, "inv_1", text, "ap_1", { gatePort: port });
    assert.equal(res.outcome, "done");
    assert.ok(
      audits.some((a) => a["action"] === "reminder_sent" && String(a["summary"]).includes("ap_1")),
      "dispatch recorded in the audit trail",
    );

    const { tx: tx2 } = makeStubTx(SENT_ROW);
    await assert.rejects(
      executeInvoiceReminder(tx2, ACTOR, "inv_1", "A DIFFERENT text.", "ap_1", { gatePort: port }),
      (e: unknown) => e instanceof OpsGateError && (e as OpsGateError).code === "binding_mismatch",
    );
  });

  it("execute without approvalId → approval_required (fail-closed)", async () => {
    const { tx } = makeStubTx(SENT_ROW);
    await assert.rejects(
      executeInvoiceReminder(tx, ACTOR, "inv_1", "Please pay.", undefined, { gatePort: portWith(null) }),
      (e: unknown) => e instanceof OpsGateError && (e as OpsGateError).code === "approval_required",
    );
  });
});

// ---------------------------------------------------------------------------
// RLS integration on the scratch DB (gated on OPS_SCRATCH=1 so the default
// suite never touches a live database).
// ---------------------------------------------------------------------------

const RUN_RLS = process.env.OPS_SCRATCH === "1";

(RUN_RLS ? describe : describe.skip)("invoice RLS isolation (scratch DB)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let withWorkspaceScope: typeof import("@/lib/substrate/memory/rls").withWorkspaceScope;
  const WS_A = "17s2-ws-a";
  const WS_B = "17s2-ws-b";

  before(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ withWorkspaceScope } = await import("@/lib/substrate/memory/rls"));
    for (const id of [WS_A, WS_B]) {
      await prisma.$executeRawUnsafe(`INSERT INTO workspaces (id) VALUES ('${id}') ON CONFLICT DO NOTHING`);
    }
  });

  after(async () => {
    for (const id of [WS_A, WS_B]) {
      await prisma.$executeRawUnsafe(`DELETE FROM workspaces WHERE id = '${id}'`);
    }
    await prisma.$disconnect();
  });

  it("workspace B cannot see or touch workspace A's invoices", async () => {
    const created = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsInvoice.create({
        data: {
          workspaceId: WS_A,
          lineItems: [{ description: "Retainer", qty: 1, priceCents: 5000 }],
          taxCents: 0,
          totalCents: 5000,
          status: "draft",
        },
      }),
    );
    const seenB = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsInvoice.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.equal(seenB.length, 0, "B must not see A's invoices");
    const cross = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsInvoice.findFirst({ where: { id: created.id, workspaceId: WS_B } }),
    );
    assert.equal(cross, null, "cross-workspace invoice resolves to 404-shape null");
  });
});
