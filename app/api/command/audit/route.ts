// Marketr — Phase 9 M3: command-bar audit sink.
//
// POST /api/command/audit — append-only writer for command-bar invocations.
// The client never touches the DB directly: this route resolves the user and
// workspace from the session (same guard contract as the dashboard layout —
// requireUser + getOrCreateWorkspace) and delegates to logCommand() from
// lib/orchestrator/audit, which hashes templated prompts and stores free-form
// ask prompts in full. The audit log is the source of truth for what the user
// did via the bar (docs/specs/SPEC-PHASE9.md §P9B).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { logCommand, type CommandKindName } from "@/lib/orchestrator/audit";

export const dynamic = "force-dynamic";

const VALID_KINDS: CommandKindName[] = ["template", "ask", "go", "do"];

interface AuditBody {
  kind?: unknown;
  templateId?: unknown;
  prompt?: unknown;
  resultSummary?: unknown;
}

export async function POST(req: Request) {
  const user = await requireUser();
  // requireUser() only returns non-null when session.user.id is set; the
  // explicit guard below narrows the next-auth User type for tsc.
  if (!user || !user.id) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Members (any role) may log their own command-bar usage.
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer")))
    return Response.json({ error: "Forbidden" }, { status: 403 });

  let body: AuditBody;
  try {
    body = (await req.json()) as AuditBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const kindRaw = body.kind;
  if (typeof kindRaw !== "string" || !(VALID_KINDS as readonly string[]).includes(kindRaw)) {
    return Response.json({ error: "kind must be one of: template, ask, go, do." }, { status: 400 });
  }
  const kind = kindRaw as CommandKindName;

  try {
    const { id } = await logCommand({
      workspaceId: workspace.id,
      userId: user.id,
      kind,
      templateId: typeof body.templateId === "string" ? body.templateId : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      resultSummary: typeof body.resultSummary === "string" ? body.resultSummary : undefined,
    });
    return Response.json({ id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to write audit entry." },
      { status: 400 },
    );
  }
}
