// ShapesOS — Phase 10 (finance): the ledger on real Postgres, run as the
// least-privilege app role (FORCE RLS applies).
//   - the DATABASE enforces double entry: unbalanced / one-line / two-sided
//     entries fail at commit; UPDATE and DELETE are rejected (append-only)
//   - posting is idempotent per source, also under concurrency
//   - manual entries and reversals go through the approval gate
//   - RLS isolates every finance table; deleting a workspace still cascades
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/ops/__tests__/accounting-db.test.ts

import "dotenv/config";
import { STANDARD_CHART } from "../accounting/chart";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { opsCreate, type OpsActor } from "../doctype";
import { OpsGateError, opsBindingFor, phase14GatePort } from "../gate";
import {
  ensureChartOfAccounts,
  listJournal,
  postEntry,
  resolveSystemAccounts,
  reverseEntry,
  runReport,
  type TrialBalance,
} from "../accounting";

const WS_A = "p10fin-acct-a";
const WS_B = "p10fin-acct-b";
const ACTOR: OpsActor = { workspaceId: WS_A, userId: "user_p10fin" };
const JOURNAL = OPS_ENTITY_MAP["journal-entries"]!;

async function createWorkspace(id: string) {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
}

async function approvedApproval(ws: string, slug: string, binding: Parameters<typeof opsBindingFor>[0]): Promise<string> {
  const row = await withWorkspaceScope(ws, (tx) =>
    tx.composioActionApproval.create({
      data: {
        workspaceId: ws,
        appKey: "ops",
        toolName: slug,
        riskTier: "medium",
        proposedArgs: opsBindingFor(binding) as object,
        plainSummary: "test",
        status: "approved",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    }),
  );
  return row.id;
}

async function accountIds(ws: string) {
  return withWorkspaceScope(ws, async (tx) => {
    const m = await resolveSystemAccounts(tx, ws, ["cash", "sales", "ar"]);
    return { cash: m.get("cash")!, sales: m.get("sales")!, ar: m.get("ar")! };
  });
}

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await createWorkspace(id);
  }
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("chart of accounts", () => {
  it("seeds the standard chart once, even when first use races", async () => {
    await Promise.all(Array.from({ length: 4 }, () => withWorkspaceScope(WS_A, (tx) => ensureChartOfAccounts(tx, WS_A))));
    const n = await withWorkspaceScope(WS_A, (tx) => tx.opsAccount.count({ where: { workspaceId: WS_A } }));
    // 25 standard accounts + Phase 12 (mfgpos): card clearing, finished goods,
    // work in progress, labour absorbed, scrap, cash over/short + Phase 12
    // (people): 6 payroll accounts.
    assert.equal(n, STANDARD_CHART.length);
    assert.equal(n, 37);
  });
});

