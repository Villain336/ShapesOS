// Marketr — Phase 10 M3 API: trigger a panel run.
// POST /api/intelligence/geo/run { panelId, engines?, brand } (editor+)
//
// Runs are long (prompts × reps × engines, official APIs). The run executes
// in the background; the response returns the run id immediately. Progress
// is read back via /api/intelligence/geo/summary (latestRunAt / runCount).

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { runPanel, type GeoEngine } from "@/lib/intelligence/geo/runner";
import { GEO_ENGINES } from "@/lib/intelligence/geo/panels";

export const dynamic = "force-dynamic";

// In-flight runs, keyed by run id. Process-local by design — the keeper and
// the scheduler own durability; this is an operator trigger, not a queue.
const inFlight = new Map<string, Promise<unknown>>();

export function inFlightGeoRuns(): string[] {
  return [...inFlight.keys()];
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const panelId = typeof body.panelId === "string" ? body.panelId : "";
  const brand = typeof body.brand === "string" ? body.brand.trim() : "";
  if (!panelId) return Response.json({ error: "panelId is required." }, { status: 400 });
  if (!brand) return Response.json({ error: "brand is required (brand matching needs a name)." }, { status: 400 });
  const engines = Array.isArray(body.engines)
    ? (body.engines.filter((e): e is GeoEngine => GEO_ENGINES.includes(e as GeoEngine)))
    : undefined;

  const runId = `georun_${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  const promise = runPanel(workspace.id, panelId, { engines, brand, runId })
    .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      inFlight.delete(runId);
    });
  inFlight.set(runId, promise);

  return Response.json(
    {
      started: true,
      runId,
      panelId,
      engines: engines ?? [...GEO_ENGINES],
      startedAt,
      note: "Run executing in background against official LLM APIs (BYO keys). Unconfigured engines are skipped, never faked. Poll /api/intelligence/geo/summary for results.",
    },
    { status: 202 },
  );
}
