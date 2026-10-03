// ShapesOS — Phase 4a follow-up DB test: "approval decided" notifications for
// the queues that only emitted "needs approval" — scheduler runs, CAD design
// proposals, direct mail and media buys. The requester is told the outcome;
// the decider is never notified about their own decision; the decision
// itself never fails because of the notification.
// Run: DATABASE_URL=… npx tsx --test lib/notifications/__tests__/decided-producers-db.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { approveRun, rejectRun } from "@/lib/scheduler/service";
import { PrismaCadAiStore } from "@/lib/cad/ai-store";
import { decideApproval as decideMailApproval } from "@/lib/mail/service";
import { mediaDecisionOf, notifyMediaApprovalDecided } from "@/lib/media/decision-notify";
import type { MediaApproval } from "@/lib/media/approvals";

const RUN = Date.now().toString(36);
const WS = `p4fix-decided-${RUN}`;
const OWNER = `p4fix-decided-owner-${RUN}`;
const EDITOR = `p4fix-decided-editor-${RUN}`;

async function decided(sourceType: string, sourceId: string) {
  return prisma.notification.findMany({
    where: { workspaceId: WS, kind: "approval_decided", sourceType, sourceId },
    select: { userId: true, title: true, href: true },
  });
}

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: EDITOR, role: "editor" },
    ],
  });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } }).catch(() => {});
  await prisma.$disconnect();
});

describe("decided notifications (scheduler, CAD, mail, media)", () => {
  it("scheduler: approving / rejecting a supervised run notifies the schedule's creator", async () => {
    const skill = await prisma.skill.create({
      data: {
        workspaceId: WS,
        name: "Weekly digest",
        slug: `p4fix-digest-${RUN}`,
        description: "d",
        source: "upload",
        skillMd: "# test",
        declaredTools: [],
        trustTier: "built_in",
      },
    });
    const schedule = await prisma.scheduledSkill.create({
      data: { workspaceId: WS, skillId: skill.id, triggerType: "cron", cronExpr: "0 9 * * 1", createdBy: EDITOR, approvalMode: "supervised" },
    });
    const mkRun = () =>
      prisma.skillRun.create({
        data: { scheduleId: schedule.id, workspaceId: WS, skillId: skill.id, trigger: "cron", status: "awaiting_approval" },
      });

    const rejected = await mkRun();
    await rejectRun(prisma, rejected.id, WS, OWNER);
    const r = await decided("scheduler", rejected.id);
    assert.deepEqual(r.map((n) => n.userId), [EDITOR]);
    assert.equal(r[0]!.title, "Scheduled run denied");

    const approved = await mkRun();
    // Execution after the decision may block/fail in a bare test workspace;
    // the notification is emitted as soon as the approval lands.
    await approveRun(prisma, approved.id, WS, OWNER).catch(() => {});
    const a = await decided("scheduler", approved.id);
    assert.deepEqual(a.map((n) => n.userId), [EDITOR]);
    assert.equal(a[0]!.title, "Scheduled run approved");
    assert.equal((await prisma.skillRun.findUniqueOrThrow({ where: { id: approved.id } })).approvedBy, OWNER);
  });

  it("CAD: approving / rejecting a design proposal notifies the requester", async () => {
    const store = new PrismaCadAiStore(prisma);
    const project = await store.createProject(WS, EDITOR, { name: "airframe" });
    const stl = Buffer.from(
      "solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid part\n",
    );
    const { model, version } = await store.createModelWithVersion(WS, EDITOR, project.id, { name: "part" }, { fileName: "part.stl", fileBytes: stl });
    const { proposal: p1 } = await store.createProposal(WS, EDITOR, model.id, version.id, "thicken this wall to 3mm");
    await store.approveProposal(WS, { kind: "human", identity: OWNER }, p1.id);
    const n1 = await decided("cad", p1.id);
    assert.deepEqual(n1.map((n) => n.userId), [EDITOR]);
    assert.equal(n1[0]!.title, "CAD change approved");

    const { proposal: p2 } = await store.createProposal(WS, EDITOR, model.id, version.id, "add a hole");
    await store.rejectProposal(WS, { kind: "human", identity: OWNER }, p2.id, "no");
    assert.equal((await decided("cad", p2.id))[0]?.title, "CAD change denied");

    // Deciding your own proposal: no self-notification.
    const { proposal: p3 } = await store.createProposal(WS, OWNER, model.id, version.id, "add a fillet");
    await store.rejectProposal(WS, { kind: "human", identity: OWNER }, p3.id);
    assert.equal((await decided("cad", p3.id)).length, 0);
  });

  it("direct mail: deciding a mail approval notifies the requester", async () => {
    const mk = async (name: string) => {
      const campaign = await prisma.mailCampaign.create({
        data: { workspaceId: WS, name, audienceSource: {}, status: "pending_approval", createdBy: EDITOR },
      });
      return prisma.mailApproval.create({
        data: { campaignId: campaign.id, creativeHash: "h", pieceCount: 12, maxSpendCents: 1000, status: "pending", approverId: EDITOR },
      });
    };
    const a = await mk("Spring postcards");
    await decideMailApproval(WS, a.id, "approve", OWNER);
    const na = await decided("mail", a.id);
    assert.deepEqual(na.map((n) => n.userId), [EDITOR]);
    assert.equal(na[0]!.title, "Direct mail approved");
    const b = await mk("Fall letters");
    await decideMailApproval(WS, b.id, "reject", OWNER);
    assert.equal((await decided("mail", b.id))[0]?.title, "Direct mail denied");
  });

  it("media: only real decisions notify, and the creator is told", async () => {
    assert.equal(mediaDecisionOf("pending", "approved"), "approved");
    assert.equal(mediaDecisionOf("pending", "pending"), null, "first of two approvals is not a decision");
    assert.equal(mediaDecisionOf("pending", "revoked"), "denied");
    assert.equal(mediaDecisionOf("approved", "revoked"), null, "cancelling an approved buy is not the decision");

    const approval = {
      id: `p4fix-media-${RUN}`,
      workspaceId: WS,
      createdBy: EDITOR,
      maxSpendCents: 25_000,
      binding: { platform: "stackadapt" },
    } as unknown as MediaApproval;
    assert.equal(await notifyMediaApprovalDecided(approval, "approved", OWNER), 1);
    const n = await decided("media", approval.id);
    assert.deepEqual(n.map((x) => x.userId), [EDITOR]);
    assert.equal(n[0]!.title, "Media buy approved");
    assert.equal(n[0]!.href, `/dashboard/media/approvals/${approval.id}`);
  });

  it("a notification failure never fails the decision", async () => {
    // A broken producer db: the producer swallows the error and returns 0.
    const broken = new Proxy({}, { get: () => { throw new Error("db down"); } });
    const approval = { id: "x", workspaceId: WS, createdBy: EDITOR, maxSpendCents: 1, binding: { platform: "p" } } as unknown as MediaApproval;
    assert.equal(await notifyMediaApprovalDecided(approval, "denied", OWNER, broken as never), 0);
  });
});
