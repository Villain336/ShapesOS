// ShapesOS — Phase 21A (WS=agentweb): the channel ladder.
//
// For each task the agent uses the first interface a site offers that works,
// and records which one it used:
//   1. declared tools     WebMCP (declarative forms, imperative registerTool),
//                         a site MCP endpoint, NLWeb /ask
//   2. documented APIs    OpenAPI descriptions, feeds
//   3. structured data    schema.org JSON-LD (incl. potentialAction), microdata
//   4. accessibility tree the page's controls with stable refs (browser provider)
//   5. vision             last resort. NOT available in this release: reported honestly.
//
// Detection (this file) is PURE over a SiteProbe: the page HTML plus the few
// well-known files a prober fetched. The prober (probe.ts) does the fetching
// through the SSRF guard. Nothing here depends on a standard being adopted:
// WebMCP is an origin trial and NLWeb a young open project, so every site
// falls through to the lower rungs when it declares nothing.
//
// SPEC TEXT USED (read 2026-10-10):
//  - WebMCP declarative API, developer.chrome.com/docs/ai/webmcp/declarative-api:
//    <form toolname tooldescription [toolautosubmit]>; toolparamdescription on
//    fields (fallback: the <label>, then aria-description); toolname -> name,
//    tooldescription -> description; fields -> inputSchema.properties; `required`
//    -> required[]; <select> -> {type:string, enum, anyOf:[{const,title}]}.
//  - WebMCP imperative API, github.com/webmachinelearning/webmcp: registerTool
//    ({name, description, inputSchema, execute}) on a modelContext object. The
//    object is `navigator.modelContext` in early previews and `document.modelContext`
//    in the current draft: the name varies by source, so both are detected.
//  - NLWeb, github.com/microsoft/NLWeb docs/nlweb-rest-api.md: GET/POST /ask with
//    `query` (required) plus site, prev, decontextualized_query, streaming, mode;
//    JSON results[{url,name,site,score,description,schema_object}]; /mcp speaks MCP.
//  - MCP server discovery has no settled name yet: /.well-known/mcp.json and
//    /.well-known/mcp/server-card.json are tried, plus <link rel="mcp">.

import { attr, findAll, parseHtml, textOf, type HtmlNode } from "./html";

export const CHANNEL_ORDER = ["declared-tools", "documented-api", "structured-data", "a11y-tree", "vision"] as const;
export type ChannelId = (typeof CHANNEL_ORDER)[number];

/** Files a prober should fetch (paths relative to the origin). */
export const PROBE_PATHS = ["/llms.txt", "/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/openapi.json", "/.well-known/openapi.json", "/swagger.json", "/api/openapi.json", "/ask?query=ping", "/robots.txt"] as const;

export interface SiteProbe {
  origin: string;
  html: string;
  files: Record<string, { status: number; body: string }>;
}

export type DeclaredSource = "webmcp-declarative" | "webmcp-imperative" | "site-mcp" | "nlweb";

export interface DeclaredTool {
  source: DeclaredSource;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Declarative: how to submit it. */
  form?: { action: string; method: string; autoSubmit: boolean };
  /** MCP / NLWeb endpoint. */
  endpoint?: string;
  /** NLWeb: did a probe actually get results back? */
  verified?: boolean;
  /** Imperative WebMCP tools only run inside a live page. */
  needsBrowser?: boolean;
}

export interface ApiOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  readOnly: boolean;
  /** Query parameter names the description lists. */
  parameters: string[];
}
export interface ApiDescription {
  kind: "openapi" | "feed";
  source: string;
  operations: ApiOperation[];
}

export interface StructuredAction {
  type: string;
  name: string;
  target: string;
  method: string;
  entity?: string;
}
export interface StructuredEntity {
  type: string;
  name: string;
  props: Record<string, unknown>;
}

export interface ChannelFinding {
  channel: ChannelId;
  /** Does the site (or the browser) offer anything on this rung? */
  declared: boolean;
  count: number;
  note: string;
}

