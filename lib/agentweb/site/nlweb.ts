// ShapesOS — Phase 21A (WS=agentweb): NLWeb-style /ask and /mcp over a site's OWN
// published content (PURE; the HTTP routes are thin wrappers around this).
//
// Shapes follow microsoft/NLWeb docs/nlweb-rest-api.md: /ask takes `query`
// (required), `site`, `prev`, `decontextualized_query`, `streaming`, `mode`
// (list | summarize | generate) and answers `query_id` + `results[{url, name, site,
// score, description, schema_object}]`; /mcp speaks MCP (JSON-RPC 2.0).
//
// Honest differences from reference NLWeb: no model sits behind this endpoint, so
//   - `description` is the page's own opening text, not an LLM-written blurb;
//   - `summarize` is EXTRACTIVE (sentences copied verbatim from the top pages,
//     with their sources) and says so in `summary.method`;
//   - `generate` is refused; `prev` and `decontextualized_query` are accepted and
//     ignored (the endpoint is stateless); streaming is not offered.
// Read-only by construction: the only inputs are a query string and the docs the
// caller passes in (the site's published pages), nothing is fetched or written.

import { createHash } from "node:crypto";

export interface SiteDoc {
  url: string;
  name: string;
  text: string;
  /** Optional richer object for results (e.g. a Product); defaults to a WebPage. */
  schema?: Record<string, unknown>;
}
export interface SiteInfo {
  name: string;
  origin: string;
}

export const MAX_QUERY_CHARS = 500;
export const MAX_RESULTS = 10;
const DESCRIPTION_CHARS = 240;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "at", "is", "are", "was", "be", "do", "does", "you", "your", "we", "our", "i", "me", "my", "for", "and", "or", "what", "which", "who", "how", "when", "where", "can", "it", "this", "that", "with", "have", "has", "there", "any"]);

const stem = (w: string): string => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);

export interface Hit {
  doc: SiteDoc;
  /** 0 to 100. */
  score: number;
}

/** Title-weighted term matching with inverse document frequency. Deterministic. */
export function searchDocs(docs: SiteDoc[], query: string, limit = MAX_RESULTS): Hit[] {
  const terms = [...new Set(words(query))];
  if (!terms.length || !docs.length) return [];
  const bags = docs.map((d) => ({ name: new Set(words(d.name)), text: words(d.text) }));
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, bags.filter((b) => b.name.has(t) || b.text.includes(t)).length);
  const idf = (t: string) => Math.log(1 + docs.length / (1 + (df.get(t) ?? 0)));
  const max = terms.reduce((s, t) => s + idf(t) * 4, 0);
  const hits: Hit[] = [];
  docs.forEach((doc, i) => {
    const b = bags[i];
    let raw = 0;
    for (const t of terms) {
      raw += idf(t) * ((b.name.has(t) ? 3 : 0) + (b.text.includes(t) ? 1 : 0));
    }
    if (raw > 0) hits.push({ doc, score: Math.min(100, Math.round((raw / max) * 100)) });
  });
  return hits.sort((a, b) => b.score - a.score || a.doc.url.localeCompare(b.doc.url)).slice(0, Math.max(1, Math.min(limit, MAX_RESULTS)));
}

// ---------------------------------------------------------------------------
// /ask
// ---------------------------------------------------------------------------

export class AskError extends Error {
  constructor(
    readonly code: "bad_query" | "unsupported_mode",
    message: string,
  ) {
    super(message);
    this.name = "AskError";
  }
}

export type AskMode = "list" | "summarize" | "generate";
export interface AskParams {
  query: string;
  mode?: string;
  /** Accepted for NLWeb compatibility; the endpoint is stateless and ignores these. */
  prev?: string;
  decontextualized_query?: string;
  site?: string;
}
export interface AskResult {
  url: string;
  name: string;
  site: string;
  score: number;
  description: string;
  schema_object: Record<string, unknown>;
}
export interface AskResponse {
  query_id: string;
  query: string;
  mode: AskMode;
  results: AskResult[];
  summary?: { text: string; method: "extractive"; sources: string[] };
  message?: string;
}

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const sentences = (text: string): string[] => clean(text).match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

