// ShapesOS — Phase 21B (WS=drive): Spotlight source "folder".
//
// Folders are rows now (workspace_folders, FORCE RLS), so a folder — an empty one
// too — is found by name and path and opens in the Files app. Visibility is the
// Drive rule: a folder inside someone's private home is theirs alone. Trashed
// folders never show. Paths are shown the way the Files app shows them (the four
// system folders live under /shared).

import { Prisma } from "@prisma/client";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";

export const folder: SearchSource = {
  kind: "folder",
  minRole: "viewer",
  modes: ["name"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "workspace_folders t",
      scope: ctx.userId
        ? Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.trashed_at IS NULL AND (t.owner_user_id IS NULL OR t.owner_user_id = ${ctx.userId})`
        : Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.trashed_at IS NULL AND t.owner_user_id IS NULL`,
      // sub = the stored path; the hit shows it as the Files app does.
      select: "t.id, t.name AS title, t.path AS sub, NULL::text AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "(t.name || ' ' || t.path)",
      nameSim: "t.name",
    }),
  hit: (r) => {
    const stored = r.sub ?? "/";
    const shown = /^\/(skills|memory|artifacts|files)(\/|$)/.test(stored) ? `/shared${stored}` : stored;
    return { id: r.id, title: r.title ?? "Folder", subtitle: shown, href: `/dashboard/files?path=${encodeURIComponent(shown)}` };
  },
};
