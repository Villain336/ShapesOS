// ShapesOS Phase 11 (seotools): SEO agent tools (group "site").
//
//   add_structured_data       safe   writes a site DRAFT revision with JSON-LD
//                                    (Organization / WebSite on the home page,
//                                    BreadcrumbList on inner pages, FAQPage from
//                                    <details> markup, plus Product / Article /
//                                    LocalBusiness / … blocks the agent passes).
//                                    Never touches the live site: a person
//                                    reviews and applies the draft (Site drafts).
//                                    Action draft_structured_data (Tier 0).
//   validate_structured_data  safe   validate JSON-LD text, or the JSON-LD on a
//                                    live page (SSRF-guarded polite fetch)
//   submit_sitemap            publish submit the site's sitemap to Search Console
//                                    (when connected) and IndexNow. Action
//                                    refresh_owned_page (Tier 1: asks unless
//                                    automation is switched on).
//
// Self-registers (imported for its side effect by lib/chat/agent.ts).

import { registerExtraTool, type ToolContext, type ToolDef } from "@/lib/chat/tools";
import { roleAtLeast } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { generateJsonLd, isJsonLdType, JSONLD_TYPES, validateJsonLd, validateJsonLdText, type JsonLd, type JsonLdInput, type JsonLdIssue } from "./jsonld";
import { createJsonLdDraft, JsonLdDraftError } from "./jsonld-draft";
import { extractJsonLdBlocks } from "@/lib/audit/structured-data";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Parse the agent's `blocks` argument: [{ path, type, data }] → path → JSON-LD. */
export function parseBlockArgs(raw: unknown): Record<string, JsonLd[]> {
  if (raw === undefined || raw === null || raw === "") return {};
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('blocks must be JSON: [{"path": "/products/widget.html", "type": "Product", "data": {…}}]');
    }
  }
  if (!Array.isArray(parsed)) throw new Error("blocks must be an array of { path, type, data }.");
  const out: Record<string, JsonLd[]> = {};
  for (const item of parsed) {
    const it = (item ?? {}) as { path?: unknown; type?: unknown; data?: unknown };
    const path = str(it.path);
    if (!path) throw new Error("Every block needs the page path it belongs to.");
    if (!isJsonLdType(it.type)) throw new Error(`type must be one of ${JSONLD_TYPES.join(", ")}.`);
    if (!it.data || typeof it.data !== "object") throw new Error(`The ${it.type} block for ${path} needs a data object.`);
    const p = path.startsWith("/") ? path : `/${path}`;
    (out[p] ??= []).push(generateJsonLd(it.type, it.data as JsonLdInput));
  }
  return out;
}

