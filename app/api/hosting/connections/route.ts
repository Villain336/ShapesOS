// Marketr — hosting connections API (milestone 9).
//
// GET  /api/hosting/connections?projectId=… → { connections: [{ id, name, target, tokenHint, demo, createdAt }] }
// POST /api/hosting/connections { projectId, target: "vercel"|"cloudflare-pages"|"netlify", name, token, vercelProjectId?, teamId?, accountId?, projectName?, siteId?, demo? }
//   → { ok, connection: { id, name, target, mock } }
//
// Tokens are AES-256-GCM encrypted before storage (lib/deploy) and are never
// returned to the client — only a masked hint. The connection is tested
// before being saved; a failing test blocks creation.

import type { NextRequest } from "next/server";
import { DeployTargetType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { prisma } from "@/lib/prisma";
import {
  buildDeployTarget,
  decryptHostingConfig,
  deployTargetEnum,
  deployTargetSlug,
  encryptHostingConfig,
  maskedTokenHint,
} from "@/lib/deploy";

interface CreateBody {
  projectId?: string;
  target?: string;
  name?: string;
  token?: string;
  vercelProjectId?: string;
  teamId?: string;
  accountId?: string;
  projectName?: string;
  /** Phase 9: Netlify site id (optional). */
  siteId?: string;
  demo?: boolean;
}

function targetEnum(target: string): DeployTargetType {
  return DeployTargetType[deployTargetEnum(target)];
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  const project = await ownedProject(user.id, projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const conns = await prisma.hostingConnection.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
  });
  return Response.json({
    connections: conns.map((c) => {
      // demo flag is read server-side from the encrypted blob — the secret
      // itself never leaves the server.
      const demo = decryptHostingConfig(c).demo === true;
      return {
        id: c.id,
        name: c.name,
        target: deployTargetSlug(c.target),
        tokenHint: maskedTokenHint(c.configEnc),
        demo,
        createdAt: c.createdAt.toISOString(),
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody<CreateBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  // Milestone 11: storing hosting tokens is admin+ (editors can't touch secrets).
  if (!(await requireProjectRole(user.id, project.id, "admin"))) return forbidden();

  let target: DeployTargetType;
  try {
    target = targetEnum(String(body.target ?? ""));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Bad target" },
      { status: 400 },
    );
  }

  const name = (body.name ?? "").trim();
  if (!name) return Response.json({ error: "A connection name is required." }, { status: 400 });

  const demo = body.demo === true;
  const config: Record<string, unknown> = { demo };
  try {
    const token = (body.token ?? "").trim();
    let cfg: Record<string, unknown>;
    if (target === DeployTargetType.vercel) {
      cfg = { token, projectId: (body.vercelProjectId ?? "").trim(), teamId: (body.teamId ?? "").trim(), demo };
      if (!demo && !token) throw new Error("A Vercel token is required.");
    } else if (target === DeployTargetType.netlify) {
      cfg = { token, siteId: (body.siteId ?? "").trim(), demo };
      if (!demo && !token) throw new Error("A Netlify access token is required.");
    } else {
      cfg = { token, accountId: (body.accountId ?? "").trim(), projectName: (body.projectName ?? "").trim(), demo };
      if (!demo && (!token || !cfg.accountId)) throw new Error("A Cloudflare token and account id are required.");
    }
    await buildDeployTarget(deployTargetSlug(target), cfg).test();
    Object.assign(config, cfg);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Connection test failed" },
      { status: 502 },
    );
  }

  const conn = await prisma.hostingConnection.create({
    data: {
      projectId: project.id,
      name,
      target,
      configEnc: encryptHostingConfig(config),
    },
  });

  // Milestone 11: credential lifecycle is audit-logged (no secret material).
  await prisma.fileChangeLog.create({
    data: {
      projectId: project.id,
      filePath: "(connection)",
      actor: "user",
      action: "credential_created",
      summary: `${user.email ?? user.id} added hosting connection "${name}" (${body.target})`,
      approvedBy: user.id,
    },
  });

  return Response.json({
    ok: true,
    connection: { id: conn.id, name: conn.name, target: body.target, mock: demo },
  });
}
