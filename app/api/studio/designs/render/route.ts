// Marketr — studio designs render API (Phase 11 "Canvas").
// POST /api/studio/designs/render — render a design to PNG.
// GET  /api/studio/designs/render — same, for saved designs via ?id=.
//
// The automation primitive: POST a DesignDocument JSON → image/png bytes.
// n8n HTTP Request nodes, GrowthOS batch loops, "regenerate the winners
// nightly" — every template becomes addressable by automation.
//
// Contract:
//   POST body (JSON): { document?: DesignDocument, id?: string,
//                       pageId?: string, scale?: number }
//   GET query:        ?id=<designId>&pageId=<pageId>&scale=<n>
//   - `id` loads a saved design (workspace-scoped, same read path as
//     GET /api/studio/designs/[id]); `document` renders inline JSON.
//     Supply exactly one of them.
//   - `scale`: 1..3 (default 1), multiplies the page's pixel dimensions.
//   - Success: 200 image/png. Warnings (e.g. failed images → placeholders)
//     surface in the X-Render-Warnings header, never in the pixels.
//   - Errors: 400 invalid input/document, 404 design not found,
//     429 rate-limited, 500 render failed. Messages are light — no internals.
//
// Protection: workspace-scoped by guardWorkspace; per-tenant rate limit on
// the "ai" tier (expensive compute, like LLM routes) keyed by workspace —
// the global proxy write/read tiers apply on top.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "../_lib";
import { validateDesignDocument } from "@/lib/design/validate";
import {
  MAX_RENDER_SCALE,
  renderDocumentToPng,
} from "@/lib/design/render-server";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  document: z.unknown().optional(),
  pageId: z.string().trim().min(1).max(128).optional(),
  scale: z.number().finite().min(1).max(MAX_RENDER_SCALE).optional(),
});

function safeFilenamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "design";
}

async function renderRequest(opts: {
  workspaceId: string;
  id?: string;
  document?: unknown;
  pageId?: string;
  scale?: number;
}): Promise<Response> {
  const { id, document, pageId, scale } = opts;
  if ((id && document !== undefined) || (!id && document === undefined)) {
    return Response.json(
      { error: "Provide exactly one of: id (saved design) or document (inline JSON)" },
      { status: 400 },
    );
  }

  let doc: unknown;
  let designName = "inline";
  if (id) {
    const row = await prisma.design.findFirst({
      where: { id, workspaceId: opts.workspaceId },
      select: { id: true, name: true, document: true },
    });
    if (!row) return Response.json({ error: "Design not found" }, { status: 404 });
    doc = row.document;
    designName = row.name;
  } else {
    doc = document;
  }

  // Reject invalid documents with 400 — never render garbage.
  const validated = validateDesignDocument(doc);
  if (!validated.ok) {
    return Response.json({ error: "Invalid design document", detail: validated.error }, { status: 400 });
  }

  const result = await renderDocumentToPng(doc, { scale: scale ?? 1, pageId });
  if (!result.ok) {
    const status = result.error.startsWith("page not found") ? 400 : 500;
    return Response.json({ error: result.error }, { status });
  }

  const actualScale = scale ?? 1;
  const headers: Record<string, string> = {
    "Content-Type": "image/png",
    "Content-Length": String(result.png.length),
    "Content-Disposition": `inline; filename="${safeFilenamePart(designName)}-${safeFilenamePart(result.pageId)}@${actualScale}x.png"`,
    "Cache-Control": "no-store",
  };
  if (result.warnings.length > 0) {
    headers["X-Render-Warnings"] = result.warnings
      .map((w) => `${w.elementId}: ${w.message}`)
      .join(" | ")
      .slice(0, 2000);
  }
  return new Response(new Uint8Array(result.png), { status: 200, headers });
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    // Per-tenant automation protection: expensive renders get the "ai"
    // tier (20/min) keyed by workspace, on top of the proxy's write tier.
    const rl = await checkRateLimitAsync(`render:ws:${workspace.id}`, "ai");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

    const url = new URL(req.url);
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const id = parsed.data.id ?? url.searchParams.get("id") ?? undefined;
    return await renderRequest({
      workspaceId: workspace.id,
      id: id ?? undefined,
      document: parsed.data.document,
      pageId: parsed.data.pageId,
      scale: parsed.data.scale,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const rl = await checkRateLimitAsync(`render:ws:${workspace.id}`, "ai");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const scaleRaw = url.searchParams.get("scale");
    const scale = scaleRaw === null ? undefined : Number(scaleRaw);
    if (!id) {
      return Response.json({ error: "Missing required query param: id" }, { status: 400 });
    }
    if (scale !== undefined && !(Number.isFinite(scale) && scale >= 1 && scale <= MAX_RENDER_SCALE)) {
      return Response.json(
        { error: `scale must be a number between 1 and ${MAX_RENDER_SCALE}` },
        { status: 400 },
      );
    }
    return await renderRequest({
      workspaceId: workspace.id,
      id,
      pageId: url.searchParams.get("pageId") ?? undefined,
      scale,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
