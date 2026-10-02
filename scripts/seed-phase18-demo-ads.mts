// Marketr — Phase 18 final verification: seed demo ad-platform records for the
// admin workspace so screenshots show real content (clearly labeled "Demo").
// Idempotent: deletes prior "Demo" ad records first.
//
// Run: npx tsx scripts/seed-phase18-demo-ads.mts
// Requires: DATABASE_URL. Credentials parsed literally from .env.

import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import { scopeHashFor } from "../lib/adplatforms/gate";

function env(): Record<string, string> {
  const strip = (v: string) =>
    v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'") ? v.slice(1, -1) : v;
  return Object.fromEntries(
    readFileSync("/home/hatch/workspace/marketr/.env", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), strip(l.slice(i + 1).trim())];
      }),
  );
}

const DEMO = "Phase 18 demo";

async function main() {
  const { ADMIN_EMAIL } = env();
  if (!ADMIN_EMAIL) throw new Error("ADMIN_EMAIL missing in .env");
  const ws = await prisma.workspace.findFirst({
    where: { name: `${ADMIN_EMAIL}'s workspace` },
    select: { id: true },
  });
  if (!ws) throw new Error(`no workspace named ${ADMIN_EMAIL}'s workspace`);
  const workspaceId = ws.id;
  console.log("workspace:", workspaceId);

  await withWorkspaceScope(workspaceId, async (tx) => {
    // Delete prior demo records in dependency order.
    await tx.adReport.deleteMany({ where: { workspaceId, campaign: { name: { startsWith: DEMO } } } });
    await tx.spendApproval.deleteMany({ where: { workspaceId, approver: "demo-admin" } });
    await tx.spendProposal.deleteMany({ where: { workspaceId, proposedBy: "demo-admin" } });
    await tx.paidAdCreative.deleteMany({ where: { workspaceId, group: { campaign: { name: { startsWith: DEMO } } } } });
    await tx.paidAdGroup.deleteMany({ where: { workspaceId, campaign: { name: { startsWith: DEMO } } } });
    await tx.paidAdCampaign.deleteMany({ where: { workspaceId, name: { startsWith: DEMO } } });
    await tx.adAccount.deleteMany({ where: { workspaceId, name: { startsWith: DEMO } } });
    await tx.adPlatform.deleteMany({ where: { workspaceId } });

    const platforms = await Promise.all([
      tx.adPlatform.create({
        data: { workspaceId, key: "amazon", displayName: "Amazon Ads", authKind: "oauth", supportsApiLaunch: true, supportsReportingApi: true },
      }),
      tx.adPlatform.create({
        data: { workspaceId, key: "stackadapt", displayName: "StackAdapt", authKind: "api_key", supportsApiLaunch: true, supportsReportingApi: true },
      }),
      tx.adPlatform.create({
        data: { workspaceId, key: "walmart", displayName: "Walmart Connect", authKind: "guided", guidedOnly: true },
      }),
      tx.adPlatform.create({
        data: { workspaceId, key: "spotify", displayName: "Spotify Ad Studio", authKind: "guided", guidedOnly: true },
      }),
    ]);
    const [amazon, stackadapt] = platforms;

    const amzAcct = await tx.adAccount.create({
      data: { workspaceId, platformId: amazon.id, name: `${DEMO} — Amazon seller account`, externalAccountId: "demo-amz-001", status: "connected", tokenRef: "vault:oauth:amazon:demo" },
    });
    const saAcct = await tx.adAccount.create({
      data: { workspaceId, platformId: stackadapt.id, name: `${DEMO} — StackAdapt seat`, externalAccountId: "demo-sa-001", status: "connected", tokenRef: "vault:apikey:stackadapt:demo" },
    });

    const amzCamp = await tx.paidAdCampaign.create({
      data: { workspaceId, accountId: amzAcct.id, platformKey: "amazon", name: `${DEMO} — Fall Sponsored Products`, objective: "Sales", status: "live", budgetCents: 250000, flightStart: new Date("2026-09-01"), flightEnd: new Date("2026-12-31") },
    });
    const saCamp = await tx.paidAdCampaign.create({
      data: { workspaceId, accountId: saAcct.id, platformKey: "stackadapt", name: `${DEMO} — CTV Holiday Flight`, objective: "Awareness", status: "live", budgetCents: 500000, flightStart: new Date("2026-10-01"), flightEnd: new Date("2026-12-24") },
    });
    const amzDraft = await tx.paidAdCampaign.create({
      data: { workspaceId, accountId: amzAcct.id, platformKey: "amazon", name: `${DEMO} — Sponsored Brands v2`, objective: "Brand", status: "draft", budgetCents: 100000 },
    });

    const amzGroup = await tx.paidAdGroup.create({
      data: { workspaceId, campaignId: amzCamp.id, name: `${DEMO} — SP auto group`, status: "live", budgetCents: 250000 },
    });
    await tx.paidAdCreative.create({
      data: { workspaceId, groupId: amzGroup.id, name: `${DEMO} — hero product creative`, assetRefs: [{ url: "https://example.invalid/hero.jpg", kind: "image", hash: "demo" }] },
    });
    const saGroup = await tx.paidAdGroup.create({
      data: { workspaceId, campaignId: saCamp.id, name: `${DEMO} — CTV 30s group`, status: "live", budgetCents: 500000 },
    });
    await tx.paidAdCreative.create({
      data: { workspaceId, groupId: saGroup.id, name: `${DEMO} — 30s holiday spot`, assetRefs: [{ url: "https://example.invalid/holiday30.mp4", kind: "video", hash: "demo" }] },
    });

    // Proposals: one approved+executed (budget change), one pending (launch),
    // one rejected — so the inbox filters show all states.
    const approvedPayload = { campaignId: amzCamp.id, newBudgetCents: 300000, reason: "Scale winners" };
    const approvedHash = scopeHashFor(approvedPayload);
    const approved = await tx.spendProposal.create({
      data: {
        workspaceId, kind: "budget_change", action: "adjust_budget", targetType: "campaign", targetId: amzCamp.id,
        payload: approvedPayload, scopeHash: approvedHash, status: "executed",
        proposedBy: "demo-admin", decidedBy: "demo-admin", decidedAt: new Date("2026-09-20"),
        expiresAt: new Date("2026-10-20"),
      },
    });
    await tx.spendApproval.create({
      data: { workspaceId, proposalId: approved.id, approver: "demo-admin", scopeHash: approvedHash, decidedAt: new Date("2026-09-20") },
    });

    const pendingPayload = { campaignName: `${DEMO} — DOOH Airport Takeover`, budgetCents: 150000, flightStart: "2026-11-01", flightEnd: "2026-11-30" };
    await tx.spendProposal.create({
      data: {
        workspaceId, kind: "launch", action: "launch", targetType: "campaign", targetId: amzDraft.id,
        payload: pendingPayload, scopeHash: scopeHashFor(pendingPayload), status: "pending",
        proposedBy: "demo-admin", expiresAt: new Date("2026-10-31"),
      },
    });

    const rejectedPayload = { campaignId: saCamp.id, newBudgetCents: 900000, reason: "Over-ask" };
    await tx.spendProposal.create({
      data: {
        workspaceId, kind: "budget_change", action: "adjust_budget", targetType: "campaign", targetId: saCamp.id,
        payload: rejectedPayload, scopeHash: scopeHashFor(rejectedPayload), status: "rejected",
        proposedBy: "demo-admin", decidedBy: "demo-admin", decidedAt: new Date("2026-09-25"),
        expiresAt: new Date("2026-10-25"),
      },
    });

    // 7 days of report metrics for the two live campaigns.
    const days = [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const dt = new Date("2026-09-24");
      dt.setDate(dt.getDate() + d);
      return dt;
    });
    const amzSpend = [4120, 4480, 3890, 4710, 5230, 4980, 4450];
    const saSpend = [8920, 9340, 8710, 9650, 10210, 9980, 9130];
    for (let i = 0; i < days.length; i++) {
      await tx.adReport.create({
        data: {
          workspaceId, platformId: amazon.id, accountId: amzAcct.id, campaignId: amzCamp.id,
          date: days[i], spendCents: amzSpend[i], impressions: 120000 + i * 8000, clicks: 3400 + i * 220,
          ctr: 0.028, conversions: 96 + i * 7, revenueCents: amzSpend[i] * 4 + i * 5000,
          platformReceiptId: `demo-amz-receipt-${i}`,
        },
      });
      await tx.adReport.create({
        data: {
          workspaceId, platformId: stackadapt.id, accountId: saAcct.id, campaignId: saCamp.id,
          date: days[i], spendCents: saSpend[i], impressions: 410000 + i * 22000, clicks: 2100 + i * 140,
          ctr: 0.0051, conversions: 41 + i * 3, revenueCents: saSpend[i] * 3 + i * 3000,
          platformReceiptId: `demo-sa-receipt-${i}`,
        },
      });
    }

    console.log("seeded Phase 18 demo ad records");
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
