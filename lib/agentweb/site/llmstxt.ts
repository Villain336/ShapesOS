// ShapesOS — Phase 21A (WS=agentweb): llms.txt (PURE).
//
// The llmstxt.org format: an H1 title, a blockquote summary, optional prose, then
// H2 sections of "- [title](url): notes" links; a section named "Optional" is the
// part an agent can skip when short of room. Cheap and harmless to publish; not
// proven to matter (about 9% of the top 1,000 sites carry one, and one study
// found no verified AI-crawler fetches of it), which the audit says plainly.

export interface LlmsLink {
  title: string;
  url: string;
  notes?: string;
}
export interface LlmsSection {
  title: string;
  links: LlmsLink[];
}
export interface LlmsInput {
  name: string;
  summary: string;
  details?: string;
  sections: LlmsSection[];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const linkText = (s: string) => oneLine(s).replace(/[[\]]/g, "");
const isWeb = (u: string) => {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
};

export function buildLlmsTxt(input: LlmsInput): string {
  const name = oneLine(input.name);
  if (!name) throw new Error("llms.txt needs a name.");
  const out: string[] = [`# ${name}`, ""];
  const summary = oneLine(input.summary);
  if (summary) out.push(`> ${summary}`, "");
  if (input.details?.trim()) out.push(input.details.trim(), "");
  for (const section of input.sections) {
    const links = section.links.filter((l) => isWeb(l.url) && linkText(l.title)).slice(0, 50);
    if (links.length === 0) continue;
    out.push(`## ${oneLine(section.title)}`, "");
    for (const l of links) out.push(`- [${linkText(l.title)}](${l.url})${l.notes && oneLine(l.notes) ? `: ${oneLine(l.notes)}` : ""}`);
    out.push("");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export interface ParsedLlms {
  valid: boolean;
  title: string | null;
  summary: string | null;
  sections: LlmsSection[];
  problems: string[];
}

export function parseLlmsTxt(text: string): ParsedLlms {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.find((l) => l.trim() !== "");
  const title = first && /^# (.+)/.exec(first)?.[1]?.trim();
  const summary = lines.map((l) => /^> (.+)/.exec(l)?.[1]?.trim()).find(Boolean) ?? null;
  const sections: LlmsSection[] = [];
  let cur: LlmsSection | null = null;
  for (const l of lines) {
    const h = /^## (.+)/.exec(l);
    if (h) {
      cur = { title: h[1]!.trim(), links: [] };
      sections.push(cur);
      continue;
    }
    const m = /^- \[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?$/.exec(l.trim());
    if (m && cur && isWeb(m[2]!)) cur.links.push({ title: m[1]!, url: m[2]!, ...(m[3] ? { notes: m[3] } : {}) });
  }
  const problems: string[] = [];
  if (!title) problems.push("There is no # title on the first line.");
  if (!summary) problems.push("There is no > summary line.");
  if (!sections.some((s) => s.links.length > 0)) problems.push("There are no sections with links.");
  return { valid: problems.length === 0, title: title || null, summary, sections: sections.filter((s) => s.links.length > 0), problems };
}