export interface ChannelReport {
  origin: string;
  declaredTools: DeclaredTool[];
  apis: ApiDescription[];
  structured: { actions: StructuredAction[]; entities: StructuredEntity[]; microdata: number };
  channels: ChannelFinding[];
  llmsTxt: boolean;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const abs = (base: string, href: string | undefined): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
};

function declarativeTools(root: HtmlNode, base: string): DeclaredTool[] {
  const out: DeclaredTool[] = [];
  for (const form of findAll(root, (n) => n.tag === "form" && attr(n, "toolname") !== undefined)) {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const f of findAll(form, (n) => ["input", "select", "textarea"].includes(n.tag ?? ""))) {
      const type = (attr(f, "type") ?? "text").toLowerCase();
      const name = attr(f, "name");
      if (!name || ["submit", "button", "reset", "image", "hidden", "file"].includes(type)) continue;
      const id = attr(f, "id");
      const label = id ? findAll(root, (n) => n.tag === "label" && attr(n, "for") === id)[0] : undefined;
      const description = (attr(f, "toolparamdescription") ?? (label ? textOf(label).trim() : "")) || attr(f, "aria-description") || "";
      const prop: Record<string, unknown> = { type: type === "number" || type === "range" ? "number" : type === "checkbox" ? "boolean" : "string" };
      if (description) prop.description = description;
      if (f.tag === "select") {
        const options = findAll(f, (n) => n.tag === "option");
        prop.enum = options.map((o) => attr(o, "value") ?? textOf(o).trim());
        prop.anyOf = options.map((o) => ({ const: attr(o, "value") ?? textOf(o).trim(), title: textOf(o).trim() }));
      }
      properties[name] = prop;
      if ("required" in (f.attrs ?? {})) required.push(name);
    }
    out.push({
      source: "webmcp-declarative",
      name: attr(form, "toolname")!,
      description: attr(form, "tooldescription") ?? "",
      inputSchema: { type: "object", properties, required },
      form: { action: abs(base, attr(form, "action") ?? "") ?? base, method: (attr(form, "method") ?? "get").toLowerCase(), autoSubmit: "toolautosubmit" in (form.attrs ?? {}) },
    });
  }
  return out;
}

