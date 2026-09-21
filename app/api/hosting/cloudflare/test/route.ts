// Marketr — Cloudflare Pages connection test API (milestone 9).
// POST /api/hosting/cloudflare/test { projectId, token, accountId, projectName?, demo? }
//   → { ok, info, mock }
// The token is used for this single request and never stored here — it is
// only persisted (encrypted) when the connection is created.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { CloudflarePagesDeployTarget } from "@/lib/deploy/cloudflare";
import { MockCloudflarePagesDeployTarget } from "@/lib/deploy/mock-cloudflare";

interface TestBody {
  projectId?: string;
  token?: string;
  accountId?: string;
  projectName?: string;
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
    const cfg = {
      token: (body.token ?? "").trim(),
      accountId: (body.accountId ?? "").trim(),
      projectName: (body.projectName ?? "").trim(),
      demo,
    };
    const target = demo
      ? new MockCloudflarePagesDeployTarget(cfg)
      : new CloudflarePagesDeployTarget(cfg);
    const r = await target.test();
    return Response.json({ ok: r.ok, info: r.info, mock: demo });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Cloudflare test failed" },
      { status: 502 },
    );
  }
}
