// ShapesOS — nurture direct-mail daily cap is atomic across concurrent sweeps
// (Phase 4a: the Phase 2 follow-up fixed SMS/email; mail kept a
// check-then-send gap). The print provider is faked: executeCampaign is
// mocked to mark the campaign's piece sent after a delay, refusing campaigns
// that are no longer approved (as the real one does).
// Run: npm run test:db (needs DATABASE_URL, app role).

import "dotenv/config";
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";

// Registered at top level, before the module under test is imported.
mock.module("@/lib/mail/service", {
  namedExports: {
    extractAddressFromLead: () => null,
    getMailConsent: async () => "opted_in",
    verifyAddresses: async () => undefined,
    requestApproval: async () => undefined,
    creativeHashFor: () => "hash",
    executeCampaign: async (_ws: string, campaignId: string) => {
      const claimed = await prisma.mailCampaign.updateMany({
        where: { id: campaignId, status: "approved" },
        data: { status: "sending" },
      });
      if (claimed.count !== 1) throw new Error("Refusing to send: campaign is not approved");
      await new Promise((r) => setTimeout(r, 40));
      const sent = await prisma.mailPiece.updateMany({
        where: { campaignId, status: "queued" },
        data: { status: "sent", sentAt: new Date() },
      });
      return { sent: sent.count, suppressed: 0, quarantinedSkipped: 0, failed: 0 };
    },
  },
});

let dispatchDueNurtureMail: typeof import("../mail-channel").dispatchDueNurtureMail;

const RUN = Date.now().toString(36);
const WS = `p4fix-mailcap-${RUN}`;
const CAP = 2;
const CAMPAIGNS = 5;

before(async () => {
  ({ dispatchDueNurtureMail } = await import("../mail-channel"));
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: `owner-${RUN}` } });
  await prisma.workspaceSettings.create({
    data: { workspaceId: WS, agentAllowList: [], notificationDefaults: { messaging: { dailyCap: CAP } } },
  });
  const mailDate = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < CAMPAIGNS; i++) {
    const c = await prisma.mailCampaign.create({
      data: {
        workspaceId: WS,
        name: `cap ${i}`,
        status: "approved",
        audienceSource: { kind: "nurture_step", channel: "postcard", mailDate },
        pieceCount: 1,
      },
    });
    await prisma.mailApproval.create({
      data: { campaignId: c.id, creativeHash: "hash", pieceCount: 1, maxSpendCents: 100, status: "approved", decidedAt: new Date() },
    });
    await prisma.mailPiece.create({
      data: { campaignId: c.id, addressSnapshot: {}, verificationStatus: "verified", status: "queued" },
    });
  }
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } }).catch(() => {});
  await prisma.$disconnect();
});

const sentPieces = () =>
  prisma.mailPiece.count({ where: { campaign: { workspaceId: WS }, status: "sent" } });

describe("nurture mail daily cap", () => {
  it("concurrent sweeps never send more than the cap", async () => {
    await Promise.all(Array.from({ length: 4 }, () => dispatchDueNurtureMail(WS)));
    assert.ok((await sentPieces()) <= CAP, `sent ${await sentPieces()} > cap ${CAP}`);
    // Campaigns skipped while another sweep held the lock stay approved and
    // are picked up later — still never past the cap.
    await dispatchDueNurtureMail(WS);
    await dispatchDueNurtureMail(WS);
    assert.equal(await sentPieces(), CAP);
    const r = await dispatchDueNurtureMail(WS);
    assert.equal(r.skippedCap, CAMPAIGNS - CAP);
  });
});
