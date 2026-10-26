// ShapesOS — /api/projects/[id]/dev-preview/[port]/[...path]: authenticated
// proxy into the project's persistent dev sandbox. Session-only; viewer+ to
// look, editor+ to write; never wakes a paused sandbox (the browser panel's
// explicit Resume does that through /dev-sandbox POST).

import { NextRequest } from "next/server";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { proxyDevPreview } from "@/lib/sandbox/dev-preview-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; port: string; path?: string[] }> };

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const enabled = process.env.SHAPES_DEV_PREVIEW === "1" || req.cookies.get("shapes_dev_preview")?.value === "1";
  if (!enabled) return new Response("Not found", { status: 404 });
  const user = await requireUser();
  if (!user) return new Response("Sign in to view this preview.", { status: 401 });
  const { id } = await ctx.params;
  const project = await prisma.project.findFirst({ where: { id, workspace: accessibleWorkspaceWhere(user.id) } });
  if (!project) return new Response("Not found", { status: 404 });
  const canWrite = !!(await requireProjectRole(user.id, project.id, "editor"));
  if (!canWrite && !(await requireProjectRole(user.id, project.id, "viewer"))) {
    return new Response("You can't view this preview.", { status: 403 });
  }
  const p = await ctx.params;
  return proxyDevPreview(req, { projectId: p.id, port: p.port, path: p.path }, { workspaceId: project.workspaceId, canWrite });
}

export async function GET(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function HEAD(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function POST(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PUT(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function PATCH(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
export async function DELETE(req: NextRequest, ctx: Ctx) { return handle(req, ctx); }