describe("the database enforces double entry", () => {
  it("rejects an unbalanced entry at commit", async () => {
    const a = await accountIds(WS_A);
    await assert.rejects(
      withWorkspaceScope(WS_A, async (tx) => {
        await tx.opsJournalEntry.create({
          data: { id: "je_unbal", workspaceId: WS_A, entryDate: new Date(), totalCents: 100, createdBy: "t" },
        });
        await tx.opsJournalLine.createMany({
          data: [
            { workspaceId: WS_A, entryId: "je_unbal", accountId: a.cash, entryDate: new Date(), debitCents: 100 },
            { workspaceId: WS_A, entryId: "je_unbal", accountId: a.sales, entryDate: new Date(), creditCents: 99 },
          ],
        });
      }),
      /not balanced/,
    );
    const left = await withWorkspaceScope(WS_A, (tx) => tx.opsJournalEntry.count({ where: { id: "je_unbal" } }));
    assert.equal(left, 0, "the unbalanced entry must not survive");
  });

  it("rejects a one-line entry and an entry with no lines", async () => {
    const a = await accountIds(WS_A);
    await assert.rejects(
      withWorkspaceScope(WS_A, async (tx) => {
        await tx.opsJournalEntry.create({ data: { id: "je_one", workspaceId: WS_A, entryDate: new Date(), totalCents: 100, createdBy: "t" } });
        await tx.opsJournalLine.create({
          data: { workspaceId: WS_A, entryId: "je_one", accountId: a.cash, entryDate: new Date(), debitCents: 100 },
        });
      }),
      /not balanced/,
    );
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        tx.opsJournalEntry.create({ data: { id: "je_none", workspaceId: WS_A, entryDate: new Date(), totalCents: 100, createdBy: "t" } }),
      ),
      /not balanced/,
    );
  });

  it("rejects a line with both or neither side set (CHECK)", async () => {
    const a = await accountIds(WS_A);
    await assert.rejects(
      withWorkspaceScope(WS_A, async (tx) => {
        await tx.opsJournalEntry.create({ data: { id: "je_two", workspaceId: WS_A, entryDate: new Date(), totalCents: 100, createdBy: "t" } });
        await tx.opsJournalLine.createMany({
          data: [
            { workspaceId: WS_A, entryId: "je_two", accountId: a.cash, entryDate: new Date(), debitCents: 100, creditCents: 100 },
            { workspaceId: WS_A, entryId: "je_two", accountId: a.sales, entryDate: new Date(), debitCents: 0, creditCents: 0 },
          ],
        });
      }),
      /one_side_chk|check constraint/i,
    );
  });

  it("is append-only: UPDATE and DELETE of entries and lines are rejected", async () => {
    const { entry } = await withWorkspaceScope(WS_A, (tx) =>
      postEntry(tx, ACTOR, {
        sourceType: "manual",
        lines: [
          { account: { key: "cash" }, debitCents: 1_000, creditCents: 0 },
          { account: { key: "owner_equity" }, debitCents: 0, creditCents: 1_000 },
        ],
      }),
    );
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) => tx.opsJournalEntry.update({ where: { id: entry.id }, data: { memo: "edited" } })),
      /append-only/,
    );
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) => tx.opsJournalLine.updateMany({ where: { entryId: entry.id }, data: { debitCents: 5 } })),
      /append-only/,
    );
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) => tx.opsJournalLine.deleteMany({ where: { entryId: entry.id } })),
      /append-only/,
    );
    await assert.rejects(withWorkspaceScope(WS_A, (tx) => tx.opsJournalEntry.delete({ where: { id: entry.id } })), /append-only/);
  });
});

describe("posting idempotency", () => {
  const lines = [
    { account: { key: "ar" as const }, debitCents: 2_000, creditCents: 0 },
    { account: { key: "sales" as const }, debitCents: 0, creditCents: 2_000 },
  ];

  it("re-posting the same source is a no-op that returns the original", async () => {
    const first = await withWorkspaceScope(WS_A, (tx) => postEntry(tx, ACTOR, { sourceType: "invoice", sourceKey: "invoice:idem:issue", lines }));
    const again = await withWorkspaceScope(WS_A, (tx) => postEntry(tx, ACTOR, { sourceType: "invoice", sourceKey: "invoice:idem:issue", lines }));
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.entry.id, first.entry.id);
  });

  it("four concurrent posts of one source land exactly one entry", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        withWorkspaceScope(WS_A, (tx) => postEntry(tx, ACTOR, { sourceType: "invoice", sourceKey: "invoice:race:issue", lines })),
      ),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.entry.id)).size, 1);
    const n = await withWorkspaceScope(WS_A, (tx) => tx.opsJournalEntry.count({ where: { workspaceId: WS_A, sourceKey: "invoice:race:issue" } }));
    assert.equal(n, 1);
  });
});

