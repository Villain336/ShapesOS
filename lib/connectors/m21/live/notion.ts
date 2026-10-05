// ShapesOS — Phase 4b live Notion client (Notion-Version 2026-03-11).
//   POST https://api.notion.com/v1/search                       → pages + data sources
//   GET  https://api.notion.com/v1/pages/{id}                   → page title
//   GET  https://api.notion.com/v1/blocks/{id}/children         → page text (cursor paging)
//   GET  https://api.notion.com/v1/databases/{id}               → data_sources[] (2025-09-03+)
//   POST https://api.notion.com/v1/data_sources/{id}/query      → rows (cursor paging)
//   GET  https://api.notion.com/v1/users/me                     → health check
// Since 2025-09-03 a database is a container of data sources; queries go to
// the data source. A databaseId resolves to its first data source unless a
// dataSourceId is given. Notion averages 3 requests/second per integration
// and answers 429 with Retry-After, which the shared layer honours.

import { liveRequest, ConnectorApiError, type LiveDeps, type TokenSource } from "./http";

export const NOTION_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";
const PROVIDER = "Notion";
const HEADERS = { "Notion-Version": NOTION_VERSION };
const MAX_BLOCKS = 1_000;
const TEXT_CAP = 100_000;

type Json = Record<string, unknown>;

