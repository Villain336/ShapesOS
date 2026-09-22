// Marketr — M21 Notion adapter.
//
// LIVE WIRING (not yet implemented): this adapter is MOCK-ONLY today. The
// live pass must call the Notion API (2022-06-28 version):
//   POST https://api.notion.com/v1/search
//     → search_pages()
//   GET  https://api.notion.com/v1/blocks/{blockId}/children?page_size=100
//     → read_page() (recurse children; append plain_text)
//   POST https://api.notion.com/v1/databases/{databaseId}/query
//     → query_database()
// Auth: OAuth2 Bearer access_token (public integration, capabilities
// granted per page by the user); refresh via lib/vault/refresh.ts. Header
// "Notion-Version: 2022-06-28" required. Docs:
// https://developers.notion.com/reference/intro
//
// MOCK MODE: deterministic demo workspace; every row flagged mock: true,
// titles carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, fail } from "../types";

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
          properties: { databaseId: strProp("Notion database id.") },
          required: ["databaseId"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    _credential: DecryptedCredential | null,
    _ctx: InvokeContext,
  ): Promise<InvokeResult> {
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
