// ShapesOS — Phase 18.2 (WS=content): mint a live-collaboration token.
// POST /api/collab/token { kind: "note", id }
//   → { enabled: true, url, docName, token, readOnly, user: { name, color }, expiresAt }
//   → { enabled: false, reason } when the collab server isn't configured
//     (COLLAB_PUBLIC_URL / AUTH_SECRET) — the editor then saves on its own.
// Access (fail-closed): guardWorkspace (signed in, current workspace) + the
// note visible to the caller (lib/notes/service.ts; a private note is its
// maker's only → 404). Who can't edit the note gets a READ token: the collab
// server makes that connection read-only (updates dropped server-side). The
// token is short-lived (5 min) and names one document; the browser asks for
// a fresh one on every (re)connect.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { noteActor } from "@/lib/notes/http";
import { noteAccess } from "@/lib/notes/service";
import { caretColor, collabPublicUrl, collabSecret, signCollabToken, COLLAB_TOKEN_TTL_MS } from "@/lib/collab/token";
import { NotFoundError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const Body = z.object({ kind: z.enum(["note"]), id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const body = Body.parse(await readJson(req));
    const access = await noteAccess(actor, body.id);
    if (!access) throw new NotFoundError("Note not found.");
    const url = collabPublicUrl();
    const secret = collabSecret();
    if (!url || !secret) {
      return Response.json({ enabled: false, reason: !url ? "COLLAB_PUBLIC_URL is not set" : "AUTH_SECRET is not set" }, { headers: { "Cache-Control": "no-store" } });
    }
    const docName = `${body.kind}:${body.id}`;
    const now = Date.now();
    const name = (user.name ?? "").trim() || (user.email ?? "").split("@")[0] || "Member";
    const color = caretColor(user.id);
    const token = signCollabToken({ ws: workspace.id, doc: docName, uid: user.id, role: access.canEdit ? "write" : "read", name, color }, secret, now);
    return Response.json(
      { enabled: true, url, docName, token, readOnly: !access.canEdit, user: { name, color }, expiresAt: new Date(now + COLLAB_TOKEN_TTL_MS).toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}
