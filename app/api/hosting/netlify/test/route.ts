// ShapesOS — Netlify connection test API (Phase 9; same contract as the
// Vercel / Cloudflare test routes).
// POST /api/hosting/netlify/test { projectId, token, siteId?, demo? }
//   → { ok, info, mock }
// The token is used for this single request and never stored here — it is
// only persisted (encrypted) when the connection is created.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { buildDeployTarget } from "@/lib/deploy";

interface TestBody {
  projectId?: string;
  token?: string;
  siteId?: string;
  demo?: boolean;
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody<TestBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "admin"))) return forbidden();

  try {
    const demo = body.demo === true;
    const target = buildDeployTarget("netlify", {
      token: (body.token ?? "").trim(),
      siteId: (body.siteId ?? "").trim(),
      demo,
    });
    const r = await target.test();
    return Response.json({ ok: r.ok, info: r.info, mock: demo });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Netlify test failed" },
      { status: 502 },
    );
  }
}
