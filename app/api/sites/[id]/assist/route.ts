// Marketr — AI code assistant API (milestone 6, supervised rung).
// POST /api/sites/[id]/assist { projectId, path, files, message, history }
//   → { proposals: [{ path, summary, proposedContent }], explanation, llm }
//
// The AI NEVER writes files. It only proposes full-file replacements; the
// user must explicitly click "Apply" on each proposal (which goes through
// POST /api/sites/[id]/file with source="ai"). Every proposal is logged to
// the audit log with actor="ai" and approvedBy=null until applied.
//
// Shared prompt/parse/mock logic lives in lib/sitefiles/assist.ts (also used
// by the milestone-7 /api/websites/[id]/assist route).

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getLlmProviderFor, llmStatus } from "@/lib/llm";
import { getLlmProviderForWorkspace } from "@/lib/llm/workspace";
import { sanitizePath } from "@/lib/sitefiles/paths";
import { ownedConnection, readJsonBody } from "@/lib/sitefiles/api";
import {
  buildPrompt,
  mockProposal,
  parseProposals,
  type AssistFile,
  type AssistMessage,
  type Proposal,
} from "@/lib/sitefiles/assist";

interface AssistBody {
  projectId?: string;
  path?: string;
  files?: AssistFile[];
  message?: string;
  history?: AssistMessage[];
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await readJsonBody<AssistBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const connection = await ownedConnection(user.id, body.projectId, id);
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, connection.projectId, "editor"))) return forbidden();

  const message = (body.message ?? "").trim();
  if (!message) return Response.json({ error: "Message is required" }, { status: 400 });
  if (message.length > 4000) {
    return Response.json({ error: "Message too long" }, { status: 400 });
  }

  const files: { path: string; content: string }[] = [];
  for (const f of body.files ?? []) {
    try {
      const path = sanitizePath(f.path);
      const content = typeof f.content === "string" ? f.content : "";
      if (content.length > 60000) continue;
      files.push({ path, content });
    } catch {
      /* skip invalid */
    }
  }
  if (files.length === 0) {
    return Response.json(
      { error: "Open a file first so the assistant has context" },
      { status: 400 },
    );
  }

  const history = (body.history ?? [])
    .filter((h) => h && typeof h.text === "string")
    .slice(-8)
    .map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      text: (h.text as string).slice(0, 2000),
    }));

  // Phase D: structured file-change proposals → "bulk" workload.
  // Phase 15: the workspace's own model key when it has one; metered by tokens.
  const llmProject = await prisma.project.findUnique({ where: { id: connection.projectId }, select: { workspaceId: true } });
  const llm = llmProject
    ? await getLlmProviderForWorkspace("bulk", { workspaceId: llmProject.workspaceId, projectId: connection.projectId, actorId: user.id })
    : getLlmProviderFor("bulk");
  let parsed: { proposals: Proposal[]; explanation: string };

  if (!llm.isLive) {
    const openPath = (() => {
      try {
        return sanitizePath(body.path);
      } catch {
        return files[0].path;
      }
    })();
    const openContent =
      files.find((f) => f.path === openPath)?.content ?? files[0].content;
    parsed = mockProposal(openPath, openContent);
  } else {
    const prompt = buildPrompt(message, files, history);
    let raw: string;
    try {
      raw = await llm.generate(prompt);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "LLM request failed" },
        { status: 502 },
      );
    }
    parsed = parseProposals(raw);
  }

  if (parsed.proposals.length === 0) {
    return Response.json({
      proposals: [],
      explanation:
        parsed.explanation ||
        "The assistant didn't propose any file changes. Try rephrasing your request.",
      llm: llmStatus(),
    });
  }

  // Log every proposal (supervised rung: proposed ≠ applied).
  await prisma.fileChangeLog.createMany({
    data: parsed.proposals.map((p) => ({
      projectId: connection.projectId,
      connectionId: connection.id,
      filePath: p.path,
      actor: "ai" as const,
      action: "ai_proposal" as const,
      summary: p.summary.slice(0, 280),
      approvedBy: null,
    })),
  });

  return Response.json({
    proposals: parsed.proposals,
    explanation: parsed.explanation,
    llm: llmStatus(),
  });
}
