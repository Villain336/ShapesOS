// ShapesOS — Phase 21A (WS=agentweb): actions on an answer or one of its sources.
//
// Each action is an EXISTING tool call (so it runs through executeTool and every
// gate it already has) or a link that opens a draft for the person to review.
// Nothing here buys, sends or pays: a purchase from a result is a Tier 3 hand-off
// (milestone M4), and an email is only ever drafted, never sent.
//
//   save_note      create_note          Notes (Tier 1 kind: asks unless a rule allows it)
//   save_drive     create_document      a .docx in the workspace files
//   add_crm        ops_create_company   a company from the source's name and domain
//   monitor_page   web_monitor_page     watch the page for changes (Context.dev)
//   draft_email    link to Mail         compose with subject and body filled in

import type { AnswerPayload } from "./types";

export const ACTION_IDS = ["save_note", "save_drive", "add_crm", "monitor_page", "draft_email"] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export type BuiltAction = { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "link"; href: string };

/** The answer as plain Markdown: claims with their status, then the sources with receipts. */
export function answerMarkdown(p: AnswerPayload): string {
  const claims = p.claims.map((c) => `- ${c.text} ${c.cites.map((i) => `[${i}]`).join("")}${c.status === "unsupported" ? ` (unsupported: ${c.reason ?? "no source backs this"})` : ""}`).join("\n");
  const sources = p.sources.map((s) => `[${s.id}] ${s.title} — ${s.url}${s.captureId ? ` (receipt ${s.captureId})` : ""}`).join("\n");
  return [`# Answer: ${p.question}`, "", p.partial ? "_Partial answer: it stopped early._\n" : "", claims || "_No claims._", "", "## Sources", sources].filter((x) => x !== "").join("\n");
}

const isWeb = (url: string) => /^https?:\/\//i.test(url);

export function buildAction(id: ActionId, p: AnswerPayload, sourceId: number | undefined): BuiltAction | null {
  const source = sourceId === undefined ? undefined : p.sources.find((s) => s.id === sourceId);
  const title = `Answer: ${p.question}`.slice(0, 120);
  switch (id) {
    case "save_note":
      return { kind: "tool", tool: "create_note", args: { title, body: answerMarkdown(p).replace(/^# .*\n\n?/, ""), tags: "web-answer" } };
    case "save_drive":
      return { kind: "tool", tool: "create_document", args: { title, markdown: answerMarkdown(p) } };
    case "add_crm": {
      if (!source || !isWeb(source.url)) return null;
      return { kind: "tool", tool: "ops_create_company", args: { name: source.title.slice(0, 120), domain: new URL(source.url).hostname.replace(/^www\./, "") } };
    }
    case "monitor_page": {
      if (!source || !isWeb(source.url)) return null;
      return { kind: "tool", tool: "web_monitor_page", args: { url: source.url, name: source.title.slice(0, 80), cadence: "daily" } };
    }
    case "draft_email": {
      const body = p.claims.filter((c) => c.status === "supported").map((c) => `- ${c.text}`).join("\n") || answerMarkdown(p);
      const u = new URLSearchParams({ compose: "1", subject: `Re: ${p.question}`.slice(0, 200), body: `${body}${source ? `\n\nSource: ${source.url}` : ""}`.slice(0, 3000) });
      return { kind: "link", href: `/dashboard/mail?${u.toString()}` };
    }
    default:
      return null;
  }
}
