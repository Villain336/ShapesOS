// Marketr — Webflow connection test API (milestone 8).
// POST /api/websites/webflow/test { projectId, token, demo? }
//   → { ok, info, mock, sites? }
// The API token is used for this single request and never stored here — it
// is only persisted (encrypted) when the site is created.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { WebflowConnector } from "@/lib/connectors/webflow";
import { MockWebflowConnector } from "@/lib/connectors/mock-webflow";

interface TestBody {
  projectId?: string;
  token?: string;
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
    const cfg = { token: (body.token ?? "").trim(), siteId: "", demo };
    const connector = demo
      ? new MockWebflowConnector(cfg)
      : new WebflowConnector(cfg);
    const r = await connector.test();
    const sites =
      "listSites" in connector
        ? await (connector as { listSites(): Promise<unknown[]> }).listSites()
        : [];
    return Response.json({ ok: r.ok, info: r.info, mock: demo, sites });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Webflow test failed" },
      { status: 502 },
    );
  }
}
