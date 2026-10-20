// Marketr — workspace files page (Phase B, W3, track B1).
// Any workspace member can view; write actions are editor+ (API-enforced),
// purge is admin+.
// Phase 18.2 (WS=content): en/es; ?file=<id> opens a file's detail
// (preview, versions, share links, access) — Spotlight and note links land
// here; admins set the version retention.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { FileManager } from "@/components/FileManager";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("filesApp.title")} — ShapesOS`, description: t("filesApp.subtitle") };
}

export default async function FilesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const { t } = await getI18n();
  const sp = await searchParams;
  const fileId = typeof sp.file === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sp.file) ? sp.file : null;

  // ?path=<folder> (a Spotlight folder hit): a display path such as /home/…, /shared/files/reports.
  const folderPath = typeof sp.path === "string" && sp.path.startsWith("/") && sp.path.length <= 1100 ? sp.path : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">{t("filesApp.title")}</h1>
        <p className="mt-1 text-md text-muted">{t("filesApp.subtitle")}</p>
      </div>
      <FileManager
        workspaceId={workspace.id}
        canEdit={roleAtLeast(membership.role, "editor")}
        canPurge={roleAtLeast(membership.role, "admin")}
        canAdmin={roleAtLeast(membership.role, "admin")}
        initialFileId={fileId}
        initialPath={folderPath}
      />
    </div>
  );
}