export function normalizeNotionId(raw: unknown, field: string): string {
  const s = String(raw ?? "").trim().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(s)) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: ${field} must be a Notion id (32 hex characters).`);
  }
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function richText(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  return rt.map((t) => (t && typeof t === "object" ? String((t as Json).plain_text ?? "") : "")).join("");
}

/** Title of a page or data source object. */
export function notionTitle(obj: Json): string {
  if (Array.isArray(obj.title)) return richText(obj.title);
  const props = (obj.properties ?? {}) as Record<string, Json>;
  for (const p of Object.values(props)) {
    if (p && p.type === "title") return richText(p.title);
  }
  return "";
}

/** Flatten one property value into a plain JSON value. */
export function propertyValue(p: Json): unknown {
  const type = String(p.type ?? "");
  const v = p[type] as unknown;
  switch (type) {
    case "title":
    case "rich_text":
      return richText(v);
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return v ?? null;
    case "select":
    case "status":
      return v && typeof v === "object" ? ((v as Json).name ?? null) : null;
    case "multi_select":
      return Array.isArray(v) ? v.map((o) => (o as Json).name) : [];
    case "date":
      return v && typeof v === "object" ? { start: (v as Json).start ?? null, end: (v as Json).end ?? null } : null;
    case "people":
      return Array.isArray(v) ? v.map((u) => (u as Json).name ?? (u as Json).id) : [];
    case "relation":
      return Array.isArray(v) ? v.map((r) => (r as Json).id) : [];
    case "formula":
      return v && typeof v === "object" ? ((v as Json)[String((v as Json).type)] ?? null) : null;
    default:
      return null;
  }
}

interface ListResponse {
  results?: Json[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export async function notionSearch(auth: TokenSource, query: string, limit: number, deps: LiveDeps = {}) {
  const out: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10 && out.length < limit; page++) {
    const res = await liveRequest<ListResponse>(
      {
        provider: PROVIDER,
        method: "POST",
        url: `${NOTION_BASE}/search`,
        headers: HEADERS,
        json: {
          query,
          page_size: Math.min(100, limit - out.length),
          ...(cursor ? { start_cursor: cursor } : {}),
          sort: { timestamp: "last_edited_time", direction: "descending" },
        },
        auth,
      },
      deps,
    );
    out.push(...(res.results ?? []));
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    if (!cursor) break;
  }
  return out.slice(0, limit).map((r) => ({
    id: String(r.id ?? ""),
    title: notionTitle(r),
    type: r.object === "data_source" ? "data_source" : String(r.object ?? "page"),
    lastEdited: (r.last_edited_time as string | undefined) ?? null,
    url: (r.url as string | undefined) ?? null,
  }));
}

function blockText(b: Json): string {
  const type = String(b.type ?? "");
  const body = (b[type] ?? {}) as Json;
  const text = richText(body.rich_text);
  switch (type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${body.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    case "code":
      return "```\n" + text + "\n```";
    case "child_page":
      return `[page] ${String(body.title ?? "")}`;
    case "child_database":
      return `[database] ${String(body.title ?? "")}`;
    default:
      return text;
  }
}

async function listChildren(auth: TokenSource, blockId: string, deps: LiveDeps, budget: { left: number }): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  while (budget.left > 0) {
    const res = await liveRequest<ListResponse>(
      {
        provider: PROVIDER,
        url: `${NOTION_BASE}/blocks/${blockId}/children`,
        headers: HEADERS,
        query: { page_size: 100, start_cursor: cursor },
        auth,
      },
      deps,
    );
    const results = res.results ?? [];
    budget.left -= results.length;
    out.push(...results);
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    if (!cursor) break;
  }
  return out;
}

/** Page title + its blocks as markdown-ish text (nested one level, capped). */
export async function notionReadPage(auth: TokenSource, pageId: string, deps: LiveDeps = {}) {
  const page = await liveRequest<Json>(
    { provider: PROVIDER, url: `${NOTION_BASE}/pages/${pageId}`, headers: HEADERS, auth },
    deps,
  );
  const budget = { left: MAX_BLOCKS };
  const blocks = await listChildren(auth, pageId, deps, budget);
  const lines: string[] = [];
  for (const b of blocks) {
    lines.push(blockText(b));
    if (b.has_children === true && budget.left > 0 && b.type !== "child_page" && b.type !== "child_database") {
      const kids = await listChildren(auth, String(b.id), deps, budget);
      for (const k of kids) lines.push(`  ${blockText(k)}`);
    }
  }
  const full = lines.filter((l) => l.trim()).join("\n");
  return {
    pageId,
    title: notionTitle(page),
    text: full.length > TEXT_CAP ? full.slice(0, TEXT_CAP) : full,
    truncated: full.length > TEXT_CAP || budget.left <= 0,
    url: (page.url as string | undefined) ?? null,
  };
}

/** Resolve the data source to query: explicit id, else the database's first. */
export async function notionResolveDataSource(
  auth: TokenSource,
  args: { databaseId?: string; dataSourceId?: string },
  deps: LiveDeps = {},
): Promise<string> {
  if (args.dataSourceId) return args.dataSourceId;
  if (!args.databaseId) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: databaseId or dataSourceId is required.`);
  }
  const db = await liveRequest<{ data_sources?: Array<{ id?: string; name?: string }> }>(
    { provider: PROVIDER, url: `${NOTION_BASE}/databases/${args.databaseId}`, headers: HEADERS, auth },
    deps,
  );
  const first = db.data_sources?.[0]?.id;
  if (!first) {
    throw new ConnectorApiError(PROVIDER, "not_found", `${PROVIDER}: the database has no data source shared with this integration.`);
  }
  return first;
}

export async function notionQueryDataSource(auth: TokenSource, dataSourceId: string, limit: number, deps: LiveDeps = {}) {
  const rows: Json[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && rows.length < limit; page++) {
    const res = await liveRequest<ListResponse>(
      {
        provider: PROVIDER,
        method: "POST",
        url: `${NOTION_BASE}/data_sources/${dataSourceId}/query`,
        headers: HEADERS,
        json: { page_size: Math.min(100, limit - rows.length), ...(cursor ? { start_cursor: cursor } : {}) },
        auth,
      },
      deps,
    );
    rows.push(...(res.results ?? []));
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    if (!cursor) break;
  }
  return rows.slice(0, limit).map((r) => {
    const props = (r.properties ?? {}) as Record<string, Json>;
    const values: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(props)) values[name] = propertyValue(p);
    return { id: String(r.id ?? ""), title: notionTitle(r), url: (r.url as string | undefined) ?? null, properties: values };
  });
}

export async function notionPing(auth: TokenSource, deps: LiveDeps = {}) {
  await liveRequest({ provider: PROVIDER, url: `${NOTION_BASE}/users/me`, headers: HEADERS, auth }, deps);
  return { reachable: true };
}
