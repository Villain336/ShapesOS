// Marketr — site IDE page (milestone 6, extended by 7): supervised rung of the
// fix-agent trust ladder. Two modes:
//   - Connection mode (default): browse/edit over an SFTP connection.
//   - Site mode (?siteId=…): the IDE operates on a milestone-7 Site's working
//     copy, regardless of source (GitHub / SFTP / uploaded files).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { llmStatus } from "@/lib/llm";
import { publicConnection } from "@/lib/sitefiles";
import { ownedSite, publicSite } from "@/lib/connectors/source";
import SiteIde from "@/components/SiteIde";

export const dynamic = "force-dynamic";

export default async function IdePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ siteId?: string }>;
}) {
  const user = await requireUser();
  if (!user) return null; // layout already redirects
  const { id } = await params;
  const { siteId } = await searchParams;

  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
    include: {
      siteConnections: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!project) notFound();

  // --- Site mode (milestone 7)
  if (siteId) {
    const site = await ownedSite(user.id, project.id, siteId);
    if (!site) notFound();
    const pub = publicSite(site);
    const bannerDetail =
      pub.sourceType === "github" && pub.github
        ? `${pub.github.owner}/${pub.github.repo}@${pub.github.branch}`
        : pub.sourceType === "sftp" && pub.sftpConnection
          ? `via ${pub.sftpConnection.label}`
          : "local working copy";
    return (
      <SiteIde
        projectId={project.id}
        domain={project.domain}
        initialConnections={[]}
        llm={llmStatus()}
        siteMode
        apiBase={`/api/websites/${site.id}`}
        siteBanner={{
          mock: pub.isMock,
          title: `${pub.name} (${pub.sourceType})`,
          detail: pub.isMock ? `${bannerDetail} — demo data` : bannerDetail,
        }}
        pageTitle={pub.name}
        pageSubtitle="Edit with AI assistance. The AI proposes — you approve. Deploy from Sites when ready."
      />
    );
  }

  // --- Connection mode (milestone 6)
  return (
    <SiteIde
      projectId={project.id}
      domain={project.domain}
      initialConnections={project.siteConnections.map(publicConnection)}
      llm={llmStatus()}
    />
  );
}
