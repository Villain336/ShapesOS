// Marketr — shared AI code-assistant logic (milestone 6, reused by 7).
//
// The assistant NEVER writes files. It proposes full-file replacements; the
// caller logs each proposal and the user must explicitly apply it through the
// file-write endpoint (source="ai"). Used by /api/sites/[id]/assist and
// /api/websites/[id]/assist identically.

import { sanitizePath } from "./paths";

export interface AssistFile {
  path?: string;
  content?: string;
}

export interface AssistMessage {
  role?: string;
  text?: string;
}

export interface Proposal {
  path: string;
  summary: string;
  proposedContent: string;
}

export function buildPrompt(
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

export function parseProposals(raw: string): {
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
        summary: summaries.get(path) ?? `Proposed changes to ${path}`,
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
export function mockProposal(
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
