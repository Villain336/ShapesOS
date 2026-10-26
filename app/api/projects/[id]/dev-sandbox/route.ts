// ShapesOS — /api/projects/[id]/dev-sandbox: status + explicit lifecycle for
// the project's persistent dev sandbox (in-product browser "Dev preview" v1).
// GET is viewer+; POST (ensure/resume - the ONLY wake path, never
// traffic-driven) and DELETE (pause) are editor+. Preview-flag gated.

import { NextRequest } from "next/server";
import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ensureDevSandbox, getDevSandboxRow, pauseDevSandbox, devSandboxSpendAllowed, DEV_SANDBOX_DEFAULT_TTL_SECONDS } from "@/lib/sandbox/dev-sandbox";
import { issueOrRenewDevPreviewToken, revokeDevPreviewTokens } from "@/lib/sandbox/dev-preview-token";
import { devPreviewPath } from "@/lib/sandbox/dev-preview-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function previewEnabled(req: NextRequest): boolean {
  return process.env.SHAPES_DEV_PREVIEW === "1" || req.cookies.get("shapes_dev_preview")?.value === "1";
}

async function load(req: NextRequest, ctx: Ctx, role: "viewer" | "editor") {
  if (!previewEnabled(req)) return { error: Response.json({ error: "Not found" }, { status: 404 }) };
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const { id } = await ctx.params;
  const project = await prisma.project.findFirst({ where: { id, workspace: accessibleWorkspaceWhere(user.id) } });
  if (!project) return { error: Response.json({ error: "Not found" }, { status: 404 }) };
  if (!(await requireProjectRole(user.id, project.id, role))) return { error: forbidden() };
  return { user, project };
}

function shape(row: Awaited<ReturnType<typeof getDevSandboxRow>>, projectId: string) {
  return {
    projectId,
    status: row?.status ?? "none",
    ttlSeconds: row?.ttlSeconds ?? DEV_SANDBOX_DEFAULT_TTL_SECONDS,
    exposedPorts: row?.exposedPorts ?? [],
    provider: row?.provider ?? null,
    createdAt: row?.createdAt ?? null,
    pausedAt: row?.pausedAt ?? null,
  };
}

/** GET — current dev-sandbox status for the browser panel. While the
 * sandbox runs, also issues/renews this session's read-only capability
 * URLs (one per exposed port): idempotent - the SAME raw token is re-served
 * while it lives (sliding expiry renewed HERE, never by bearer requests),
 * so an open pane's iframe src stays stable and never reloads for renewal. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const r = await load(req, ctx, "viewer");
  if ("error" in r) return r.error;
  const row = await getDevSandboxRow(r.project.workspaceId, r.project.id);
  const previews: { port: number; url: string }[] = [];
  if (row && row.status === "running") {
    for (const port of row.exposedPorts) {
      try {
        const t = await issueOrRenewDevPreviewToken({
          workspaceId: r.project.workspaceId,
          projectId: r.project.id,
          port,
          sandboxId: row.sandboxId,
          userId: r.user.id,
        });
        if (t) previews.push({ port, url: `${devPreviewPath(r.project.id, port)}cap/${t.raw}/` });
      } catch {
        // Token issuance must not break the status read itself.
        console.warn("[dev-sandbox] preview token issuance failed for a port");
      }
    }
  }
  return Response.json({ ...shape(row, r.project.id), previews });
}

/** POST — ensure running: create on first open, resume when paused. This
 * SPENDS (compute time), so it needs the spend gate, never the flag alone.
 * NO spend grant exists (checked 2026-10-26): both gates REQUIRE a prior
 * explicit owner grant and stay unset until one is given. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const r = await load(req, ctx, "editor");
  if ("error" in r) return r.error;
  const spend = devSandboxSpendAllowed();
  if (!spend.allowed || !spend.bounds) {
    return Response.json(
      { error: "Dev previews that run compute aren't enabled for this workspace yet." },
      { status: 403 },
    );
  }
  const result = await ensureDevSandbox(r.project.workspaceId, r.project.id, { bounds: spend.bounds });
  if (!result.ok) return Response.json({ error: result.reason }, { status: 503 });
  return Response.json({ ...shape(result.row, r.project.id), woke: result.woke });
}

/** DELETE — pause now (billing stops at the pause). Revokes live preview
 * tokens with it: a paused pane's URLs die immediately, not at expiry. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const r = await load(req, ctx, "editor");
  if ("error" in r) return r.error;
  await revokeDevPreviewTokens(r.project.workspaceId, r.project.id).catch(() => undefined);
  const result = await pauseDevSandbox(r.project.workspaceId, r.project.id);
  if (!result.ok) return Response.json({ error: result.reason }, { status: 409 });
  return Response.json({ ok: true });
}
