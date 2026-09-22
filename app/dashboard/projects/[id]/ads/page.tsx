// Marketr — ad factory studio page (milestone 21).
// Server page with a client studio island (campaigns, generate, gallery,
// settings). Viewer role is read-only; editor+ can generate/review.

import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getAdSettings, getCampaignSpend, getSpendSummary, listCampaigns } from "@/lib/ads/service";
import AdFactory from "@/components/AdFactory";

export const dynamic = "force-dynamic";

export default async function AdsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true },
  });
  if (!project) notFound();

  const canEdit = !!(await requireProjectRole(user.id, project.id, "editor"));

  const [campaigns, brandKits, settings, spend] = await Promise.all([
    listCampaigns(prisma, project.id),
    prisma.brandKit.findMany({
      where: { workspaceId: project.workspaceId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    getAdSettings(prisma, project.workspaceId),
    getSpendSummary(prisma, project.workspaceId),
  ]);

  // Hydrate each campaign's creatives + spend (kept small: latest 100).
  const hydrated = await Promise.all(
    campaigns.map(async (c) => {
      const [creatives, campaignSpend] = await Promise.all([
        prisma.adCreative.findMany({
          where: { campaignId: c.id },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        getCampaignSpend(prisma, c.id),
      ]);
      return {
        id: c.id,
        name: c.name,
        objective: c.objective,
        brandKitId: c.brandKitId,
        channels: (c.channels ?? []) as string[],
        _count: { creatives: c._count.creatives },
        spend: campaignSpend,
        creatives: creatives.map((cr) => ({
          id: cr.id,
          campaignId: cr.campaignId,
          name: cr.name,
          type: cr.type,
          brief: (cr.brief ?? {}) as Record<string, string>,
          prompt: cr.prompt,
          promptHistory: (cr.promptHistory ?? []) as { prompt: string; at: string }[],
          status: cr.status,
          aspectRatio: cr.aspectRatio,
          channels: (cr.channels ?? []) as string[],
          costEstimateCents: cr.costEstimateCents,
          costActualCents: cr.costActualCents,
          assets: (cr.assets ?? []) as { url: string; variantIndex: number }[],
          error: cr.error,
          approved: cr.approved,
          rejected: cr.rejected,
          createdAt: cr.createdAt.toISOString(),
        })),
      };
    }),
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-white">Ad factory</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Briefs become on-brand ad creatives through the Higgsfield API — review, iterate, then send winners to social.
        </p>
      </div>
      <AdFactory
        projectId={project.id}
        campaigns={hydrated}
        brandKits={brandKits}
        settings={{
          connected: !!settings?.higgsfieldKeyEnc,
          hint: settings?.higgsfieldKeyHint ?? null,
          capCents: settings?.monthlyCapCents ?? 5000,
          spend,
        }}
        canEdit={canEdit}
      />
    </div>
  );
}
