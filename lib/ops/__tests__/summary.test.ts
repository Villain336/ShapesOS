// Marketr — Phase 17 slice 7: ops summary service tests.
// Run: npx tsx --test lib/ops/__tests__/summary.test.ts
//
// getOpsSummary is tx-based (no prisma import): stub delegates only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getOpsSummary } from "../summary";

function stubTx() {
  const whereSeen: Array<{ delegate: string; where: unknown }> = [];
  return {
    whereSeen,
    opsInvoice: {
      count: async (args: { where: { workspaceId: string; status: unknown } }) => {
        whereSeen.push({ delegate: "opsInvoice.count", where: args.where });
        return args.where.status === "overdue" ? 2 : 5;
      },
    },
    opsProduct: {
      findMany: async (args: { where: { workspaceId: string } }) => {
        whereSeen.push({ delegate: "opsProduct.findMany", where: args.where });
        return [
          { stockQty: 3, lowStockThreshold: 10, trackInventory: true }, // low
          { stockQty: 10, lowStockThreshold: 10, trackInventory: true }, // low (<=)
          { stockQty: 50, lowStockThreshold: 10, trackInventory: true }, // ok
          { stockQty: 0, lowStockThreshold: 5, trackInventory: false }, // untracked — skip
        ];
      },
    },
    composioActionApproval: {
      count: async (args: { where: { workspaceId: string; appKey: string; status: string } }) => {
        whereSeen.push({ delegate: "composioActionApproval.count", where: args.where });
        return 7;
      },
    },
  };
}

describe("getOpsSummary", () => {
  it("returns the four operations counts", async () => {
    const tx = stubTx();
    const s = await getOpsSummary(tx, "ws_1");
    assert.deepEqual(s, {
      openInvoices: 5,
      overdueInvoices: 2,
      lowStockCount: 2,
      pendingOpsApprovals: 7,
    });
  });

  it("scopes every count to the workspace", async () => {
    const tx = stubTx();
    await getOpsSummary(tx, "ws_9");
    for (const seen of tx.whereSeen) {
      assert.equal((seen.where as { workspaceId: string }).workspaceId, "ws_9", seen.delegate);
    }
  });

  it("counts pending ops approvals via appKey 'ops' + status 'pending'", async () => {
    const tx = stubTx();
    await getOpsSummary(tx, "ws_1");
    const seen = tx.whereSeen.find((w) => w.delegate === "composioActionApproval.count");
    assert.ok(seen, "expected an approvals count query");
    assert.deepEqual(seen!.where, { workspaceId: "ws_1", appKey: "ops", status: "pending" });
  });

  it("counts low-stock as trackInventory && stockQty <= lowStockThreshold", async () => {
    const tx = stubTx();
    const s = await getOpsSummary(tx, "ws_1");
    // 3 <= 10 and 10 <= 10 are low; 50 > 10 is fine; untracked is skipped.
    assert.equal(s.lowStockCount, 2);
  });
});
