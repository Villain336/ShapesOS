// Marketr — brand kit settings page (milestone 12: white-label reporting).
// Editor+ only (server-gated); viewers are redirected to the dashboard.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import BrandKitManager from "@/components/BrandKitManager";

export const dynamic = "force-dynamic";

export default async function BrandKitsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard");

  const brandKits = await prisma.brandKit.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { _count: { select: { templates: true, reports: true } } },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Brand kits</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          White-label identity for client reports — logo, colors, fonts, tone. The default kit
          applies wherever a template doesn&apos;t pick one.
        </p>
      </div>
      <BrandKitManager
        initial={brandKits.map((k) => ({
          id: k.id,
          name: k.name,
          logoPath: k.logoPath,
          colors: (k.colors as Record<string, string>) ?? {},
          fonts: (k.fonts as Record<string, string>) ?? {},
          tone: k.tone,
          clientId: k.clientId,
          isDefault: k.isDefault,
          _count: k._count,
        }))}
      />
    </div>
  );
}
