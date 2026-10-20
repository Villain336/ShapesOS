// Marketr — Knowledge Brain: proposed-source management.
// GET    /api/corpus/propose          → proposed sources (viewer+)
// POST   /api/corpus/propose          → create proposal (platform operators)
//   { title, pillar, kind: "url"|"upload"|"text", url?, text?, fileName?, fileBase64?, teaches?, note? }
//   - url: validated http(s) URL, recorded only — never fetched automatically.
//   - text: pasted text the user provides (theirs to give); stored as payload.
//   - upload: fileBase64 (+ fileName); .md/.txt/.pdf only, ≤2MB.
// DELETE /api/corpus/propose?id=…     → withdraw proposal (platform operators)
//
// The corpus is SHARED by every tenant on the install, so mutations are not
// a workspace role: only MARKETR_PLATFORM_OPERATORS may change it (Phase 1).

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { requirePlatformOperator } from "@/lib/auth/require-platform-operator";
import {
  listProposed,
  getProposed,
  saveProposed,
  saveProposedPayload,
  deleteProposed,
  sanitizeId,
  sanitizePillar,
} from "@/lib/intelligence/corpus/proposals";
import type { ProposedSource } from "@/lib/intelligence/corpus/graph";
import { corpusReadOnlyReason, ensureCorpusFresh } from "@/lib/intelligence/corpus/sync";

export const dynamic = "force-dynamic";

const ALLOWED_EXT = new Set([".md", ".txt", ".pdf"]);
const MAX_BYTES = 2 * 1024 * 1024;

async function authed(min: "viewer") {
  const user = await requireUser();
  if (!user) return { err: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!membership) return { err: forbidden() };
  return { user };
}

export async function GET() {
  const a = await authed("viewer");
  if (a.err) return a.err;
  await ensureCorpusFresh();
  return Response.json({ proposed: listProposed() });
}

export async function POST(req: Request) {
  const user = await requirePlatformOperator();
  if (user instanceof Response) return user;
  // Deploy PR (class c): no runtime corpus edits on a shared/hosted install.
  const readOnly = corpusReadOnlyReason();
  if (readOnly) return Response.json({ error: readOnly }, { status: 409 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "";
  if (!title) return Response.json({ error: "title is required" }, { status: 400 });
  const kind = body.kind;
  if (kind !== "url" && kind !== "upload" && kind !== "text") {
    return Response.json({ error: "kind must be url, upload, or text" }, { status: 400 });
  }
  const pillar = sanitizePillar(body.pillar);
  const id = sanitizeId(body.id) ?? sanitizeId(title);
  if (!id) return Response.json({ error: "could not derive a valid id" }, { status: 400 });
  if (getProposed(id)) return Response.json({ error: "a proposal with this id already exists" }, { status: 409 });

  const teaches = typeof body.teaches === "string" ? body.teaches.trim().slice(0, 300) : undefined;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : undefined;

  const proposal: ProposedSource = {
    id,
    title,
    pillar,
    kind,
    teaches,
    status: "proposed",
    createdAt: new Date().toISOString(),
    createdBy: user.email ?? user.id,
    note,
  };

  if (kind === "url") {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url) || url.length > 2048) {
      return Response.json({ error: "a valid http(s) url is required" }, { status: 400 });
    }
    proposal.url = url;
  } else if (kind === "text") {
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim().length < 200) {
      return Response.json({ error: "pasted text must be at least 200 characters" }, { status: 400 });
    }
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      return Response.json({ error: "pasted text exceeds 2MB" }, { status: 400 });
    }
    saveProposedPayload(id, Buffer.from(text, "utf8"));
  } else {
    // upload
    const fileName = typeof body.fileName === "string" ? body.fileName : "";
    const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return Response.json({ error: "only .md, .txt, .pdf uploads are accepted" }, { status: 400 });
    }
    const b64 = typeof body.fileBase64 === "string" ? body.fileBase64 : "";
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      return Response.json({ error: "fileBase64 is not valid base64" }, { status: 400 });
    }
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      return Response.json({ error: "file must be non-empty and ≤2MB" }, { status: 400 });
    }
    proposal.fileName = fileName.slice(0, 120);
    saveProposedPayload(id, buf);
  }

  saveProposed(proposal);
  return Response.json({ proposal }, { status: 201 });
}

export async function DELETE(req: Request) {
  const op = await requirePlatformOperator();
  if (op instanceof Response) return op;
  // Deploy PR (class c): no runtime corpus edits on a shared/hosted install.
  const readOnly = corpusReadOnlyReason();
  if (readOnly) return Response.json({ error: readOnly }, { status: 409 });
  const id = sanitizeId(new URL(req.url).searchParams.get("id"));
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  if (!deleteProposed(id)) return Response.json({ error: "proposal not found" }, { status: 404 });
  return Response.json({ ok: true });
}
