// ShapesOS — Phase 18.3 (WS=flow): the version history hub. One list of the
// notes, Office docs and files that have earlier versions — read from 18.2's
// UniverDocVersion and WorkspaceFileVersion (no new version tables); opening
// one shows the existing Versions panels, which restore through 18.2's own
// routes and functions (restoreDocVersion / restoreFileVersion).
// Visibility is the apps' own: a private note or doc only for its maker,
// files only where this person's file role allows "view".

import type { WorkspaceRole } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { fileRoleFor } from "@/lib/files/access";

export interface VersionedItem {
  kind: "note" | "doc" | "file";
  id: string;
  title: string;
  versions: number;
  lastAt: string;
  /** Where the item opens. */
  href: string;
  /** The API base its Versions panel uses. */
  apiBase: string;
}

export async function listVersionedItems(actor: { workspaceId: string; userId: string; role: WorkspaceRole }, limit = 40): Promise<VersionedItem[]> {
  const ws = actor.workspaceId;
  const [docRows, fileRows] = await withWorkspaceScope(ws, async (tx) => [
    await tx.univerDocVersion.groupBy({ by: ["docId"], where: { workspaceId: ws }, _count: { _all: true }, _max: { createdAt: true }, orderBy: { _max: { createdAt: "desc" } }, take: limit * 2 }),
    await tx.workspaceFileVersion.groupBy({ by: ["fileId"], where: { workspaceId: ws }, _count: { _all: true }, _max: { replacedAt: true }, orderBy: { _max: { replacedAt: "desc" } }, take: limit * 2 }),
  ] as const);
  const docs = docRows.length
    ? await withWorkspaceScope(ws, (tx) =>
        tx.univerDoc.findMany({ where: { workspaceId: ws, id: { in: docRows.map((d) => d.docId) } }, select: { id: true, kind: true, title: true, shareState: true, createdBy: true } }),
      )
    : [];
  const files = fileRows.length
    ? await withWorkspaceScope(ws, (tx) =>
        tx.workspaceFile.findMany({ where: { workspaceId: ws, id: { in: fileRows.map((f) => f.fileId) }, trashedAt: null }, select: { id: true, filename: true } }),
      )
    : [];
  const out: VersionedItem[] = [];
  for (const d of docRows) {
    const doc = docs.find((x) => x.id === d.docId);
    if (!doc) continue;
    if (doc.shareState === "private" && doc.createdBy !== actor.userId) continue;
    const isNote = doc.kind === "note";
    out.push({
      kind: isNote ? "note" : "doc",
      id: doc.id,
      title: doc.title,
      versions: d._count._all,
      lastAt: (d._max.createdAt ?? new Date(0)).toISOString(),
      href: isNote ? `/dashboard/notes?note=${encodeURIComponent(doc.id)}` : `/dashboard/office?open=${encodeURIComponent(doc.id)}`,
      apiBase: isNote ? `/api/notes/${encodeURIComponent(doc.id)}` : `/api/office/docs/${encodeURIComponent(doc.id)}`,
    });
  }
  for (const f of fileRows) {
    const file = files.find((x) => x.id === f.fileId);
    if (!file) continue;
    if (!(await fileRoleFor({ workspaceId: ws, userId: actor.userId, role: actor.role }, file.id).catch(() => null))) continue;
    out.push({
      kind: "file",
      id: file.id,
      title: file.filename,
      versions: f._count._all,
      lastAt: (f._max.replacedAt ?? new Date(0)).toISOString(),
      href: `/dashboard/files?file=${encodeURIComponent(file.id)}`,
      apiBase: `/api/files/${encodeURIComponent(file.id)}`,
    });
  }
  return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}
