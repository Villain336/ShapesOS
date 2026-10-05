// Marketr — Repurpose API (Phase 12).
// POST /api/content/repurpose  { topic, format, topK? }
//   → { format, topic, asset, sources, mock }
// Turns expert-corpus knowledge into derivative assets (brief, video script,
// social thread, newsletter section). The corpus is a workspace-agnostic
// product asset; any workspace viewer may repurpose from it.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { readJson } from "@/lib/enrichment/guard";
import { repurposeContent, REPURPOSE_FORMATS, workspaceRepurposeDeps } from "@/lib/content/repurpose";
import { captureEpisode } from "@/lib/agents/learning/capture";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { topic?: string; format?: string; topK?: number };
  try {
    body = (await readJson(req)) as { topic?: string; format?: string; topK?: number };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const format = REPURPOSE_FORMATS.find((f) => f.id === body.format);
  if (!format) {
    return NextResponse.json(
      { error: `format must be one of: ${REPURPOSE_FORMATS.map((f) => f.id).join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const result = await repurposeContent(
      {
        topic: body.topic ?? "",
        format: format.id,
        topK: body.topK,
      },
      await workspaceRepurposeDeps(workspace.id, user.id),
    );
    // Phase 13B: episode capture — fail-soft, never breaks the response.
    void captureEpisode({
      workspaceId: workspace.id,
      agentId: "content-brief",
      promptSummary: `Repurpose "${body.topic ?? ""}" as ${format.id}`,
      outputSummary: `Repurposed asset generated (${result.asset?.length ?? 0} chars, ${result.sources?.length ?? 0} sources).`,
      outcome: "repurpose_generated",
      refs: { format: format.id, topic: body.topic ?? "" },
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Repurpose failed";
    const status = message.includes("required") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
