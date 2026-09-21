// Marketr — AI code assistant API (milestone 6, supervised rung).
// POST /api/sites/[id]/assist { projectId, path, files, message, history }
//   → { proposals: [{ path, summary, proposedContent }], explanation, llm }
//
// The AI NEVER writes files. It only proposes full-file replacements; the
// user must explicitly click "Apply" on each proposal (which goes through
// POST /api/sites/[id]/file with source="ai"). Every proposal is logged to
// the audit log with actor="ai" and approvedBy=null until applied.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getLlmProvider, llmStatus } from "@/lib/llm";
import { sanitizePath } from "@/lib/sitefiles/paths";
import { ownedConnection, readJsonBody } from "@/lib/sitefiles/api";

export interface AssistFile {
  path?: string;
  content?: string;
}

export interface AssistMessage {
  role?: string;
  text?: string;
}

interface AssistBody {
  projectId?: string;
  path?: string;
  files?: AssistFile[];
  message?: string;
  history?: AssistMessage[];
}

export interface Proposal {
  path: string;
  summary: string;
  proposedContent: string;
}

function buildPrompt(
  message: string,
  files: { path: string; content: string }[],
  history: { role: string; text: string }[],
): string {
  const historyText = history
    .slice(-8)
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`)
    .join("\n");

  const filesText = files
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 20000)}`)
    .join("\n\n");

  return [
    "You are a senior web developer helping edit a client's website inside an IDE.",
    "The user can see your proposals and must approve each one before anything is written.",
    "",
    historyText ? `Conversation so far:\n${historyText}\n` : "",
    "Open files (full contents):",
    filesText,
    "",
    `User request: "${message}"`,
    "",
    "Propose changes as FULL file replacements — one fenced block per changed file, exactly like this:",
    "```path:/public_html/index.php",
    "<the entire new file content>",
    "```",
    "Rules:",
    "- Only include files you actually change.",
    "- Keep changes minimal, safe, and syntactically valid. Never invent secrets or credentials.",
    "- After the fenced blocks, write a short explanation of what you changed and why.",
    "- For each changed file, add one line: SUMMARY /path/to/file: one-line description",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseProposals(raw: string): {
  proposals: Proposal[];
  explanation: string;
} {
  const proposals: Proposal[] = [];
  const summaries = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const m = line.match(/^SUMMARY\s+(\S+)\s*:\s*(.+)$/i);
    if (m) {
      try {
        summaries.set(sanitizePath(m[1]), m[2].trim());
      } catch {
        /* ignore bad paths */
      }
    }
  }

  const fenceRe = /```path:([^\n`]+)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  const explanationParts: string[] = [];
  let lastEnd = 0;
  while ((match = fenceRe.exec(raw)) !== null) {
    explanationParts.push(raw.slice(lastEnd, match.index));
    lastEnd = match.index + match[0].length;
    try {
      const path = sanitizePath(match[1].trim());
      proposals.push({
        path,
        summary:
          summaries.get(path) ?? `Proposed changes to ${path}`,
        proposedContent: match[2].replace(/\n$/, ""),
      });
    } catch {
      /* skip invalid paths */
    }
  }
  explanationParts.push(raw.slice(lastEnd));
  const explanation = explanationParts
    .join(" ")
    .replace(/SUMMARY\s+\S+\s*:.+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  return { proposals, explanation };
}

/** Deterministic canned proposal for the mock LLM so the flow is testable. */
function mockProposal(
  openPath: string,
  openContent: string,
): { proposals: Proposal[]; explanation: string } {
  const note =
    "Mock proposal — generated without an LLM. Set LLM_API_KEY for real AI assistance.";
  if (
    /<head[^>]*>/i.test(openContent) &&
    !/name=["']description["']/i.test(openContent)
  ) {
    const proposed = openContent.replace(
      /<head[^>]*>/i,
      (m) =>
        `${m}\n  <meta name="description" content="Acme Plumbing — leaks, water heaters, and drain cleaning across the Triad. Free quotes.">`,
    );
    return {
      proposals: [
        {
          path: openPath,
          summary: "Mock proposal: add SEO meta description (demo only)",
          proposedContent: proposed,
        },
      ],
      explanation: note,
    };
  }
  const comment = openPath.endsWith(".css")
    ? "/* AI suggestion (mock): reviewed demo change */\n"
    : openPath.endsWith(".php")
      ? "// AI suggestion (mock): reviewed demo change\n"
      : "<!-- AI suggestion (mock): reviewed demo change -->\n";
  return {
    proposals: [
      {
        path: openPath,
        summary: "Mock proposal: add review marker comment (demo only)",
        proposedContent: comment + openContent,
      },
    ],
    explanation: note,
  };
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

  const llm = getLlmProvider();
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
