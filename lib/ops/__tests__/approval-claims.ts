// Shared by the ops stub-tx suites: an in-memory composio_action_approvals
// delegate for consumeOpsApproval (lib/ops/gate.ts). The consume code under
// test is the real one; this models only the database's guarded UPDATE —
// `status = 'approved'` matches once per id, after which the row is
// "executed" and every further claim matches 0 rows. The real Postgres path
// (row locks + concurrent claims) is covered by ops-consume-db.test.ts.

export function approvalClaimDelegate() {
  const executed = new Set<string>();
  return {
    executed,
    updateMany: async (a: { where: { id: string; status?: string }; data?: Record<string, unknown> }) => {
      if (a.where.status !== "approved" || executed.has(a.where.id)) return { count: 0 };
      executed.add(a.where.id);
      return { count: 1 };
    },
  };
}
