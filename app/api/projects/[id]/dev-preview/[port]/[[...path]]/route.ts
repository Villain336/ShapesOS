// ShapesOS — /api/projects/[id]/dev-preview/[port]/[...path]: authenticated
// proxy into the project's persistent dev sandbox. Session-only; viewer+ to
// look, editor+ to write; never wakes a paused sandbox (the browser panel's
// explicit Resume does that through /dev-sandbox POST).
//
// Auth: the session opens the first document request, which also issues a
// path-scoped HMAC capability cookie (lib/sandbox/dev-preview-cookie.ts).
// The CSP sandbox makes the preview document an opaque origin, so the app's
// own subresource requests arrive WITHOUT the Lax session cookie (observed
// in a real-browser harness) and authenticate on the capability instead -
// read-only, one project, one port, one hour. The route re-checks the
// claims against the project's actual workspace on every request.

import { NextRequest } from "next/server";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { proxyDevPreview } from "@/lib/sandbox/dev-preview-proxy";
import {
  DEV_PREVIEW_COOKIE,
  devPreviewSetCookie,
  signDevPreviewToken,
  verifyDevPreviewToken,
} from "@/lib/sandbox/dev-preview-cookie";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; port: string; path?: string[] }> };

const READ_METHODS = new Set(["GET", "HEAD"]);

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const enabled = process.env.SHAPES_DEV_PREVIEW === "1" || req.cookies.get("shapes_dev_preview")?.value === "1";
  if (!enabled) return new Response("Not found", { status: 404 });
  const p = await ctx.params;
  const port = Number(p.port);

  const user = await requireUser();
  if (!user) {
    // Capability path: read-only, still rebound to the project's workspace.
    const claims = verifyDevPreviewToken(req.cookies.get(DEV_PREVIEW_COOKIE)?.value, p.id, port);
    if (!claims) return new Response("Sign in to view this preview.", { status: 401 });
    const project = await prisma.project.findFirst({ where: { id: p.id } });
    if (!project || project.workspaceId !== claims.workspaceId) return new Response("Not found", { status: 404 });
    if (!READ_METHODS.has(req.method)) return new Response("Sign in to write to this preview.", { status: 401 });
    return proxyDevPreview(req, { projectId: p.id, port: p.port, path: p.path }, { workspaceId: claims.workspaceId, canWrite: false });
  }

  const project = await prisma.project.findFirst({ where: { id: p.id, workspace: accessibleWorkspaceWhere(user.id) } });
  if (!project) return new Response("Not found", { status: 404 });
  const canWrite = !!(await requireProjectRole(user.id, project.id, "editor"));
  if (!canWrite && !(await requireProjectRole(user.id, project.id, "viewer"))) {
    return new Response("You can't view this preview.", { status: 403 });
  }
  const res = await proxyDevPreview(req, { projectId: p.id, port: p.port, path: p.path }, { workspaceId: project.workspaceId, canWrite });
  // Issue/refresh the capability on successful session-authenticated reads so
  // the sandboxed document's own subresources can authenticate.
  if (READ_METHODS.has(req.method) && res.status === 200 && Number.isFinite(port)) {
    const token = signDevPreviewToken({
      projectId: p.id,
      port,
      userId: user.id,
      workspaceId: project.workspaceId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    if (token) res.headers.append("set-cookie", devPreviewSetCookie(token, p.id, port));
  }
  return res;
}

export async function GET(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function HEAD(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function POST(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PUT(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PATCH(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function DELETE(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
