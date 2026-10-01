// Marketr — Wave 2 context.dev slice 3: research API.
// GET /api/knowledge/contextdev/research — recent research tasks.
// POST — run a research task (governed run_research: budget-gated before
// the vendor, citation contract enforced, never silent).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  runResearch,
  listResearchTasks,
  ResearchError,
  RESEARCH_MODES,
  DEFAULT_RESEARCH_MODE,
} from "@/lib/knowledge/contextdev/research";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const tasks = await listResearchTasks(workspace.id);
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { question?: string; jsonFormat?: unknown; mode?: string; locale?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.question?.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }
  if (!body.jsonFormat || typeof body.jsonFormat !== "object" || Array.isArray(body.jsonFormat)) {
    return NextResponse.json(
      { error: "jsonFormat must be a non-array object describing the answer shape" },
      { status: 400 },
    );
  }
  const mode = body.mode ?? DEFAULT_RESEARCH_MODE;
  if (!RESEARCH_MODES.includes(mode as never)) {
    return NextResponse.json(
      { error: `mode must be one of: ${RESEARCH_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const task = await runResearch(workspace.id, {
      question: body.question,
      jsonFormat: body.jsonFormat as Record<string, unknown>,
      mode: mode as "fast" | "ultra",
      locale: body.locale,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    if (err instanceof ResearchError) {
      const status =
        err.code === "BUDGET_EXCEEDED"
          ? 402
          : err.code === "NO_SOURCES"
            ? 502
            : err.code === "BAD_QUESTION" || err.code === "BAD_SHAPE" || err.code === "BAD_MODE"
              ? 400
              : 502;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }
}
