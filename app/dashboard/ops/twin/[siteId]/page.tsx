// ShapesOS Phase 13 — /dashboard/ops/twin/[siteId]: one site's digital twin.
//
// Server Component: loads the snapshot (lib/twin/state.ts siteSnapshot, RLS
// workspace-scoped) and renders the client shell, which server-renders the
// top bar, KPI cards, top-down SVG, inspector frame, shipment stepper and
// tables. Only the WebGL canvas is client-only (next/dynamic, ssr:false,
// inside TwinClient); the live stream then keeps the snapshot current.
import { notFound } from "next/navigation";
import { TwinClient } from "@/components/twin/TwinClient";
import { requireOpsViewer } from "@/lib/ops/page-guard";
import { requireWorkspaceRole } from "@/lib/authz";
import { listSites, siteSnapshot } from "@/lib/twin/state";
import type { TwinSnapshot } from "@/lib/twin/types";

export const dynamic = "force-dynamic";

export const metadata = { title: "Digital twin — ShapesOS", description: "A live 3D site drawn from ShapesOS records." };

function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; name?: string; message?: string } | null;
  return !!e && (e.status === 404 || /NotFound/.test(e.name ?? "") || /not found/i.test(e.message ?? ""));
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { userId, workspaceId } = await requireOpsViewer();
  const [{ siteId }, sp] = await Promise.all([params, searchParams]);
  const canEdit = !!(await requireWorkspaceRole(userId, workspaceId, "editor"));

  let snapshot: TwinSnapshot;
  try {
    snapshot = await siteSnapshot(workspaceId, siteId);
  } catch (err) {
    if (isNotFound(err)) notFound();
    console.error("[twin] siteSnapshot failed", err);
    return (
      <div className="rounded-lg border border-failed bg-failed-tint px-4 py-3 text-sm text-failed-text" role="alert">
        This site couldn&rsquo;t be loaded. Reload to try again; if it keeps failing, check the site&rsquo;s layout in the list.
      </div>
    );
  }
  if (snapshot.site.status === "draft" && !canEdit) notFound();

  const sites = await listSites(workspaceId).catch(() => [
    { id: snapshot.site.id, kind: snapshot.site.kind, status: snapshot.site.status, name: snapshot.site.name, code: snapshot.site.code, objectCount: snapshot.objects.length, updatedAt: snapshot.generatedAt },
  ]);
  const switcher = sites
    .filter((s) => canEdit || s.status === "published")
    .map(({ id, kind, status, name, code }) => ({ id, kind, status, name, code }));

  // Phase 14 (approvals): every member gets live updates (viewers: published
  // sites only — the draft check above, and the stream re-checks it each
  // tick). "Snapshot" shows only when the stream ends for good. Writes stay
  // editor+ (canEdit).
  return <TwinClient key={snapshot.site.id} initial={snapshot} sites={switcher} canEdit={canEdit} live startEditing={sp.edit === "1"} />;
}
