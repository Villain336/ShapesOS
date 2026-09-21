// Marketr — Vercel connection test API (milestone 9).
// POST /api/hosting/vercel/test { projectId, token, projectId?, teamId?, demo? }
//   → { ok, info, mock }
// The token is used for this single request and never stored here — it is
// only persisted (encrypted) when the connection is created.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { VercelDeployTarget } from "@/lib/deploy/vercel";
import { MockVercelDeployTarget } from "@/lib/deploy/mock-vercel";

interface TestBody {
  projectId?: string;
  token?: string;
  vercelProjectId?: string;
  teamId?: string;
  demo?: boolean;
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody<TestBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  try {
    const demo = body.demo === true;
    const cfg = {
      token: (body.token ?? "").trim(),
      projectId: (body.vercelProjectId ?? "").trim(),
      teamId: (body.teamId ?? "").trim(),
      demo,
    };
    const target = demo ? new MockVercelDeployTarget(cfg) : new VercelDeployTarget(cfg);
    const r = await target.test();
    return Response.json({ ok: r.ok, info: r.info, mock: demo });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Vercel test failed" },
      { status: 502 },
    );
  }
}
