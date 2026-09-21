// Marketr — hosting connections API (milestone 9).
//
// GET  /api/hosting/connections?projectId=… → { connections: [{ id, name, target, tokenHint, demo, createdAt }] }
// POST /api/hosting/connections { projectId, target: "vercel"|"cloudflare-pages", name, token, projectId?, teamId?, accountId?, projectName?, demo? }
//   → { ok, connection: { id, name, target, mock } }
//
// Tokens are AES-256-GCM encrypted before storage (lib/deploy) and are never
// returned to the client — only a masked hint. The connection is tested
// before being saved; a failing test blocks creation.

import type { NextRequest } from "next/server";
import { DeployTargetType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { prisma } from "@/lib/prisma";
import {
  decryptHostingConfig,
  encryptHostingConfig,
  maskedTokenHint,
} from "@/lib/deploy";
import { VercelDeployTarget } from "@/lib/deploy/vercel";
import { CloudflarePagesDeployTarget } from "@/lib/deploy/cloudflare";
import { MockVercelDeployTarget } from "@/lib/deploy/mock-vercel";
import { MockCloudflarePagesDeployTarget } from "@/lib/deploy/mock-cloudflare";

interface CreateBody {
  projectId?: string;
  target?: string;
  name?: string;
  token?: string;
  vercelProjectId?: string;
  teamId?: string;
  accountId?: string;
  projectName?: string;
  demo?: boolean;
}

function targetEnum(target: string): DeployTargetType {
  if (target === "vercel") return DeployTargetType.vercel;
  if (target === "cloudflare-pages") return DeployTargetType.cloudflare_pages;
  throw new Error(`Unknown deploy target "${target}".`);
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
        target: c.target === DeployTargetType.vercel ? "vercel" : "cloudflare-pages",
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
    if (target === DeployTargetType.vercel) {
      const cfg = {
        token: (body.token ?? "").trim(),
        projectId: (body.vercelProjectId ?? "").trim(),
        teamId: (body.teamId ?? "").trim(),
        demo,
      };
      if (!demo && !cfg.token) throw new Error("A Vercel token is required.");
      const t = demo ? new MockVercelDeployTarget(cfg) : new VercelDeployTarget(cfg);
      await t.test();
      Object.assign(config, cfg);
    } else {
      const cfg = {
        token: (body.token ?? "").trim(),
        accountId: (body.accountId ?? "").trim(),
        projectName: (body.projectName ?? "").trim(),
        demo,
      };
      if (!demo && (!cfg.token || !cfg.accountId))
        throw new Error("A Cloudflare token and account id are required.");
      const t = demo
        ? new MockCloudflarePagesDeployTarget(cfg)
        : new CloudflarePagesDeployTarget(cfg);
      await t.test();
      Object.assign(config, cfg);
    }
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

  return Response.json({
    ok: true,
    connection: { id: conn.id, name: conn.name, target: body.target, mock: demo },
  });
}
