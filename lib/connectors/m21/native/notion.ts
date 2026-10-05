// ShapesOS — M21 Notion adapter.
//
// LIVE WIRING (Phase 4b): with a vault credential this adapter calls the
// Notion API with "Notion-Version: 2026-03-11" (lib/connectors/m21/live/notion.ts):
//   POST https://api.notion.com/v1/search → search_pages() (cursor paging)
//   GET  https://api.notion.com/v1/pages/{id} + /v1/blocks/{id}/children
//     → read_page() (recurse one level; plain text, capped)
//   GET  https://api.notion.com/v1/databases/{id} → data_sources[], then
//   POST https://api.notion.com/v1/data_sources/{id}/query → query_database()
//   GET  https://api.notion.com/v1/users/me → health check
// Auth: Bearer access token from the public-integration OAuth flow (no
// scopes; the user shares pages with the integration). Notion tokens do not
// expire; a 401 tries the vault refresher once and otherwise needs re-auth.
// 429 honours Retry-After. Docs: https://developers.notion.com/reference/intro
//
// MOCK MODE (no credential): deterministic demo workspace; every row
// flagged mock: true, titles carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { clampInt, liveFailure, tokenSourceFrom, ConnectorApiError, type LiveDeps } from "../live/http";
import {
  normalizeNotionId,
  notionPing,
  notionQueryDataSource,
  notionReadPage,
  notionResolveDataSource,
  notionSearch,
} from "../live/notion";

const MOCK_PAGES = [
  { id: "mock-page-1", title: "Content Strategy 2026 (MOCK)", type: "page", lastEdited: "2026-09-19T08:00:00Z" },
  { id: "mock-page-2", title: "Brand Voice (MOCK)", type: "page", lastEdited: "2026-08-12T13:00:00Z" },
  { id: "mock-db-1", title: "Blog Pipeline (MOCK)", type: "database", lastEdited: "2026-09-21T15:30:00Z" },
];

const MOCK_PAGE_TEXT: Record<string, string> = {
  "mock-page-1": "# Content Strategy 2026 (MOCK)\n\nGoal: 2 posts/week. Topics: implants, whitening, emergencies. Owner: content team.",
  "mock-page-2": "# Brand Voice (MOCK)\n\nWarm, plain-English, no jargon.",
};

export class NotionAdapter implements ConnectorAdapter {
  readonly key = "notion";
  readonly displayName = "Notion";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "search_pages",
        description: "Search Notion pages and databases the integration can access.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { query: strProp("Search text.") },
          required: ["query"],
        },
      },
      {
        name: "read_page",
        description: "Read a Notion page's content as plain text for use as a brief or brand context.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { pageId: strProp("Notion page id.") },
          required: ["pageId"],
        },
      },
      {
        name: "query_database",
        description: "Query a Notion database (e.g. a content pipeline) and return its rows.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            databaseId: strProp("Notion database id."),
            dataSourceId: strProp("Notion data source id (optional; defaults to the database's first data source)."),
            limit: strProp("Max rows (default 50)."),
          },
          required: ["databaseId"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return this.mockInvoke(tool, args);
    try {
      switch (tool) {
        case "search_pages": {
          const query = String(args.query ?? "").trim();
          if (query.length > 200) {
            throw new ConnectorApiError(this.displayName, "bad_request", `${this.displayName}: query must be at most 200 characters.`);
          }
          return liveOk(await notionSearch(auth, query, clampInt(args.limit, 25, 1, 100), this.deps));
        }
        case "read_page":
          return liveOk(await notionReadPage(auth, normalizeNotionId(args.pageId, "pageId"), this.deps));
        case "query_database": {
          const databaseId = args.databaseId ? normalizeNotionId(args.databaseId, "databaseId") : undefined;
          const dataSourceId = args.dataSourceId ? normalizeNotionId(args.dataSourceId, "dataSourceId") : undefined;
          const ds = await notionResolveDataSource(auth, { databaseId, dataSourceId }, this.deps);
          const rows = await notionQueryDataSource(auth, ds, clampInt(args.limit, 50, 1, 500), this.deps);
          return liveOk({ databaseId: databaseId ?? null, dataSourceId: ds, rows });
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, error: "No access token stored.", errorCode: "not_connected" };
    try {
      return liveOk(await notionPing(auth, this.deps));
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mockInvoke(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "search_pages": {
        const q = String(args.query).toLowerCase();
        return mockOk(
          MOCK_PAGES.filter((p) => p.title.toLowerCase().includes(q)).map((p) => ({ ...p, mock: true })),
        );
      }
      case "read_page": {
        const id = String(args.pageId);
        const page = MOCK_PAGES.find((p) => p.id === id);
        if (!page) return fail(`No page with id "${id}" (mock)`);
        return mockOk({
          pageId: id,
          title: page.title,
          text: `${MOCK_PAGE_TEXT[id] ?? "Page content (MOCK)."} (MOCK)`,
          mock: true,
        });
      }
      case "query_database":
        return mockOk({
          databaseId: args.databaseId,
          rows: [
            { id: "row-1", title: "Implant cost guide (MOCK)", status: "Draft", due: "2026-09-30", mock: true },
            { id: "row-2", title: "Whitening FAQ (MOCK)", status: "In review", due: "2026-10-07", mock: true },
            { id: "row-3", title: "Emergency care checklist (MOCK)", status: "Published", due: "2026-09-15", mock: true },
          ],
          mock: true,
        });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
