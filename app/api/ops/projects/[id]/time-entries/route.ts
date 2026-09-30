// Marketr — Phase 17 slice 4: /api/ops/projects/[id]/time-entries.
//   GET  → the project's time ledger (viewer+)
//   POST → log a time entry: { minutes, description?, actor?, occurredAt? } (editor+)
// Minutes are integers; the UI converts hours ↔ minutes.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listTimeEntries, logTimeEntry } from "@/lib/ops/projects";
import { OpsError } from "@/lib/ops/doctype";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  try {
    const { id } = await params;
    const actor = { workspaceId: workspace.id, userId: user.id };
    const entries = await withWorkspaceScope(workspace.id, (tx) => listTimeEntries(tx, actor, id));
    return Response.json({ entries });
  } catch (err) {
    if (err instanceof OpsError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      minutes?: unknown;
      description?: unknown;
      actor?: unknown;
      occurredAt?: unknown;
    };
    const actor = { workspaceId: workspace.id, userId: user.id };
    const entry = await withWorkspaceScope(workspace.id, (tx) =>
      logTimeEntry(tx, actor, id, {
        minutes: typeof body.minutes === "number" ? body.minutes : NaN,
        description: typeof body.description === "string" ? body.description : undefined,
        actor: typeof body.actor === "string" ? body.actor : undefined,
        occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
      }),
    );
    return Response.json({ entry });
  } catch (err) {
    if (err instanceof OpsError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
