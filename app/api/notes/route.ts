// ShapesOS — Phase 18.2 (WS=content): Notes API.
// GET  /api/notes[?q=&pinned=1&folder=&tag=&scope=mine|shared|all&recordKind=&recordId=&limit=]
//        → { notes: NoteSummary[], facets: { folders, tags } }
// POST /api/notes { title?, body? | content?, links?, shareState?, folder?, tags?, pinned? }
//        → 201 { note }
// Access: any member (viewer+) — signed in via guardWorkspace. A member sees
// shared notes and their own private ones (lib/notes/service.ts); anyone can
// write their own notes (a note starts private; sharing it with the
// workspace is editor+).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { createNote, findOwnNoteBySourceRef, listNotes, noteFacets } from "@/lib/notes/service";
import { isClientId } from "@/lib/offline/queue";
import { noteActor } from "@/lib/notes/http";
import { roleAtLeast } from "@/lib/authz";
import { ForbiddenError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const LinkSchema = z.object({ kind: z.string().max(40), id: z.string().max(64), label: z.string().max(200).nullish() });

const CreateSchema = z.object({
  title: z.string().max(200).nullish(),
  body: z.string().max(200_000).nullish(),
  content: z.unknown().optional(),
  links: z.array(LinkSchema).max(25).optional(),
  shareState: z.enum(["private", "workspace"]).optional(),
  folder: z.string().max(120).nullish(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  pinned: z.boolean().optional(),
  // Phase 18.3 (WS=flow): an offline-queued create carries its client id; a
  // replay of the same id returns the note it already made (200, replayed).
  clientId: z.string().max(64).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const qs = req.nextUrl.searchParams;
    const recordKind = qs.get("recordKind");
    const recordId = qs.get("recordId");
    const scope = qs.get("scope");
    const [notes, facets] = await Promise.all([
      listNotes(actor, {
        q: qs.get("q"),
        pinned: qs.get("pinned") === "1",
        folder: qs.get("folder"),
        tag: qs.get("tag"),
        scope: scope === "mine" || scope === "shared" ? scope : "all",
        record: recordKind && recordId ? { kind: recordKind, id: recordId } : null,
        limit: Number(qs.get("limit")) || undefined,
      }),
      qs.get("facets") === "0" ? Promise.resolve(null) : noteFacets(actor),
    ]);
    return Response.json({ notes, facets }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const body = CreateSchema.parse(await readJson(req));
    if (body.shareState === "workspace" && !roleAtLeast(actor.role, "editor")) {
      throw new ForbiddenError("Sharing a note with the workspace needs the editor role.");
    }
    const sourceRef = body.clientId && isClientId(body.clientId) ? `offline:${body.clientId}` : null;
    if (body.clientId && !sourceRef) return Response.json({ error: "Invalid clientId." }, { status: 400 });
    if (sourceRef) {
      const prior = await findOwnNoteBySourceRef(actor, sourceRef);
      if (prior) return Response.json({ note: prior, replayed: true }, { status: 200 });
    }
    const note = await createNote({
      sourceRef,
      workspaceId: workspace.id,
      createdBy: user.id,
      title: body.title ?? null,
      body: body.body ?? null,
      content: body.content,
      links: body.links ?? [],
      shareState: body.shareState,
      folder: body.folder ?? null,
      tags: body.tags,
      pinned: body.pinned,
    });
    return Response.json({ note }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