describe("manual entries and reversals go through the gate", () => {
  it("a manual entry without approval only proposes; with an approval it posts once", async () => {
    const a = await accountIds(WS_A);
    const body = {
      memo: "Owner loan",
      lines: [
        { accountId: a.cash, debitCents: 50_000, creditCents: 0 },
        { accountId: a.ar, debitCents: 0, creditCents: 50_000 },
      ],
    };
    const proposed = await withWorkspaceScope(WS_A, (tx) => opsCreate(tx, JOURNAL, ACTOR, body, { gatePort: { ...phase14GatePort, propose: async () => ({ id: "appr_x", status: "pending", riskTier: "medium" }) } }));
    assert.equal(proposed.outcome, "approval_required");

    const parsed = JOURNAL.createSchema.parse(body) as Record<string, unknown>;
    const approvalId = await approvedApproval(WS_A, "OPS_JOURNAL_POST", { entity: "journal-entries", slug: "OPS_JOURNAL_POST", mutation: { ...parsed } });
    const done = await withWorkspaceScope(WS_A, (tx) => opsCreate(tx, JOURNAL, ACTOR, { ...body, approvalId }, { gatePort: phase14GatePort }));
    assert.equal(done.outcome, "done");
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) => opsCreate(tx, JOURNAL, ACTOR, { ...body, approvalId }, { gatePort: phase14GatePort })),
      (e: unknown) => e instanceof OpsGateError && /replay/.test(e.code),
    );
    // A different mutation under the same kind of approval is refused.
    const other = await approvedApproval(WS_A, "OPS_JOURNAL_POST", { entity: "journal-entries", slug: "OPS_JOURNAL_POST", mutation: { ...parsed } });
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        opsCreate(tx, JOURNAL, ACTOR, { ...body, lines: body.lines.map((l) => ({ ...l, debitCents: l.debitCents * 10, creditCents: l.creditCents * 10 })), approvalId: other }, { gatePort: phase14GatePort }),
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
    );
  });

  it("a reversal mirrors the entry once and nets the accounts to zero", async () => {
    const { entry } = await withWorkspaceScope(WS_A, (tx) =>
      postEntry(tx, ACTOR, {
        sourceType: "manual",
        sourceKey: "manual:rev-test",
        lines: [
          { account: { key: "expense_rent" }, debitCents: 7_000, creditCents: 0 },
          { account: { key: "ap" }, debitCents: 0, creditCents: 7_000 },
        ],
      }),
    );
    const rev = await withWorkspaceScope(WS_A, (tx) => reverseEntry(tx, ACTOR, entry.id));
    assert.equal(rev.created, true);
    assert.equal(rev.entry.reversalOfId, entry.id);
    const again = await withWorkspaceScope(WS_A, (tx) => reverseEntry(tx, ACTOR, entry.id));
    assert.equal(again.created, false);
    assert.equal(again.entry.id, rev.entry.id);
    await assert.rejects(withWorkspaceScope(WS_A, (tx) => reverseEntry(tx, ACTOR, rev.entry.id)), /can't itself be reversed/);
    const listed = await withWorkspaceScope(WS_A, (tx) => listJournal(tx, WS_A, { sourceType: "reversal" }));
    assert.ok(listed.some((e) => e.id === rev.entry.id));
  });

  it("the trial balance over everything posted stays balanced", async () => {
    const tb = (await withWorkspaceScope(WS_A, (tx) => runReport(tx, WS_A, "trial_balance", {}))) as TrialBalance;
    assert.equal(tb.balanced, true);
    assert.ok(tb.totalDebitCents > 0);
  });
});

describe("RLS isolation for the finance tables", () => {
  it("workspace B sees none of A's accounts or entries, and cannot post to A", async () => {
    const seen = await withWorkspaceScope(WS_B, async (tx) => ({
      accounts: await tx.opsAccount.count({ where: { workspaceId: WS_A } }),
      entries: await tx.opsJournalEntry.count({ where: { workspaceId: WS_A } }),
      lines: await tx.opsJournalLine.count({ where: { workspaceId: WS_A } }),
    }));
    assert.deepEqual(seen, { accounts: 0, entries: 0, lines: 0 });
    await assert.rejects(
      withWorkspaceScope(WS_B, (tx) => tx.opsAccount.create({ data: { workspaceId: WS_A, code: "9999", name: "x", type: "asset" } })),
    );
  });

  it("every finance table is invisible without the GUC (fail-closed)", async () => {
    for (const t of [
      "ops_accounts",
      "ops_journal_entries",
      "ops_journal_lines",
      "ops_tax_rates",
      "ops_number_sequences",
      "ops_finance_settings",
      "ops_recurring_invoices",
      "ops_quotes",
      "ops_vendors",
      "ops_purchase_receipts",
      "ops_vendor_bills",
      "ops_expense_claims",
      "ops_expense_lines",
    ]) {
      assert.equal(await countWithoutScope(t), 0, `${t}: unscoped count must be 0`);
    }
  });

  it("deleting a workspace still cascades through the append-only ledger", async () => {
    const tmp = "p10fin-acct-tmp";
    await createWorkspace(tmp);
    await withWorkspaceScope(tmp, (tx) =>
      postEntry(tx, { workspaceId: tmp, userId: "u" }, {
        sourceType: "manual",
        lines: [
          { account: { key: "cash" }, debitCents: 1, creditCents: 0 },
          { account: { key: "owner_equity" }, debitCents: 0, creditCents: 1 },
        ],
      }),
    );
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${tmp}`;
    const n = await withWorkspaceScope(tmp, (tx) => tx.opsJournalEntry.count({ where: { workspaceId: tmp } }));
    assert.equal(n, 0);
  });
});
