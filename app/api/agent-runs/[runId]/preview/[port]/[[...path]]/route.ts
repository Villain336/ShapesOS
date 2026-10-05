// ShapesOS — Phase 8: preview of a dev server running in a run's sandbox.
// ANY /api/agent-runs/[runId]/preview/[port]/[...path] → the sandbox's port
//
// Authenticated proxy (lib/sandbox/preview-proxy.ts): previews are never
// public. Signed-in members of the run's workspace may look (viewer+ —
// requireWorkspaceRole); POST/PUT/PATCH/DELETE need editor+ or the person who
// started the run. Only ports the run exposed, only its own sandbox's
// allow-listed upstream (safe-url checked for hosted providers), the app's
// cookies never forwarded, and the page runs under CSP sandbox.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { proxyPreview } from "@/lib/sandbox/preview-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string; port: string; path?: string[] }> };

async function handle(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const user = await requireUser();
    return await proxyPreview(req, await params, {
      user: user ? { id: user.id, email: user.email } : null,
      workspaceFor: (u) => getOrCreateWorkspace(u.id, u.email),
      // viewer+ to look; POST/PUT/PATCH/DELETE: editor+ or the run's starter.
      requireRole: requireWorkspaceRole,
    });
  } catch (err) {
    return errorResponse(err, "/api/agent-runs/[runId]/preview");
  }
}

export async function GET(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}
export async function HEAD(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}
export async function POST(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}
export async function PUT(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}
export async function DELETE(req: Request, ctx: Ctx) {
  return handle(req, ctx);
}
