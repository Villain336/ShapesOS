// Marketr — R4: review-site configuration.
// GET  /api/review-config → workspace's site configs
// POST /api/review-config (editor+) → upsert one site config
//   { site: "google"|"facebook"|"yelp"|"custom", reviewUrl, delayDays?, enabled? }

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { getReviewConfig, upsertReviewConfig, ReviewEngineError } from "@/lib/reviews/engine";

const UpsertSchema = z.object({
  site: z.enum(["google", "facebook", "yelp", "custom"]),
  reviewUrl: z.string().trim().min(1).max(2048),
  delayDays: z.number().int().min(0).max(90).optional(),
  enabled: z.boolean().optional(),
});

async function guard(reqRole: "viewer" | "editor" = "viewer") {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) as Response };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, reqRole))) {
    return { error: forbidden() as Response };
  }
  return { user, workspace };
}

export async function GET() {
  const g = await guard("viewer");
  if (g.error) return g.error;
  const configs = await getReviewConfig(g.workspace!.id);
  return Response.json({ configs, workspaceId: g.workspace!.id });
}

export async function POST(req: Request) {
  const g = await guard("editor");
  if (g.error) return g.error;

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = UpsertSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const config = await upsertReviewConfig(g.workspace!.id, parsed.data);
    return Response.json({ config }, { status: 200 });
  } catch (e) {
    if (e instanceof ReviewEngineError) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
}
