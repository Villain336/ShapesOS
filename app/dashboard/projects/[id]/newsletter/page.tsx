// Marketr — newsletter studio (milestone 19).
// Server page with a client studio island (composer, templates, lists,
// broadcasts, domains & settings). Seeds starter templates on first visit.

import { accessibleWorkspaceWhere, getMembership, requireProjectRole } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { seedStarterTemplates } from "@/lib/newsletter/service";
import NewsletterStudio from "@/components/NewsletterStudio";

export const dynamic = "force-dynamic";

export default async function NewsletterPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    select: { id: true, workspaceId: true, domain: true },
  });
  if (!project) notFound();

  const canEdit = !!(await requireProjectRole(user.id, project.id, "editor"));
  const membership = await getMembership(user.id, project.workspaceId);

  // Seed starters on first visit so the composer is never empty.
  const templateCount = await prisma.newsletterTemplate.count({ where: { projectId: project.id } });
  if (templateCount === 0) {
    await seedStarterTemplates(prisma, project.id, project.workspaceId);
  }

  const [templates, lists, domains, broadcasts, settings, brandKits] = await Promise.all([
    prisma.newsletterTemplate.findMany({
      where: { projectId: project.id },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, brandKitId: true, isStarter: true },
    }),
    prisma.newsletterList.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { subscribers: { where: { status: "subscribed" } } } } },
    }),
    prisma.newsletterDomain.findMany({
      where: { workspaceId: project.workspaceId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.newsletterBroadcast.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        list: { select: { id: true, name: true } },
        domain: { select: { id: true, domain: true, status: true } },
      },
    }),
    prisma.newsletterSettings.findUnique({ where: { workspaceId: project.workspaceId } }),
    prisma.brandKit.findMany({
      where: { workspaceId: project.workspaceId },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-300">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Newsletter</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Design emails from blocks, grow lists, and send campaigns through Resend.
          {!membership && " (read-only)"}
        </p>
      </div>
      <NewsletterStudio
        projectId={project.id}
        workspaceId={project.workspaceId}
        canEdit={canEdit}
        initialTemplates={templates}
        initialLists={lists.map((l) => ({
          id: l.id,
          name: l.name,
          doubleOptIn: l.doubleOptIn,
          subscribedCount: l._count.subscribers,
        }))}
        initialDomains={domains.map((d) => ({
          id: d.id,
          domain: d.domain,
          status: d.status,
          dnsRecords: (d.dnsRecords as { name: string; type: string; value: string; purpose: string }[]) ?? [],
        }))}
        initialBroadcasts={broadcasts.map((b) => ({
          id: b.id,
          subject: b.subject,
          status: b.status,
          scheduledAt: b.scheduledAt?.toISOString() ?? null,
          testSentAt: b.testSentAt?.toISOString() ?? null,
          testSentTo: b.testSentTo,
          stats: (b.stats as Record<string, unknown>) ?? {},
          error: b.error,
          list: b.list,
          domain: b.domain,
        }))}
        brandKits={brandKits}
        settingsHint={settings?.resendKeyHint ?? null}
        defaultFromName={settings?.defaultFromName ?? null}
      />
    </div>
  );
}
