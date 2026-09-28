// Marketr — Phase 13B: company knowledge graph CRUD.
// GET  /api/intelligence/knowledge?workspaceId=…[&kind=product]
// POST /api/intelligence/knowledge { workspaceId, kind, title, body, … }

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
  notFound,
} from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { KnowledgeKind } from "@prisma/client";

const KINDS = Object.values(KnowledgeKind) as string[];

function serialize(e: {
  id: string;
  kind: string;
  title: string;
  body: unknown;
  confidence: number;
  pinned: boolean;
  sourceEpisodeId: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...e };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req),
    "viewer",
  );
  if ("error" in access) return access.error;

  const kind = req.nextUrl.searchParams.get("kind");
  if (kind && !KINDS.includes(kind)) {
    return badRequest(`kind must be one of: ${KINDS.join(", ")}`);
  }

  const entries = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.companyKnowledge.findMany({
      where: { workspaceId: access.workspaceId, ...(kind ? { kind: kind as KnowledgeKind } : {}) },
      orderBy: [{ kind: "asc" }, { updatedAt: "desc" }],
    }),
  );
  return Response.json({ entries: entries.map(serialize) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    workspaceId?: string;
    kind?: string;
    title?: string;
    body?: unknown;
    confidence?: number;
    pinned?: boolean;
    sourceEpisodeId?: string;
    validFrom?: string;
    validTo?: string;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req, body),
    "editor",
  );
  if ("error" in access) return access.error;

  if (!body.kind || !KINDS.includes(body.kind)) {
    return badRequest(`kind is required, one of: ${KINDS.join(", ")}`);
  }
  if (!body.title?.trim()) return badRequest("title is required");
  if (body.body == null || typeof body.body !== "object") {
    return badRequest("body (object) is required");
  }

  const entry = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.companyKnowledge.create({
      data: {
        workspaceId: access.workspaceId,
        kind: body.kind as KnowledgeKind,
        title: body.title!.trim().slice(0, 300),
        body: body.body as object,
        confidence:
          typeof body.confidence === "number"
            ? Math.min(Math.max(body.confidence, 0), 1)
            : 1.0,
        pinned: body.pinned === true,
        sourceEpisodeId: body.sourceEpisodeId ?? null,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validTo: body.validTo ? new Date(body.validTo) : null,
      },
    }),
  );
  return Response.json({ entry: serialize(entry) }, { status: 201 });
}

export async function DELETE() {
  return notFound("Use /api/intelligence/knowledge/[id] to delete an entry.");
}
