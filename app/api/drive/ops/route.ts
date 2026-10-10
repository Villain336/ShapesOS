// ShapesOS — Phase 21B (WS=drive): changing the Drive tree.
// POST /api/drive/ops  { workspaceId, action, … }  (viewer+ to reach it; every action checks the
// person's role on the folder or file it touches — lib/drive/ops.ts, lib/drive/sharing.ts)
//   create_folder {path}                      new folder (and missing parents)
//   rename {kind, id, name}
//   move {items:[{kind,id}], toDir}           move into a folder, keeping names (bulk)
//   trash {items:[{kind,id}]}                 to the Trash (bulk, reversible for 30 days)
//   restore {items:[{kind,id}]}               back from the Trash
//   purge {id}                                one trashed file, for good (its owner or an admin; admin+ here)
//   set_folder {id, color?, tags?}            folder colour / tags
//   set_tags {id, tags}                       a file's tags
//   favorite {kind, id, on}
//   share_folder {id, userId, role|null}      folder access (inherited by everything beneath)
//   smart_save {name, query, filters?} · smart_remove {id}
// Everything is journalled (GET /api/drive/changes) and audited by the layer that does it.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { ForbiddenError } from "@/lib/api/errors";
import { roleAtLeast } from "@/lib/authz";
import { filesErrorResponse } from "@/lib/files/http";
import { FsError } from "@/lib/filesystem/core";
import { basenameOf, normalizeFolderPath } from "@/lib/filesystem/paths";
import { createFolderAs, moveItemAs, removeFromTrashAs, renameItemAs, restoreItemAs, trashItemAs } from "@/lib/drive/ops";
import { updateFolderMeta } from "@/lib/filesystem/folders";
import { requireFolderAction } from "@/lib/drive/ops";
import { deleteSmartFolder, saveSmartFolder, setFavorite, setFileTags } from "@/lib/drive/library";
import { setFolderAccess } from "@/lib/drive/sharing";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const dynamic = "force-dynamic";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Item = z.object({ kind: z.enum(["file", "folder"]), id: Id });
const Items = z.array(Item).min(1).max(200);
const Base = { workspaceId: z.string().min(1).max(120) };

const Body = z.discriminatedUnion("action", [
  z.object({ ...Base, action: z.literal("create_folder"), path: z.string().min(1).max(1100) }),
  z.object({ ...Base, action: z.literal("rename"), kind: z.enum(["file", "folder"]), id: Id, name: z.string().min(1).max(255) }),
  z.object({ ...Base, action: z.literal("move"), items: Items, toDir: z.string().min(1).max(1100) }),
  z.object({ ...Base, action: z.literal("trash"), items: Items }),
  z.object({ ...Base, action: z.literal("restore"), items: Items }),
  z.object({ ...Base, action: z.literal("purge"), id: Id }),
  z.object({ ...Base, action: z.literal("set_folder"), id: Id, color: z.string().max(16).nullable().optional(), tags: z.array(z.string().max(60)).max(20).optional() }),
  z.object({ ...Base, action: z.literal("set_tags"), id: Id, tags: z.union([z.string().max(2000), z.array(z.string().max(60)).max(30)]) }),
  z.object({ ...Base, action: z.literal("favorite"), kind: z.enum(["file", "folder"]), id: Id, on: z.boolean() }),
  z.object({ ...Base, action: z.literal("share_folder"), id: Id, userId: z.string().min(1).max(120), role: z.enum(["viewer", "editor", "owner"]).nullable() }),
  z.object({ ...Base, action: z.literal("smart_save"), name: z.string().min(1).max(120), query: z.string().min(1).max(500), filters: z.record(z.string(), z.unknown()).optional() }),
  z.object({ ...Base, action: z.literal("smart_remove"), id: Id }),
]);

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const raw = (await req.json().catch(() => null)) as unknown;
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid request.");
  const b = parsed.data;
  // Viewers may favourite and keep smart folders (personal); everything else needs editor+.
  const personal = b.action === "favorite" || b.action === "smart_save" || b.action === "smart_remove";
  const access = await requireWorkspaceAccess(user.id, b.workspaceId, personal ? "viewer" : "editor");
  if ("error" in access) return access.error;
  const actor = { workspaceId: access.workspaceId, userId: user.id, role: access.membership.role };
  try {
    switch (b.action) {
      case "create_folder": {
        const f = await createFolderAs(actor, b.path);
        return Response.json({ folder: f }, { status: 201 });
      }
      case "rename":
        return Response.json({ item: await renameItemAs(actor, { kind: b.kind, id: b.id, name: b.name }) });
      case "move": {
        const dest = normalizeFolderPath(b.toDir);
        if (!dest.ok) return badRequest(dest.reason);
        const moved = [];
        for (const it of b.items) {
          const current = await currentName(actor.workspaceId, it);
          moved.push(await moveItemAs(actor, { kind: it.kind, id: it.id, to: `${dest.path}/${current}` }));
        }
        return Response.json({ items: moved });
      }
      case "trash": {
        let trashed = 0;
        for (const it of b.items) trashed += (await trashItemAs(actor, it)).trashed;
        return Response.json({ trashed });
      }
      case "restore": {
        const results = [];
        for (const it of b.items) results.push(await restoreItemAs(actor, it));
        return Response.json({ restored: results.length });
      }
      case "purge": {
        if (!roleAtLeast(access.membership.role, "admin")) throw new ForbiddenError("Removing a file for good is for admins.");
        await removeFromTrashAs(actor, b.id);
        return Response.json({ ok: true });
      }
      case "set_folder": {
        const f = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { id: b.id, workspaceId: actor.workspaceId, trashedAt: null } }));
        if (!f) throw new FsError("not_found", "Folder not found.");
        await requireFolderAction(actor, f, "edit");
        return Response.json({ folder: await updateFolderMeta({ workspaceId: actor.workspaceId, folderId: b.id, color: b.color, tags: b.tags, actorUserId: user.id }) });
      }
      case "set_tags":
        return Response.json({ tags: await setFileTags(actor, b.id, b.tags) });
      case "favorite":
        await setFavorite(actor, b.kind, b.id, b.on);
        return Response.json({ ok: true });
      case "share_folder":
        return Response.json({ entries: await setFolderAccess(actor, b.id, b.userId, b.role) });
      case "smart_save":
        return Response.json({ smartFolder: await saveSmartFolder(actor, { name: b.name, query: b.query, filters: b.filters }) }, { status: 201 });
      case "smart_remove":
        await deleteSmartFolder(actor, b.id);
        return Response.json({ ok: true });
    }
  } catch (err) {
    return filesErrorResponse(err, "drive ops");
  }
}

async function currentName(workspaceId: string, it: { kind: "file" | "folder"; id: string }): Promise<string> {
  if (it.kind === "file") {
    const { prisma } = await import("@/lib/prisma");
    const f = await prisma.workspaceFile.findFirst({ where: { id: it.id, workspaceId, trashedAt: null }, select: { filename: true } });
    if (!f) throw new FsError("not_found", "File not found.");
    return f.filename;
  }
  const f = await withWorkspaceScope(workspaceId, (tx) => tx.workspaceFolder.findFirst({ where: { id: it.id, workspaceId, trashedAt: null }, select: { path: true } }));
  if (!f) throw new FsError("not_found", "Folder not found.");
  return basenameOf(f.path);
}
