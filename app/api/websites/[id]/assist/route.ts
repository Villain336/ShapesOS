// Marketr — site AI code assistant API (milestone 7).
// POST /api/websites/[id]/assist { projectId, path, files, message, history }
//   → { proposals: [{ path, summary, proposedContent }], explanation, llm }
//
// Identical contract to /api/sites/[id]/assist, but scoped to a Site: the
// assistant proposes against the site's working copy and proposals are logged
// with siteId. The AI NEVER writes files — the user applies each proposal
// through POST /api/websites/[id]/file with source="ai".

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getLlmProviderFor, llmStatus } from "@/lib/llm";
import { sanitizePath } from "@/lib/sitefiles/paths";
import { readJsonBody } from "@/lib/sitefiles/api";
import {
  buildPrompt,
  mockProposal,
  parseProposals,
  type AssistFile,
  type AssistMessage,
  type Proposal,
} from "@/lib/sitefiles/assist";
import { ownedSite } from "@/lib/connectors/source";

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

  const site = await ownedSite(user.id, body.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();

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
  const llm = getLlmProviderFor("bulk");
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

  await prisma.fileChangeLog.createMany({
    data: parsed.proposals.map((p) => ({
      projectId: site.projectId,
      siteId: site.id,
      connectionId: null,
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
