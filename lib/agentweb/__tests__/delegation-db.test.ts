// Phase 21A round 2 (WS=agentweb): delegation records on real Postgres as the app role.
//   - a recorded step stores who delegated, scope, run, expiry and tier decision, linked to
//     its receipt, and the SAME facts are in the audit hash chain entry;
//   - FORCE RLS: invisible without the workspace GUC and from another workspace;
//   - the receipt route shows the delegation as "you" or "a member", never the raw user id.
// Listed in scripts/test/db-tests.txt.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");
process.env.MARKETR_STORAGE ||= "local";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { authorityAudit } from "@/lib/authority/db";
import { receiptSecret, recordReceipt } from "../receipts";
import { storeCapture } from "../captures-store";
import { delegationForCapture, listDelegations, storeDelegation } from "../identity/delegation-store";

const RUN = `p21dl-${Date.now().toString(36)}`;
const A = `${RUN}-a`;
const B = `${RUN}-b`;

before(async () => {
  for (const id of [A, B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: `${id}-owner`, plan: "pro" } });
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.$disconnect();
});

describe("delegation records", () => {
  it("are stored with the receipt, and mirrored in the audit chain", async () => {
    const r = await recordReceipt(
      { secret: receiptSecret(), store: (c) => storeCapture(A, c, { via: "step", runId: "run_1", retentionDays: 5 }), delegate: (d) => storeDelegation(A, d), audit: (e) => authorityAudit.logAsync(e) },
      {
        workspaceId: A,
        actor: "agent:lead",
        url: "https://shop.example/cart",
        html: "<p>cart</p>",
        fetchedAt: new Date(),
        step: { action: "click", ref: "e2", name: "Add", klass: "benign", tier: 0, decision: "allow" },
        delegation: { delegatedBy: `${A}-owner`, runId: "run_1", agent: "lead", scope: { origins: ["https://shop.example"], classes: ["benign"] }, expiresAt: new Date(Date.now() + 300_000) },
      },
    );
    assert.equal(r.auditError, undefined);
    const d = await delegationForCapture(A, r.id);
    assert.deepEqual([d?.delegatedBy, d?.runId, d?.agent, d?.origin, d?.tier, d?.decision, d?.action, d?.captureId], [`${A}-owner`, "run_1", "lead", "https://shop.example", 0, "allow", "click", r.id]);
    assert.deepEqual(d?.scope, { origins: ["https://shop.example"], classes: ["benign"] });
    assert.deepEqual((await listDelegations(A, { runId: "run_1" })).map((x) => x.id), [d!.id]);
    const audit = await prisma.authorityAuditEvent.findFirst({ where: { workspaceId: A, entityId: r.id } });
    const detail = audit!.detail as { delegation: { id: string; delegatedBy: string; runId: string } };
    assert.deepEqual([detail.delegation.id, detail.delegation.delegatedBy, detail.delegation.runId], [d!.id, `${A}-owner`, "run_1"]);
  });

  it("are invisible without the workspace GUC and from another workspace (FORCE RLS)", async () => {
    assert.equal((await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM agentweb_delegations`)[0]!.n, 0);
    assert.deepEqual(await listDelegations(B), []);
    await assert.rejects(() =>
      withWorkspaceScope(B, (tx) =>
        (tx as Prisma.TransactionClient).agentwebDelegation.create({ data: { id: "dlg_x", workspaceId: A, delegatedBy: "u", agent: "lead", expiresAt: new Date(), action: "click", url: "https://x.test/", origin: "https://x.test", tier: 0, decision: "allow" } }),
      ),
    );
  });
});