async function siteFor(ctx: ToolContext, siteId: string | undefined) {
  return siteId
    ? prisma.site.findFirst({ where: { id: siteId, projectId: ctx.projectId }, select: { id: true, name: true } })
    : prisma.site.findFirst({ where: { projectId: ctx.projectId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
}

function issueLines(issues: JsonLdIssue[]): string {
  return issues.map((i) => `- ${i.severity}: ${i.path || "$"} — ${i.message}`).join("\n");
}

export const add_structured_data: ToolDef = {
  name: "add_structured_data",
  description:
    "Add schema.org JSON-LD to a site's pages as a DRAFT revision (never the live site): Organization + WebSite on the home page, BreadcrumbList on inner pages, FAQPage from <details> Q&A, plus any Product / Article / LocalBusiness / FAQPage / BreadcrumbList blocks you pass. Every block is validated first; a person reviews and applies the draft, then deploys.",
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      siteId: { type: "string", description: "Site id (optional — defaults to the project's first site)." },
      pages: { type: "string", description: "Comma-separated page paths to touch, e.g. \"/index.html,/about.html\" (optional — default every HTML page)." },
      blocks: {
        type: "string",
        description:
          'Optional JSON array of extra blocks: [{"path":"/products/widget.html","type":"Product","data":{"name":"Widget","image":"https://…","offers":{"price":19.99,"priceCurrency":"USD","availability":"InStock"}}}]. Types: Organization, WebSite, LocalBusiness (data.businessType, data.address), Product, Article (headline, authorName, datePublished), FAQPage (questions), BreadcrumbList (items).',
      },
    },
  },
  async execute(ctx, args) {
    if (!roleAtLeast(ctx.role, "editor")) throw new Error("editor role required");
    const site = await siteFor(ctx, str(args.siteId));
    if (!site) return { summary: "No site found in this project.", details: { error: "no_site" } };
    let extra: Record<string, JsonLd[]>;
    try {
      extra = parseBlockArgs(args.blocks);
    } catch (err) {
      return { summary: err instanceof Error ? err.message : "Bad blocks.", details: { error: "bad_blocks" } };
    }
    const paths = str(args.pages)?.split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
    try {
      const res = await createJsonLdDraft({
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        siteId: site.id,
        paths,
        extra,
        createdBy: ctx.userId,
        runId: ctx.runId ?? null,
      });
      const lines = res.pages.map((p) => `- ${p.path}: ${p.types.join(", ")}${p.changed ? "" : " (already there)"}`).join("\n");
      if (!res.revision) {
        return { summary: `Every page of "${site.name}" already carries this structured data — no draft needed.\n${lines}`, details: { saved: false, pages: res.pages } };
      }
      return {
        summary: `Saved draft #${res.revision.number} of "${site.name}" with structured data (${res.origin}). Nothing is live yet: review and apply it in Site drafts, then deploy.\n${lines}`,
        details: { saved: true, revisionId: res.revision.id, number: res.revision.number, pages: res.pages, origin: res.origin },
      };
    } catch (err) {
      if (err instanceof JsonLdDraftError) {
        return { summary: err.issues.length ? `${err.message}\n${issueLines(err.issues)}` : err.message, details: { error: err.code, issues: err.issues } };
      }
      throw err;
    }
  },
};

export const validate_structured_data: ToolDef = {
  name: "validate_structured_data",
  description:
    "Check schema.org JSON-LD: pass the JSON itself, or a page URL to check the JSON-LD on the live page. Reports JSON errors, missing required properties per @type (Google rich-result rules) and recommended properties.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      json: { type: "string", description: "JSON-LD to validate (optional if url is given)." },
      url: { type: "string", description: "A live page whose JSON-LD to validate (optional if json is given)." },
    },
  },
  async execute(_ctx, args) {
    const json = str(args.json);
    const url = str(args.url);
    if (!json && !url) return { summary: "Pass json or url.", details: { error: "args" } };
    let blocks: { source: string; issues: JsonLdIssue[] }[];
    if (json) {
      blocks = [{ source: "json", issues: validateJsonLdText(json) }];
    } else {
      const { PoliteFetcher } = await import("@/lib/intelligence/fleet/polite-fetch");
      let html: string;
      try {
        const page = await new PoliteFetcher({ minDelayMs: 0 }).get(url!, { maxChars: 2_000_000 });
        if (page.status >= 400) return { summary: `${url} returned HTTP ${page.status}.`, details: { error: "http", status: page.status } };
        html = page.text;
      } catch (err) {
        return { summary: `Couldn't fetch ${url}: ${err instanceof Error ? err.message : "error"}`, details: { error: "fetch" } };
      }
      const found = extractJsonLdBlocks(html);
      if (!found.length) return { summary: `${url} has no JSON-LD structured data.`, details: { blocks: 0 } };
      blocks = found.map((b) => ({ source: `line ${b.line}`, issues: validateJsonLdText(b.raw) }));
    }
    const errors = blocks.reduce((n, b) => n + b.issues.filter((i) => i.severity === "error").length, 0);
    const warnings = blocks.reduce((n, b) => n + b.issues.filter((i) => i.severity === "warning").length, 0);
    const body = blocks.map((b) => (b.issues.length ? `${b.source}:\n${issueLines(b.issues)}` : `${b.source}: valid`)).join("\n");
    return {
      summary: `${blocks.length} JSON-LD block${blocks.length === 1 ? "" : "s"}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.\n${body}`,
      details: { valid: errors === 0, errors, warnings, blocks },
    };
  },
};

export const submit_sitemap: ToolDef = {
  name: "submit_sitemap",
  description:
    "Tell search engines about a site's sitemap: Google Search Console (when the project's Search Console is connected) and IndexNow (keyless; Bing and others). Uses the site's live URL. Each engine's real answer is reported — not connected or refused is never shown as submitted.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      siteId: { type: "string", description: "Site id (optional — defaults to the project's first site)." },
      targets: { type: "string", description: 'Comma-separated: "gsc", "indexnow" (optional — default both).' },
    },
  },
  async execute(ctx, args) {
    if (!roleAtLeast(ctx.role, "editor")) throw new Error("editor role required");
    const site = await siteFor(ctx, str(args.siteId));
    if (!site) return { summary: "No site found in this project.", details: { error: "no_site" } };
    const targets = str(args.targets)
      ?.split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t): t is "gsc" | "indexnow" => t === "gsc" || t === "indexnow");
    const { submitSiteSitemap, SitemapSubmitError } = await import("./sitemap-submit");
    try {
      const out = await submitSiteSitemap({ workspaceId: ctx.workspaceId, projectId: ctx.projectId, siteId: site.id, targets, submittedBy: ctx.userId });
      const lines = out.results.map((r) => `- ${r.target === "gsc" ? "Search Console" : "IndexNow"}: ${r.status.replace("_", " ")} — ${r.detail}`).join("\n");
      return {
        summary: `Sitemap ${out.sitemapUrl} (${out.urlCount} page${out.urlCount === 1 ? "" : "s"}):\n${lines}`,
        details: out,
      };
    } catch (err) {
      if (err instanceof SitemapSubmitError) return { summary: err.message, details: { error: err.code } };
      throw err;
    }
  },
};

export const SEO_TOOLS: readonly ToolDef[] = [add_structured_data, validate_structured_data, submit_sitemap];

let registered = false;
export function registerSeoTools(): void {
  if (registered) return;
  registered = true;
  for (const t of SEO_TOOLS) registerExtraTool(t);
}

registerSeoTools();

// Re-exported for callers that only need the pure helpers.
export { validateJsonLd };
