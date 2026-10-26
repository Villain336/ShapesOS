// ShapesOS — /api/projects/[id]/dev-preview/[port]/[...path]: authenticated
// proxy into the project's persistent dev sandbox. Never wakes a paused
// sandbox (the browser panel's explicit Resume does that through
// /dev-sandbox POST).
//
// Auth (v2, capability URLs - the v1 ambient cookie is deleted):
//  - CANONICAL: /cap/<token>/ prefix (lib/sandbox/dev-preview-token.ts) - a
//    server-stored, revocable, unguessable bearer minted ONLY by the
//    session-authenticated /dev-sandbox status endpoint. Read-only
//    (GET/HEAD), bound to project+port+workspace+sandbox generation, sliding
//    1h expiry (renewed by the owning session's status poll ONLY - bearer
//    requests never extend), 24h absolute cap. The issuer's CURRENT
//    membership+viewer role is re-checked on EVERY bearer request (uncached):
//    a removed member's tokens are dead immediately.
//  - FALLBACK: a same-origin session (the panel itself) proxies directly
//    with role-based canWrite. It mints NOTHING and sets no cookie.

import { NextRequest } from "next/server";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { proxyDevPreview, devPreviewPath, encodeDevPreviewPathSegment } from "@/lib/sandbox/dev-preview-proxy";
import { issueOrRenewDevPreviewToken, verifyDevPreviewToken } from "@/lib/sandbox/dev-preview-token";
import { getDevSandboxRow } from "@/lib/sandbox/dev-sandbox";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; port: string; path?: string[] }> };

const READ_METHODS = new Set(["GET", "HEAD"]);

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const enabled = process.env.SHAPES_DEV_PREVIEW === "1" || req.cookies.get("shapes_dev_preview")?.value === "1";
  if (!enabled) return new Response("Not found", { status: 404 });
  const p = await ctx.params;
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return new Response("Not found", { status: 404 });

  // Capability URL? /api/projects/<id>/dev-preview/<port>/cap/<token>/<rest>
  const segs = p.path ?? [];
  if (segs[0] === "cap" && segs.length >= 2) {
    const raw = segs[1];
    const rest = segs.slice(2);
    // Resolve the project first (no RLS on projects) to learn the workspace
    // scope the token table's FORCE-RLS requires.
    const project = await prisma.project.findFirst({ where: { id: p.id } });
    if (!project) return new Response("Not found", { status: 404 });
    const claims = await verifyDevPreviewToken(project.workspaceId, raw, p.id, port);
    if (!claims || claims.workspaceId !== project.workspaceId) return new Response("Not found", { status: 404 });
    if (!READ_METHODS.has(req.method)) return new Response("Preview tokens are read-only.", { status: 401 });
    // CURRENT membership, every request (uncached): a removed member's
    // tokens die here, not at token expiry.
    if (!(await requireProjectRole(claims.userId, project.id, "viewer"))) {
      return new Response("Not found", { status: 404 });
    }
    // Generation binding: destroy/recreate invalidates every old token.
    const sbRow = await getDevSandboxRow(project.workspaceId, project.id);
    if (!sbRow || sbRow.sandboxId !== claims.sandboxId) return new Response("Not found", { status: 404 });
    const linkPrefix = `${devPreviewPath(p.id, port)}cap/${raw}/`;
    return proxyDevPreview(req, { projectId: p.id, port: p.port, path: rest }, { workspaceId: project.workspaceId, canWrite: false, linkPrefix });
  }

  // Session fallback (same-origin panel), role-checked. A directly-proxied
  // DOCUMENT is broken by design: the CSP-sandboxed page is an opaque
  // origin, so its subresource requests arrive cross-site WITHOUT the
  // session cookie and 401. Bounce reads to this session's OWN capability
  // URL (canonical path) so the whole graph rides the bearer prefix;
  // writes keep the direct editor-checked path.
  const user = await requireUser();
  if (!user) return new Response("Sign in to view this preview.", { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: p.id, workspace: accessibleWorkspaceWhere(user.id) } });
  if (!project) return new Response("Not found", { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) {
    return new Response("You can't view this preview.", { status: 403 });
  }
  if (READ_METHODS.has(req.method)) {
    const sbRow = await getDevSandboxRow(project.workspaceId, project.id);
    if (sbRow && sbRow.status === "running") {
      try {
        const issued = await issueOrRenewDevPreviewToken({
          workspaceId: project.workspaceId, projectId: project.id, port, sandboxId: sbRow.sandboxId, userId: user.id,
        });
        if (issued) {
          const rest = segs.map(encodeDevPreviewPathSegment).join("/");
          const to = `${devPreviewPath(project.id, port)}cap/${issued.raw}/${rest}${new URL(req.url).search}`;
          return Response.redirect(new URL(to, req.url), 302);
        }
      } catch {
        // Issuance failure must not break the fallback: proxy directly.
      }
    }
  }
  const canWrite = !!(await requireProjectRole(user.id, project.id, "editor"));
  return proxyDevPreview(req, { projectId: p.id, port: p.port, path: segs }, { workspaceId: project.workspaceId, canWrite });
}

export async function GET(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function HEAD(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function POST(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PUT(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PATCH(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function DELETE(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
