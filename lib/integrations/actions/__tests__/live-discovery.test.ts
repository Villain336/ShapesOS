// Phase 6: live Composio tool discovery (LiveComposioToolRouter) against a
// stubbed Composio API — toolkit directory paging + caching, v1 slug
// mapping, per-toolkit tool paging, deprecated/duplicate handling, router
// selection by COMPOSIO_API_KEY, and discovered tools classified by the
// unchanged classifyAction() exactly like fixtures. No network.
// Run: npx tsx --test lib/integrations/actions/__tests__/live-discovery.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  LiveComposioToolRouter,
  fixtureToolRouter,
  getToolRouter,
} from "../discovery";
import { classifyAction } from "../risk";
import { categoryFromHints } from "../toolkits";
import { ComposioApiError, type ComposioHttp } from "@/lib/integrations/composio";

type Handler = (path: string) => unknown;

function stubHttp(handler: Handler) {
  const paths: string[] = [];
  const http: ComposioHttp = {
    async request<T>(path: string): Promise<T> {
      paths.push(path);
      return handler(path) as T;
    },
  };
  return { http, paths };
}

function query(path: string): URLSearchParams {
  return new URL(path, "https://x.test").searchParams;
}

const TOOLKIT_PAGE_1 = {
  items: [
    { slug: "googlesheets", name: "Google Sheets", meta: { description: "Spreadsheets", tools_count: 42, categories: [{ id: "productivity", name: "Productivity" }] } },
    { slug: "salesforce", name: "Salesforce", meta: { description: "CRM", tools_count: 3, categories: [{ id: "crm", name: "CRM" }] } },
  ],
  next_cursor: "c2",
};
const TOOLKIT_PAGE_2 = {
  items: [
    { slug: "zendesk", name: "Zendesk", meta: { description: "Support", tools_count: 2, categories: ["Customer Support"] } },
    { slug: "", name: "broken" },
    { slug: "salesforce", name: "dupe" },
  ],
  next_cursor: null,
};

const SALESFORCE_TOOLS_1 = {
  items: [
    { slug: "SALESFORCE_LIST_LEADS", name: "List leads", description: "List Salesforce leads (paginated)." },
    { slug: "salesforce_delete_lead", name: "Delete lead", description: "Delete a Salesforce lead." },
    { slug: "SALESFORCE_OLD_THING", name: "Old", description: "Deprecated tool", is_deprecated: true },
  ],
  next_cursor: "t2",
};
const SALESFORCE_TOOLS_2 = {
  items: [
    { slug: "SALESFORCE_LIST_LEADS", name: "dupe" },
    { slug: "SALESFORCE_ORCHESTRATE_LEDGER", name: "Orchestrate ledger", description: "Reconcile the ledger across connected accounts." },
  ],
  next_cursor: null,
};

function directoryHandler(path: string): unknown {
  if (path.startsWith("/toolkits")) return query(path).get("cursor") === "c2" ? TOOLKIT_PAGE_2 : TOOLKIT_PAGE_1;
  if (path.startsWith("/tools")) {
    const q = query(path);
    if (q.get("toolkit_slug") === "salesforce") return q.get("cursor") === "t2" ? SALESFORCE_TOOLS_2 : SALESFORCE_TOOLS_1;
    return { items: [{ slug: "GOOGLESHEETS_BATCH_GET", name: "Batch get", description: "Read values from a spreadsheet." }] };
  }
  throw new Error(`unexpected ${path}`);
}

const savedKey = process.env.COMPOSIO_API_KEY;
const savedFetch = globalThis.fetch;
afterEach(() => {
  if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = savedKey;
  globalThis.fetch = savedFetch;
});

