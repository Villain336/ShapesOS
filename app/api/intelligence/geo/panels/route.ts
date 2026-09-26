// Marketr — Phase 10 M3 API: versioned prompt panels.
// GET  /api/intelligence/geo/panels?engine=openai → panel versions (viewer+)
// POST /api/intelligence/geo/panels → create frozen panel version (editor+)

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import {
  createPanel,
  listPanels,
  GEO_ENGINES,
  type GeoEngine,
} from "@/lib/intelligence/geo/panels";

export const dynamic = "force-dynamic";

async function ctx(min: "viewer" | "editor") {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!membership) return { error: forbidden() };
  return { user, workspace };
}

export async function GET(req: Request) {
  const c = await ctx("viewer");
  if (c.error) return c.error;
  const engine = new URL(req.url).searchParams.get("engine") as GeoEngine | null;
  const panels = await listPanels(
    c.workspace.id,
    engine && GEO_ENGINES.includes(engine) ? engine : undefined,
  );
  return Response.json({ panels });
}

export async function POST(req: Request) {
  const c = await ctx("editor");
  if (c.error) return c.error;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    const panel = await createPanel(c.workspace.id, {
      engine: body.engine as GeoEngine,
      prompts: body.prompts as unknown[],
      cadence: typeof body.cadence === "string" ? body.cadence : "weekly",
      nReps: typeof body.nReps === "number" ? body.nReps : 3,
      createdBy: c.user.id,
    });
    return Response.json({ panel }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Panel creation failed." },
      { status: 400 },
    );
  }
}
