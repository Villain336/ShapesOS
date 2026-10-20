// ShapesOS — Phase 21B (WS=drive): reading the Drive tree for the Files app.
// GET /api/drive/tree?workspaceId=&view=…  (viewer+; every view is limited to what this person may see)
//   view=roots                      the tops: Home, Shared, (Agents, Apps, Mounts), Trash
//   view=list&path=&sort=&dir=&limit=&offset=   a folder's items (display paths; the four system folders live under /shared)
//   view=trash                      what is in the Trash
//   view=shared                     "Shared with me"
//   view=recents                    my recent changes
//   view=usage                      storage used: workspace, my home, by area
//   view=favorites | tags | tag&tag=… | smart   the personal side
//   view=folder_access&id=          who can do what in a folder
// Private homes of other people never appear (not even to admins) unless shared.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { badRequest, requireWorkspaceAccess } from "@/lib/route-utils";
import { filesErrorResponse } from "@/lib/files/http";
import { listChildren, listRoots, listTrash, recents, sharedWithMe, storageUsage, type DriveSort } from "@/lib/drive/tree";
import { filesWithTag, listFavorites, listSmartFolders, listTags } from "@/lib/drive/library";
import { listFolderAccess } from "@/lib/drive/sharing";
import { normalizeFolderPath } from "@/lib/filesystem/paths";

export const dynamic = "force-dynamic";

const SORTS = new Set<DriveSort>(["name", "kind", "size", "modified", "created"]);

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const qs = req.nextUrl.searchParams;
  const access = await requireWorkspaceAccess(user.id, qs.get("workspaceId"), "viewer");
  if ("error" in access) return access.error;
  const actor = { workspaceId: access.workspaceId, userId: user.id, role: access.membership.role };
  const headers = { "Cache-Control": "no-store" };
  try {
    switch (qs.get("view") ?? "roots") {
      case "roots":
        return Response.json({ roots: await listRoots(actor) }, { headers });
      case "list": {
        const path = qs.get("path") ?? "";
        if (!path.startsWith("/")) return badRequest("path is required.");
        const sort = (qs.get("sort") ?? "name") as DriveSort;
        if (!SORTS.has(sort)) return badRequest("Unknown sort.");
        // The four system folders appear under /shared: /shared/files/x is stored at /files/x.
        const parsed = normalizeFolderPath(path);
        if (!parsed.ok) return badRequest(parsed.reason);
        const listing = await listChildren({
          actor,
          path: parsed.path,
          sort,
          dir: qs.get("dir") === "desc" ? "desc" : "asc",
          limit: Number(qs.get("limit")) || undefined,
          offset: Number(qs.get("offset")) || undefined,
        });
        return Response.json({ listing }, { headers });
      }
      case "trash":
        return Response.json({ items: await listTrash(actor) }, { headers });
      case "shared":
        return Response.json({ items: await sharedWithMe(actor) }, { headers });
      case "recents":
        return Response.json({ items: await recents(actor) }, { headers });
      case "usage":
        return Response.json({ usage: await storageUsage(actor) }, { headers });
      case "favorites":
        return Response.json({ items: await listFavorites(actor) }, { headers });
      case "tags":
        return Response.json({ tags: await listTags(actor) }, { headers });
      case "tag": {
        const tag = (qs.get("tag") ?? "").trim();
        if (!tag) return badRequest("tag is required.");
        return Response.json({ items: await filesWithTag(actor, tag) }, { headers });
      }
      case "smart":
        return Response.json({ smartFolders: await listSmartFolders(actor) }, { headers });
      case "folder_access": {
        const id = qs.get("id") ?? "";
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return badRequest("id is required.");
        return Response.json(await listFolderAccess(actor, id), { headers });
      }
      default:
        return badRequest("Unknown view.");
    }
  } catch (err) {
    return filesErrorResponse(err, "drive tree");
  }
}
