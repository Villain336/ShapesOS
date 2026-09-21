// Marketr — WordPress connection test API (milestone 8).
// POST /api/websites/wordpress/test { projectId, baseUrl, username, appPassword, demo? }
//   → { ok, info, mock }
// The application password is used for this single request and never stored
// here — it is only persisted (encrypted) when the site is created.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { WordPressConnector } from "@/lib/connectors/wordpress";
import { MockWordPressConnector } from "@/lib/connectors/mock-wordpress";

interface TestBody {
  projectId?: string;
  baseUrl?: string;
  username?: string;
  appPassword?: string;
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
    const cfg = {
      baseUrl: (body.baseUrl ?? "").trim().replace(/\/+$/, ""),
      username: (body.username ?? "").trim(),
      appPassword: (body.appPassword ?? "").replace(/\s+/g, ""),
      demo: body.demo === true,
    };
    const connector = cfg.demo
      ? new MockWordPressConnector(cfg)
      : new WordPressConnector(cfg);
    const r = await connector.test();
    return Response.json({ ok: r.ok, info: r.info, mock: cfg.demo });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "WordPress test failed" },
      { status: 502 },
    );
  }
}