export function askSite(docs: SiteDoc[], site: SiteInfo, params: AskParams): AskResponse {
  const query = clean(String(params.query ?? ""));
  if (!query) throw new AskError("bad_query", "query is required");
  if (query.length > MAX_QUERY_CHARS) throw new AskError("bad_query", `query is too long (max ${MAX_QUERY_CHARS} characters)`);
  const mode = (params.mode ?? "list").toLowerCase();
  if (mode === "generate") throw new AskError("unsupported_mode", "generate mode is not available on this endpoint: it has no model behind it. Use list or summarize.");
  if (mode !== "list" && mode !== "summarize") throw new AskError("unsupported_mode", `unknown mode "${mode}": use list or summarize`);

  const hits = searchDocs(docs, query);
  const host = hostOf(site.origin);
  const results: AskResult[] = hits.map(({ doc, score }) => ({
    url: doc.url,
    name: clip(clean(doc.name), 160),
    site: host,
    score,
    description: clip(clean(doc.text), DESCRIPTION_CHARS),
    schema_object: doc.schema ?? { "@type": "WebPage", name: clip(clean(doc.name), 160), url: doc.url },
  }));
  const res: AskResponse = {
    query_id: createHash("sha256").update(`${site.origin}\n${mode}\n${query}`).digest("hex").slice(0, 16),
    query,
    mode,
    results,
  };
  if (!results.length) {
    res.message = "There is nothing on this site that matches that question.";
    return res;
  }
  if (mode === "summarize") {
    const terms = new Set(words(query));
    const picked: { s: string; url: string; n: number }[] = [];
    for (const h of hits.slice(0, 3)) {
      let best: { s: string; n: number } | null = null;
      const title = clean(h.doc.name).toLowerCase();
      for (const s of sentences(h.doc.text)) {
        if (s.replace(/[.!?]+$/, "").toLowerCase() === title) continue; // the heading repeats the name, it says nothing
        const n = words(s).filter((w) => terms.has(w)).length;
        if (n > 0 && (!best || n > best.n)) best = { s, n };
      }
      // A page whose NAME matched but whose sentences share no word with the question
      // (an "Opening hours" page that just lists the hours): its first real sentence is the answer.
      if (!best && h === hits[0]) {
        const first = sentences(h.doc.text).find((s) => s.replace(/[.!?]+$/, "").toLowerCase() !== title);
        if (first) best = { s: first, n: 0.5 };
      }
      if (best) picked.push({ ...best, url: h.doc.url });
    }
    const top = picked.sort((a, b) => b.n - a.n).slice(0, 3);
    // Keep only sentences that cover the strongest match (so one clean fact is not padded with weaker ones).
    const keep = top.filter((p) => p.n >= top[0].n);
    if (keep.length) res.summary = { text: keep.map((p) => p.s).join(" "), method: "extractive", sources: [...new Set(keep.map((p) => p.url))] };
  }
  return res;
}

// ---------------------------------------------------------------------------
// /mcp (JSON-RPC 2.0, MCP tools only)
// ---------------------------------------------------------------------------

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const err = (id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

export const ASK_TOOL = {
  name: "ask",
  description: "Ask this site a question in natural language. Returns matching pages from the site's own published content (read-only).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The question, in natural language", maxLength: MAX_QUERY_CHARS },
      mode: { type: "string", enum: ["list", "summarize"], description: "list returns matching pages; summarize adds an extractive summary" },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} as const;

/** One JSON-RPC message in, one response out (null for notifications). Never throws. */
export function handleMcp(docs: SiteDoc[], site: SiteInfo, message: unknown): JsonRpcResponse | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return err(null, -32600, "Invalid request");
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const hasId = typeof m.id === "string" || typeof m.id === "number";
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(hasId ? (m.id as string | number) : null, -32600, "Invalid request");
  if (!hasId) return null; // a notification (e.g. notifications/initialized): no reply
  const id = m.id as string | number;
  const params = m.params && typeof m.params === "object" ? m.params : {};
  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: site.name, version: "1.0.0" },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: [ASK_TOOL] });
    case "prompts/list":
      return ok(id, { prompts: [] });
    case "tools/call": {
      if (params.name !== "ask") return err(id, -32602, `Unknown tool: ${String(params.name).slice(0, 60)}`);
      try {
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        const res = askSite(docs, site, { query: String(args.query ?? ""), mode: typeof args.mode === "string" ? args.mode : undefined });
        return ok(id, { content: [{ type: "text", text: JSON.stringify(res) }] });
      } catch (e) {
        if (e instanceof AskError) return ok(id, { content: [{ type: "text", text: e.message }], isError: true });
        throw e;
      }
    }
    default:
      return err(id, -32601, "Method not found");
  }
}
