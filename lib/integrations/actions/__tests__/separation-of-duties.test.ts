// ShapesOS — Phase 1 DB test: Composio approvals enforce separation of
// duties. The requester cannot approve their own action while another
// editor+ could; a solo workspace may self-approve (recorded in the audit
// trail); withdrawing (denying) your own request is always allowed.
// Run: npx tsx --test lib/integrations/actions/__tests__/separation-of-duties.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { decideApproval, proposeAction, SeparationOfDutiesError } from "../gate";

const TEAM = "p1b-sod-team";
const SOLO = "p1b-sod-solo";
const OWNER = "p1b-sod-owner";
const EDITOR = "p1b-sod-editor";
const SOLO_OWNER = "p1b-sod-solo-owner";

before(async () => {
  for (const id of [TEAM, SOLO]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: TEAM, name: TEAM, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: SOLO, name: SOLO, ownerUserId: SOLO_OWNER } });
  await prisma.workspaceMember.create({ data: { workspaceId: TEAM, userId: OWNER, role: "owner" } });
  await prisma.workspaceMember.create({ data: { workspaceId: TEAM, userId: EDITOR, role: "editor" } });
  await prisma.workspaceMember.create({ data: { workspaceId: SOLO, userId: SOLO_OWNER, role: "owner" } });
});

after(async () => {
  for (const id of [TEAM, SOLO]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

// composio_action_approvals is RLS-protected: read it inside the scope.
function readApproval(workspaceId: string, id: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionApproval.findFirst({ where: { id, workspaceId } }),
  );
}

async function propose(workspaceId: string, proposedBy: string) {
  const { approval } = await proposeAction({
    workspaceId,
    appKey: "slack",
    toolName: "SLACK_SEND_MESSAGE",
    args: { channel: "#general", text: "hi" },
    proposedBy,
  });
  return approval.id;
}

describe("Composio approvals: separation of duties", () => {
  it("the requester cannot approve their own action when another editor exists", async () => {
    const id = await propose(TEAM, EDITOR);
    await assert.rejects(
      () => decideApproval({ workspaceId: TEAM, approvalId: id, decision: "approved", decidedBy: EDITOR }),
      (e: unknown) => e instanceof SeparationOfDutiesError,
    );
    const row = await readApproval(TEAM, id);
    assert.equal(row?.status, "pending");
  });

  it("a different editor+ can approve it", async () => {
    const id = await propose(TEAM, EDITOR);
    const res = await decideApproval({ workspaceId: TEAM, approvalId: id, decision: "approved", decidedBy: OWNER });
    assert.equal(res.status, "approved");
  });

  it("the requester may withdraw (deny) their own request", async () => {
    const id = await propose(TEAM, EDITOR);
    const res = await decideApproval({ workspaceId: TEAM, approvalId: id, decision: "denied", decidedBy: EDITOR });
    assert.equal(res.status, "denied");
  });

  it("a solo workspace may self-approve, and the audit trail says so", async () => {
    const id = await propose(SOLO, SOLO_OWNER);
    const res = await decideApproval({ workspaceId: SOLO, approvalId: id, decision: "approved", decidedBy: SOLO_OWNER });
    assert.equal(res.status, "approved");
    const row = await readApproval(SOLO, id);
    const trail = row?.auditTrail as Array<{ event: string; detail?: string }>;
    assert.match(trail.at(-1)?.detail ?? "", /self-approved/);
  });
});