function balanced(text: string, open: number): string | null {
  const o = text[open];
  const c = o === "{" ? "}" : o === "(" ? ")" : o === "[" ? "]" : null;
  if (!c) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

function looseJson(src: string): Record<string, unknown> | null {
  try {
    const fixed = src.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'([^'\\]*)'/g, '"$1"').replace(/,\s*([}\]])/g, "$1");
    const v = JSON.parse(fixed);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function imperativeTools(root: HtmlNode): DeclaredTool[] {
  const out: DeclaredTool[] = [];
  for (const s of findAll(root, (n) => n.tag === "script" && !/ld\+json|json/i.test(attr(n, "type") ?? ""))) {
    const code = textOf(s);
    for (const m of code.matchAll(/\b(?:navigator|document|window)\.modelContext\s*\.\s*registerTool\s*\(/g)) {
      const open = m.index! + m[0].length;
      const objStart = code.indexOf("{", open);
      const obj = objStart >= 0 ? balanced(code, objStart) : null;
      if (!obj) continue;
      const name = /\bname\s*:\s*["'`]([^"'`]+)["'`]/.exec(obj)?.[1];
      if (!name) continue;
      const description = /\bdescription\s*:\s*["'`]([^"'`]*)["'`]/.exec(obj)?.[1] ?? "";
      const schemaAt = /\binputSchema\s*:\s*\{/.exec(obj);
      const schemaSrc = schemaAt ? balanced(obj, schemaAt.index + schemaAt[0].length - 1) : null;
      out.push({ source: "webmcp-imperative", name, description, inputSchema: (schemaSrc ? looseJson(schemaSrc) : null) ?? { type: "object" }, needsBrowser: true });
    }
  }
  return out;
}

function jsonOf(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function siteMcp(p: SiteProbe, root: HtmlNode): DeclaredTool[] {
  const out: DeclaredTool[] = [];
  for (const path of ["/.well-known/mcp.json", "/.well-known/mcp/server-card.json"]) {
    const f = p.files[path];
    const j = f && f.status === 200 ? jsonOf(f.body) : null;
    if (!j) continue;
    const info = (j.serverInfo ?? {}) as Record<string, unknown>;
    const endpoint = abs(p.origin, String(j.endpoint ?? j.url ?? info.url ?? "/mcp"));
    if (endpoint) out.push({ source: "site-mcp", name: String(j.name ?? info.name ?? "site"), description: String(j.description ?? "Site MCP server"), inputSchema: { type: "object" }, endpoint });
  }
  for (const l of findAll(root, (n) => n.tag === "link" && (attr(n, "rel") ?? "").toLowerCase() === "mcp")) {
    const endpoint = abs(p.origin, attr(l, "href"));
    if (endpoint && !out.some((t) => t.endpoint === endpoint)) out.push({ source: "site-mcp", name: "site", description: "Site MCP server (declared by a link)", inputSchema: { type: "object" }, endpoint });
  }
  return out;
}

function nlweb(p: SiteProbe, root: HtmlNode, structuredTargets: string[]): DeclaredTool[] {
  const ask = p.files["/ask?query=ping"];
  const j = ask && ask.status === 200 ? jsonOf(ask.body) : null;
  const endpoint = `${p.origin}/ask`;
  const schema = { type: "object", properties: { query: { type: "string", description: "The question in natural language" } }, required: ["query"] };
  if (j && Array.isArray(j.results)) return [{ source: "nlweb", name: "ask", description: "Ask the site a question (NLWeb /ask)", inputSchema: schema, endpoint, verified: true }];
  const link = findAll(root, (n) => n.tag === "link" && (attr(n, "rel") ?? "").toLowerCase() === "nlweb")[0];
  const declared = abs(p.origin, attr(link ?? { type: "element", children: [] }, "href")) ?? structuredTargets.find((t) => /\/ask(\?|$|\{)/.test(t));
  return declared ? [{ source: "nlweb", name: "ask", description: "Ask the site a question (NLWeb /ask), declared but not verified", inputSchema: schema, endpoint: abs(p.origin, declared.replace(/\{[^}]*\}/g, "")) ?? endpoint, verified: false }] : [];
}

function apis(p: SiteProbe, root: HtmlNode): ApiDescription[] {
  const out: ApiDescription[] = [];
  for (const path of ["/openapi.json", "/.well-known/openapi.json", "/swagger.json", "/api/openapi.json"]) {
    const f = p.files[path];
    const j = f && f.status === 200 ? jsonOf(f.body) : null;
    if (!j || !j.paths || typeof j.paths !== "object") continue;
    const operations: ApiOperation[] = [];
    for (const [route, item] of Object.entries(j.paths as Record<string, Record<string, Record<string, unknown>>>)) {
      for (const [method, op] of Object.entries(item ?? {})) {
        if (!["get", "post", "put", "patch", "delete", "head"].includes(method)) continue;
        const parameters = (Array.isArray(op?.parameters) ? (op.parameters as Array<Record<string, unknown>>) : []).filter((p) => p?.in === "query" && typeof p.name === "string").map((p) => String(p.name));
        operations.push({ operationId: String(op?.operationId ?? `${method} ${route}`), method, path: route, summary: String(op?.summary ?? ""), readOnly: method === "get" || method === "head", parameters });
      }
    }
    out.push({ kind: "openapi", source: `${p.origin}${path}`, operations });
    break;
  }
  for (const l of findAll(root, (n) => n.tag === "link" && (attr(n, "rel") ?? "").toLowerCase() === "alternate" && /rss|atom/.test(attr(n, "type") ?? ""))) {
    const href = abs(p.origin, attr(l, "href"));
    if (href) out.push({ kind: "feed", source: href, operations: [{ operationId: "read feed", method: "get", path: href, summary: attr(l, "title") ?? "Feed", readOnly: true, parameters: [] }] });
  }
  return out;
}

function flatten(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o["@graph"]) flatten(o["@graph"], out);
    else if (o["@type"]) out.push(o);
  }
}

function structured(root: HtmlNode): ChannelReport["structured"] {
  const nodes: Record<string, unknown>[] = [];
  for (const s of findAll(root, (n) => n.tag === "script" && /ld\+json/i.test(attr(n, "type") ?? ""))) {
    try {
      flatten(JSON.parse(textOf(s)), nodes);
    } catch {
      /* invalid JSON-LD is the audit's problem, not detection's */
    }
  }
  const actions: StructuredAction[] = [];
  const entities: StructuredEntity[] = [];
  for (const n of nodes) {
    const type = String(Array.isArray(n["@type"]) ? n["@type"][0] : n["@type"]);
    const { potentialAction, ...rest } = n;
    const props = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "@type" && k !== "@context"));
    entities.push({ type, name: String(n.name ?? ""), props });
    for (const a of ([] as Record<string, unknown>[]).concat((potentialAction as never) ?? [])) {
      const t = a.target;
      const target = typeof t === "string" ? t : String((t as Record<string, unknown>)?.urlTemplate ?? (t as Record<string, unknown>)?.url ?? "");
      if (!target) continue;
      const method = typeof t === "object" && t ? String((t as Record<string, unknown>).httpMethod ?? "GET").toUpperCase() : "GET";
      actions.push({ type: String(a["@type"] ?? "Action"), name: String(a.name ?? ""), target, method, entity: type });
    }
  }
  return { actions, entities, microdata: findAll(root, (n) => "itemscope" in (n.attrs ?? {})).length };
}

function channelFindings(declaredTools: DeclaredTool[], apiList: ApiDescription[], st: ChannelReport["structured"], browser: boolean): ChannelFinding[] {
  const opCount = apiList.reduce((n, a) => n + a.operations.length, 0);
  return [
    { channel: "declared-tools", declared: declaredTools.length > 0, count: declaredTools.length, note: declaredTools.length ? `${declaredTools.length} tool(s) declared for agents` : "the site declares no tools for agents" },
    { channel: "documented-api", declared: apiList.length > 0, count: opCount, note: apiList.length ? `${opCount} documented operation(s)` : "no OpenAPI description or feed found" },
    { channel: "structured-data", declared: st.entities.length + st.actions.length + st.microdata > 0, count: st.entities.length + st.actions.length, note: st.actions.length ? `${st.actions.length} schema.org action(s)` : st.entities.length ? "schema.org facts only" : "no schema.org data" },
    { channel: "a11y-tree", declared: browser, count: browser ? 1 : 0, note: browser ? "the page's controls can be read and used through a browser provider" : "no browser provider is configured" },
    { channel: "vision", declared: false, count: 0, note: "Vision (screenshots read by a model) is not available in this release." },
  ];
}

export function detectChannels(p: SiteProbe, opts: { browserAvailable?: boolean } = {}): ChannelReport {
  const root = parseHtml(p.html);
  const st = structured(root);
  const declaredTools = [...declarativeTools(root, p.origin), ...imperativeTools(root), ...siteMcp(p, root), ...nlweb(p, root, st.actions.map((a) => a.target))];
  const apiList = apis(p, root);
  const browser = opts.browserAvailable !== false;
  const channels = channelFindings(declaredTools, apiList, st, browser);
  return { origin: p.origin, declaredTools, apis: apiList, structured: st, channels, llmsTxt: p.files["/llms.txt"]?.status === 200 };
}

/** One report for a whole site from the reports of several of its pages (the first is the home page). */
export function mergeReports(reports: ChannelReport[]): ChannelReport {
  const first = reports[0];
  const tools = new Map<string, DeclaredTool>();
  const apiList = new Map<string, ApiDescription>();
  const actions = new Map<string, StructuredAction>();
  const entities: StructuredEntity[] = [];
  let microdata = 0;
  for (const r of reports) {
    for (const t of r.declaredTools) tools.set(`${t.source}|${t.name}|${t.endpoint ?? t.form?.action ?? ""}`, t);
    for (const a of r.apis) apiList.set(`${a.kind}|${a.source}`, a);
    for (const a of r.structured.actions) actions.set(`${a.type}|${a.target}`, a);
    entities.push(...r.structured.entities);
    microdata += r.structured.microdata;
  }
  const st = { actions: [...actions.values()], entities, microdata };
  const browser = first.channels.find((c) => c.channel === "a11y-tree")?.declared ?? true;
  return {
    origin: first.origin,
    declaredTools: [...tools.values()],
    apis: [...apiList.values()],
    structured: st,
    channels: channelFindings([...tools.values()], [...apiList.values()], st, browser),
    llmsTxt: reports.some((r) => r.llmsTxt),
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ChannelSelection {
  channel: ChannelId;
  tool?: DeclaredTool;
  operation?: ApiOperation;
  action?: StructuredAction;
  reason: string;
  /** The other rungs that exist here, in ladder order. */
  fallbacks: ChannelFinding[];
}

const STOP = new Set(["the", "a", "an", "to", "of", "for", "and", "or", "me", "my", "from", "on", "in", "with", "this", "that", "please", "can", "you", "get", "business", "site"]);
const tokens = (s: string): string[] =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
const overlap = (a: string[], b: string[]): number => a.filter((t) => b.includes(t)).length;
const ASK_WORDS = ["ask", "question", "search", "find", "what", "how", "when", "where", "info", "information", "about", "tell"];
const FACT_WORDS = ["hours", "opening", "open", "phone", "telephone", "address", "price", "location", "email", "rating", "reviews", "name", "contact", "menu", "services"];

export function selectChannel(report: ChannelReport, task: { intent: string; failed?: ChannelId[] }): ChannelSelection {
  const want = tokens(task.intent);
  const failed = new Set(task.failed ?? []);
  const notes: string[] = [];
  const fallbacksFor = (chosen: ChannelId) => report.channels.filter((c) => c.declared && c.channel !== chosen && !failed.has(c.channel));
  const done = (s: Omit<ChannelSelection, "fallbacks" | "reason"> & { reason: string }): ChannelSelection => ({ ...s, reason: [s.reason, ...notes].join("; "), fallbacks: fallbacksFor(s.channel) });

  // 1. declared tools
  const tool = report.declaredTools
    .map((t) => ({ t, score: t.source === "nlweb" || t.source === "site-mcp" ? overlap(want, ASK_WORDS) : overlap(want, tokens(`${t.name} ${t.description}`)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(!!b.t.verified) - Number(!!a.t.verified))[0]?.t; // on a tie prefer the endpoint that answered a probe
  if (tool) {
    if (failed.has("declared-tools")) notes.push("declared tools failed before on this site");
    else return done({ channel: "declared-tools", tool, reason: `the site declares a tool for this (${tool.name}, ${tool.source})` });
  }
  // 2. documented API (reads only)
  const op = report.apis
    .flatMap((a) => a.operations)
    .filter((o) => o.readOnly)
    .map((o) => ({ o, score: overlap(want, tokens(`${o.operationId} ${o.summary} ${o.path}`)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.o;
  if (op) {
    if (failed.has("documented-api")) notes.push("the documented API failed before on this site");
    else return done({ channel: "documented-api", operation: op, reason: `a documented read operation fits (${op.operationId})` });
  }
  // 3. structured data
  const action = report.structured.actions.map((a) => ({ a, score: overlap(want, tokens(`${a.type} ${a.name}`)) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)[0]?.a;
  const factual = report.structured.entities.length > 0 && overlap(want, FACT_WORDS) > 0;
  if (action || factual) {
    if (failed.has("structured-data")) notes.push("structured data failed before on this site");
    else return done({ channel: "structured-data", action, reason: action ? `schema.org declares an action (${action.type})` : "schema.org facts cover this" });
  }
  // 4. the page's controls
  const a11y = report.channels.find((c) => c.channel === "a11y-tree")!;
  if (a11y.declared && !failed.has("a11y-tree")) return done({ channel: "a11y-tree", reason: "nothing declared fits; using the page's controls" });
  return done({ channel: "vision", reason: "vision is the last rung and is not available in this release" });
}
