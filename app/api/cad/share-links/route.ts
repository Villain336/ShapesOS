// Marketr — CAD + Hardware slice 1 API.
// GET  /api/cad/share-links?modelId= — the model's links (viewer+).
// POST /api/cad/share-links — mint a tokenized collaborator link (editor).
//        { modelId, pinnedVersionId?, expiresInDays?, label? }. The token is
//        returned ONCE here. Creation is a consequential action: the UI puts
//        an explicit confirmation step in front of it (what the link exposes,
//        who can open it, when it expires).

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["MODEL_NOT_FOUND", "VERSION_NOT_FOUND", "LINK_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const modelId = new URL(req.url).searchParams.get("modelId") ?? "";
    if (!modelId) throw new CadError("INVALID_REQUEST", "modelId is required.");
    const store = new PrismaCadStore(prisma);
    const links = await store.listShareLinks(workspace.id, modelId);
    // Tokens are capability secrets: the LIST never returns them; only the
    // creation response carries the token, once.
    const safe = links.map(({ token: _t, ...rest }) => rest);
    return Response.json({ links: safe });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      modelId?: unknown;
      pinnedVersionId?: unknown;
      expiresInDays?: unknown;
      label?: unknown;
    };
    const modelId = typeof body.modelId === "string" ? body.modelId : "";
    if (!modelId) throw new CadError("INVALID_REQUEST", "modelId is required.");
    const expiresInDays =
      body.expiresInDays === null || body.expiresInDays === undefined
        ? null
        : typeof body.expiresInDays === "number"
          ? body.expiresInDays
          : NaN;
    if (Number.isNaN(expiresInDays)) {
      throw new CadError("INVALID_EXPIRY", "expiresInDays must be a number of days.");
    }
    const store = new PrismaCadStore(prisma);
    const link = await store.createShareLink(workspace.id, user.email ?? user.id, modelId, {
      pinnedVersionId:
        typeof body.pinnedVersionId === "string" && body.pinnedVersionId
          ? body.pinnedVersionId
          : null,
      expiresInDays,
      label: typeof body.label === "string" ? body.label : null,
    });
    return Response.json(
      {
        link: { ...link, token: undefined, hasToken: true },
        // The raw token: shown once, never stored anywhere else.
        token: link.token,
        url: `/r/cad/${link.token}`,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}