describe("LiveComposioToolRouter", () => {
  it("lists the toolkit directory across cursor pages and maps v1 slugs", async () => {
    const { http, paths } = stubHttp(directoryHandler);
    const toolkits = await new LiveComposioToolRouter(http).listToolkits();
    assert.deepEqual(paths, ["/toolkits?limit=1000", "/toolkits?limit=1000&cursor=c2"]);
    assert.deepEqual(toolkits, [
      // Composio's "googlesheets" keeps the v1 slug + appKey (enablement
      // defaults, pinned catalog and existing connections line up).
      { toolkitSlug: "google_sheets", appKey: "google-sheets", label: "Google Sheets", description: "Spreadsheets", toolCount: 42, categories: ["productivity"] },
      { toolkitSlug: "salesforce", appKey: "salesforce", label: "Salesforce", description: "CRM", toolCount: 3, categories: ["crm"] },
      { toolkitSlug: "zendesk", appKey: "zendesk", label: "Zendesk", description: "Support", toolCount: 2, categories: ["customer support"] },
    ]);
  });

  it("caches the directory for 10 minutes, then refetches", async () => {
    const { http, paths } = stubHttp(directoryHandler);
    let now = 1_000_000;
    const router = new LiveComposioToolRouter(http, () => now);
    await router.listToolkits();
    now += 9 * 60_000;
    await router.listToolkits();
    assert.equal(paths.length, 2, "second call served from cache");
    now += 2 * 60_000;
    await router.listToolkits();
    assert.equal(paths.length, 4, "refetched after the TTL");
  });

  it("lists a toolkit's tools: latest versions, cursor paging, deprecated skipped, slugs upper-cased + de-duplicated", async () => {
    const { http, paths } = stubHttp(directoryHandler);
    const router = new LiveComposioToolRouter(http);
    const tools = await router.getToolkitTools("salesforce");
    const toolPaths = paths.filter((p) => p.startsWith("/tools"));
    assert.equal(toolPaths.length, 2);
    const q1 = query(toolPaths[0]);
    assert.equal(q1.get("toolkit_slug"), "salesforce");
    assert.equal(q1.get("toolkit_versions"), "latest");
    assert.equal(q1.get("limit"), "1000");
    assert.equal(query(toolPaths[1]).get("cursor"), "t2");
    assert.deepEqual(tools, [
      { slug: "SALESFORCE_LIST_LEADS", label: "List leads", description: "List Salesforce leads (paginated)." },
      { slug: "SALESFORCE_DELETE_LEAD", label: "Delete lead", description: "Delete a Salesforce lead." },
      { slug: "SALESFORCE_ORCHESTRATE_LEDGER", label: "Orchestrate ledger", description: "Reconcile the ledger across connected accounts." },
    ]);
  });

  it("asks Composio for a v1 toolkit under its live slug", async () => {
    const { http, paths } = stubHttp(directoryHandler);
    const tools = await new LiveComposioToolRouter(http).getToolkitTools("google_sheets");
    assert.equal(query(paths.find((p) => p.startsWith("/tools"))!).get("toolkit_slug"), "googlesheets");
    assert.equal(tools[0].slug, "GOOGLESHEETS_BATCH_GET");
  });

  it("refuses an unknown toolkit and surfaces API errors (no silent fixture fallback)", async () => {
    const { http } = stubHttp(directoryHandler);
    await assert.rejects(new LiveComposioToolRouter(http).getToolkitTools("nope"), /Unknown toolkit "nope"/);
    const failing = stubHttp(() => {
      throw new ComposioApiError(401, "invalid api key");
    });
    await assert.rejects(new LiveComposioToolRouter(failing.http).listToolkits(), (e: unknown) => e instanceof ComposioApiError && e.status === 401);
  });

  it("discovered tools go through the unchanged classifyAction like fixtures", async () => {
    const { http } = stubHttp(directoryHandler);
    const live = await new LiveComposioToolRouter(http).getToolkitTools("salesforce");
    const fixture = await fixtureToolRouter.getToolkitTools("salesforce");
    for (const t of live) {
      const fromLive = classifyAction(t.slug, null, { appKey: "salesforce" });
      const twin = fixture.find((f) => f.slug === t.slug);
      if (twin) assert.deepEqual(fromLive, classifyAction(twin.slug, null, { appKey: "salesforce" }), t.slug);
    }
    const bySlug = Object.fromEntries(live.map((t) => [t.slug, classifyAction(t.slug, null, { appKey: "salesforce" })]));
    assert.equal(bySlug.SALESFORCE_LIST_LEADS.tier, "low");
    assert.equal(bySlug.SALESFORCE_DELETE_LEAD.tier, "high");
    assert.equal(bySlug.SALESFORCE_DELETE_LEAD.autoExecutable, false);
    // Unclassifiable discovered tool → conservative floor (high-gated).
    assert.equal(bySlug.SALESFORCE_ORCHESTRATE_LEDGER.classified, false);
    assert.equal(bySlug.SALESFORCE_ORCHESTRATE_LEDGER.autoExecutable, false);
  });
});

describe("getToolRouter", () => {
  it("is the fixture router without a key", () => {
    delete process.env.COMPOSIO_API_KEY;
    assert.equal(getToolRouter(), fixtureToolRouter);
    process.env.COMPOSIO_API_KEY = "   ";
    assert.equal(getToolRouter(), fixtureToolRouter);
  });

  it("is a live router with a key (memoized per key) that calls Composio with x-api-key", async () => {
    process.env.COMPOSIO_API_KEY = "ck_live_test_key_123";
    const a = getToolRouter();
    assert.ok(a instanceof LiveComposioToolRouter);
    assert.equal(getToolRouter(), a, "same key → same router (directory cache survives)");

    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ items: [{ slug: "slack", name: "Slack", meta: { tools_count: 5 } }], next_cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    process.env.COMPOSIO_API_KEY = "ck_live_other_key_456";
    const b = getToolRouter();
    assert.notEqual(b, a, "a different key gets a fresh router");
    const toolkits = await b.listToolkits();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://backend.composio.dev/api/v3/toolkits?limit=1000");
    assert.equal(calls[0].headers.get("x-api-key"), "ck_live_other_key_456");
    assert.deepEqual(toolkits.map((t) => [t.toolkitSlug, t.appKey, t.toolCount]), [["slack", "slack", 5]]);
  });
});

describe("categoryFromHints", () => {
  it("maps Composio category names onto the six buckets", () => {
    assert.equal(categoryFromHints(["customer support"]), "support");
    assert.equal(categoryFromHints(["crm"]), "crm");
    assert.equal(categoryFromHints(["communication"]), "comms");
    assert.equal(categoryFromHints(["accounting"]), "payments");
    assert.equal(categoryFromHints(["document management"]), "files");
    assert.equal(categoryFromHints(["developer tools"]), null);
    assert.equal(categoryFromHints(undefined), null);
  });
});
