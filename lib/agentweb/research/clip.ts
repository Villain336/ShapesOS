// ShapesOS — Phase 21A round 2 (WS=agentweb): "Clip to…" actions on a research session or one of its pages.
//
// Each action is an EXISTING tool call, run through executeTool by the route with every gate the
// tool already has (the person's click confirms that one action, never money or deletion), or a
// deliberate append to the business graph. Nothing here sends, pays or deletes.
//
//   note       create_note          the research as a Markdown note (Tier 1: asks unless a rule allows)
//   drive      create_document     the research as a .docx in the workspace files
//   company    ops_create_company   a company from a page's title and domain (CRM)
//   contact    ops_create_contact   a contact the person names, with the page as where it came from (CRM)
//   monitor    web_monitor_page     watch the page for changes (Context.dev)
//   graph      (graph fact)         the page as a `content` entity in the business graph: a business
//                                   fact, append-only like every graph fact. Browsing memory is NOT
//                                   copied there; this is the person saying "this page matters to the business".

import { researchMarkdown, type ResearchView } from "./view";

export const CLIP_TARGETS = ["note", "drive", "company", "contact", "monitor", "graph"] as const;
export type ClipTarget = (typeof CLIP_TARGETS)[number];

export type BuiltClip = { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "graph"; url: string; title: string; excerpt: string };

const isWeb = (url: string) => /^https?:\/\//i.test(url);

export interface ClipInput {
  target: ClipTarget;
  /** A page of the research (its address), for page-level targets. */
  url?: string;
  /** For contact: the person's own entries. */
  contact?: { name?: string; email?: string; phone?: string; title?: string };
}

export function pageOf(view: ResearchView, url: string): { url: string; title: string; excerpt: string } | null {
  for (const a of view.answers) {
    const s = a.sources.find((x) => !x.redacted && x.url === url);
    if (s) return { url: s.url, title: s.title, excerpt: "" };
  }
  const p = view.pages.find((x) => x.url === url);
  return p ? { url: p.url, title: p.url, excerpt: p.excerpt } : null;
}

export function buildClip(view: ResearchView, input: ClipInput): BuiltClip | null {
  const title = `Research: ${view.title}`.slice(0, 120);
  switch (input.target) {
    case "note":
      return { kind: "tool", tool: "create_note", args: { title, body: researchMarkdown(view).replace(/^# .*\n\n?/, ""), tags: "research" } };
    case "drive":
      return { kind: "tool", tool: "create_document", args: { title, markdown: researchMarkdown(view) } };
    case "company": {
      const p = input.url ? pageOf(view, input.url) : null;
      if (!p || !isWeb(p.url)) return null;
      return { kind: "tool", tool: "ops_create_company", args: { name: p.title.slice(0, 120) || new URL(p.url).hostname, domain: new URL(p.url).hostname.replace(/^www\./, "") } };
    }
    case "contact": {
      const c = input.contact ?? {};
      const name = typeof c.name === "string" ? c.name.trim().slice(0, 120) : "";
      if (!name) return null;
      return { kind: "tool", tool: "ops_create_contact", args: { name, ...(c.email ? { email: String(c.email).slice(0, 200) } : {}), ...(c.phone ? { phone: String(c.phone).slice(0, 60) } : {}), ...(c.title ? { title: String(c.title).slice(0, 120) } : {}) } };
    }
    case "monitor": {
      const p = input.url ? pageOf(view, input.url) : null;
      if (!p || !isWeb(p.url)) return null;
      return { kind: "tool", tool: "web_monitor_page", args: { url: p.url, name: (p.title || new URL(p.url).hostname).slice(0, 80), cadence: "daily" } };
    }
    case "graph": {
      const p = input.url ? pageOf(view, input.url) : null;
      if (!p || !isWeb(p.url)) return null;
      return { kind: "graph", url: p.url, title: p.title, excerpt: p.excerpt };
    }
    default:
      return null;
  }
}
