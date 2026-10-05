// ShapesOS — Phase 6: MCP run_seo_audit / get_keyword_ideas call the real
// implementations behind the chat tools, and are labelled mock only when the
// underlying provider is the mock one.
//
//   - run_seo_audit → lib/audit/project-audit (runAudit): a real file scan
//     for a file site (live:true, rows in the audit inbox), the labelled mock
//     scan for a demo site; never a second site_audit ledger charge (the MCP
//     runner already charged — T14).
//   - get_keyword_ideas → getSeoProvider().keywordIdeas: live provider rows
//     unlabelled, the built-in mock provider's rows labelled; serp_calls
//     usage recorded like the in-app paths.
//
// DB-backed (listed in scripts/test/db-tests.txt). The SEO provider is
// swapped with node:test mock.module (scripts/test/run.mjs passes the flag).
// Needs MARKETR_CREDENTIALS_KEY (site config encryption).

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { MockSeoProvider } from "@/lib/providers/mock";
import type { KeywordIdea, SeoDataProvider } from "@/lib/providers/types";
import type { McpAuthContext } from "@/lib/mcp/auth";

const WS = "p6-mcp-vendor-ws";
const WS_OTHER = "p6-mcp-vendor-ws-other";
const USER = "p6-mcp-vendor-user";

const liveIdeas: KeywordIdea[] = [
  { phrase: "roof repair cost", volume: 1900, difficulty: 31, cpc: 7.5, intent: "commercial" },
  { phrase: "roof repair near me", volume: 5400, difficulty: 44, cpc: 9.1, intent: "transactional" },
];
const fakeLive = {
  name: "dataforseo",
  isLive: true,
  isConfigured: () => true,
  keywordIdeas: async () => liveIdeas,
} as unknown as SeoDataProvider;
let current: SeoDataProvider = new MockSeoProvider();
mock.module("@/lib/providers", {
  namedExports: {
    getSeoProvider: () => current,
    providerStatus: () => ({ name: current.name, isLive: current.isLive, configured: current.isConfigured() }),
  },
});

let tools: typeof import("@/lib/mcp/tools");
const parseArgs = (tool: { inputSchema: { parse(v: unknown): unknown } }, v: unknown) =>
  tool.inputSchema.parse(v) as Record<string, unknown>;
const storage = mkdtempSync(join(tmpdir(), "p6-mcp-sites-"));

const ctx: McpAuthContext = {
  workspaceId: WS,
  credential: { kind: "oauth", clientId: "p6-test-client" },
  scopes: ["tools:run_seo_audit", "tools:get_keyword_ideas"],
  userId: USER,
};

let projectId = "";
let fileSiteId = "";
let demoSiteId = "";
let otherProjectId = "";

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id IN (${WS}, ${WS_OTHER})`;
}

async function serpCalls(): Promise<number> {
  const rows = await prisma.apiUsage.findMany({ where: { workspaceId: WS, meter: "serp_calls" } });
  return rows.reduce((n, r) => n + r.quantity, 0);
}

describe("MCP vendor-backed tools use the real implementations (DB)", () => {
  before(async () => {
    process.env.SITE_STORAGE_DIR = storage;
    await cleanup();
    for (const ws of [WS, WS_OTHER]) {
      await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at, mcp_enabled)
        VALUES (${ws}, ${ws}, ${USER}, now(), true)`;
    }
    const { encryptSiteConfig } = await import("@/lib/connectors/source");
    const project = await prisma.project.create({ data: { workspaceId: WS, domain: "roofs.example.test" } });
    projectId = project.id;
    const other = await prisma.project.create({ data: { workspaceId: WS_OTHER, domain: "other.example.test" } });
    otherProjectId = other.id;
    const fileSite = await prisma.site.create({
      data: { projectId, name: "Roofs static", sourceType: "file", configEnc: encryptSiteConfig({}) },
    });
    fileSiteId = fileSite.id;
    const dir = join(storage, fileSiteId, "working");
    mkdirSync(dir, { recursive: true });
    // No <title>, no meta description → real scanner findings.
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><head></head><body><h1>Roofs</h1></body></html>");
    const demo = await prisma.site.create({
      data: {
        projectId,
        name: "Demo repo",
        sourceType: "github",
        configEnc: encryptSiteConfig({ demo: true, owner: "demo", repo: "demo", branch: "main" }),
      },
    });
    demoSiteId = demo.id;
    tools = await import("@/lib/mcp/tools");
  });

  after(async () => {
    await cleanup();
    rmSync(storage, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it("run_seo_audit on a file site runs the real scan (live, unlabelled) and charges nothing itself", async () => {
    const tool = tools.getTool("run_seo_audit")!;
    const args = parseArgs(tool, { projectId, siteId: fileSiteId });
    const { data } = await tool.handler(ctx, args);
    assert.equal(data.live, true);
    assert.equal(data.mock, false);
    assert.equal("note" in data, false);
    assert.equal(data.siteId, fileSiteId);
    const findings = data.findings as Array<Record<string, unknown>>;
    assert.ok(findings.length > 0, "the real scanner found the missing title/meta");
    assert.ok(findings.every((f) => f.mock === undefined));
    assert.ok(findings.some((f) => f.filePath === "index.html" || f.filePath === "/index.html"));
    // The audit inbox has the rows (same as the chat tool path).
    const audit = await prisma.siteAudit.findUniqueOrThrow({ where: { id: data.auditId as string } });
    assert.equal(audit.mock, false);
    assert.equal(audit.status, "completed");
    assert.equal(await prisma.siteIssue.count({ where: { auditId: audit.id } }), data.issueCount);
    // T14: the MCP runner charged site_audit already; runAudit must not.
    assert.equal(await prisma.usageEvent.count({ where: { idempotencyKey: `siteaudit:${audit.id}` } }), 0);
  });

  it("run_seo_audit defaults to the first file-backed site", async () => {
    const tool = tools.getTool("run_seo_audit")!;
    const { data } = await tool.handler(ctx, parseArgs(tool, { projectId }));
    assert.equal(data.siteId, fileSiteId);
  });

  it("run_seo_audit on a demo site returns labelled mock findings", async () => {
    const tool = tools.getTool("run_seo_audit")!;
    const { data } = await tool.handler(ctx, parseArgs(tool, { projectId, siteId: demoSiteId }));
    assert.equal(data.live, false);
    assert.equal(data.mock, true);
    assert.match(String(data.note), /Mock data/);
    const findings = data.findings as Array<Record<string, unknown>>;
    assert.ok(findings.length > 0 && findings.every((f) => f.mock === true));
    const audit = await prisma.siteAudit.findUniqueOrThrow({ where: { id: data.auditId as string } });
    assert.equal(audit.mock, true);
  });

  it("run_seo_audit refuses foreign projects and unknown sites", async () => {
    const tool = tools.getTool("run_seo_audit")!;
    await assert.rejects(
      tool.handler(ctx, parseArgs(tool, { projectId: otherProjectId })),
      (e: unknown) => e instanceof tools.ToolError && e.code === "project_not_found",
    );
    await assert.rejects(
      tool.handler(ctx, parseArgs(tool, { projectId, siteId: "nope" })),
      (e: unknown) => e instanceof tools.ToolError && e.code === "no_auditable_site",
    );
    // Strict args: unknown keys (e.g. a workspaceId) are still rejected.
    assert.equal(tool.inputSchema.safeParse({ projectId, workspaceId: WS }).success, false);
  });

  it("get_keyword_ideas with the mock provider is labelled mock", async () => {
    current = new MockSeoProvider();
    const tool = tools.getTool("get_keyword_ideas")!;
    const before = await serpCalls();
    const { data } = await tool.handler(ctx, parseArgs(tool, { seed: "roof repair", limit: 5 }));
    assert.equal(data.live, false);
    assert.equal(data.mock, true);
    assert.match(String(data.note), /Mock data/);
    const ideas = data.ideas as Array<Record<string, unknown>>;
    assert.ok(ideas.length > 0 && ideas.length <= 5);
    assert.ok(ideas.every((i) => i.mock === true));
    assert.equal(await serpCalls(), before + 1, "serp_calls recorded like the chat tool");
  });

  it("get_keyword_ideas with a live provider returns its rows unlabelled", async () => {
    current = fakeLive;
    const tool = tools.getTool("get_keyword_ideas")!;
    const before = await serpCalls();
    const { data } = await tool.handler(ctx, parseArgs(tool, { seed: "roof repair", limit: 10 }));
    assert.equal(data.live, true);
    assert.equal(data.mock, false);
    assert.equal("note" in data, false);
    assert.equal(data.provider, "dataforseo");
    assert.deepEqual(
      (data.ideas as Array<Record<string, unknown>>).map((i) => i.phrase),
      liveIdeas.map((i) => i.phrase),
    );
    assert.ok((data.ideas as Array<Record<string, unknown>>).every((i) => i.mock === undefined && typeof i.volume === "number"));
    assert.equal(await serpCalls(), before + 1);
  });

  it("get_keyword_ideas surfaces a vendor failure as a coded error (no fake rows)", async () => {
    current = { ...fakeLive, keywordIdeas: async () => { throw new Error("upstream 500 with secret-ish detail"); } } as SeoDataProvider;
    const tool = tools.getTool("get_keyword_ideas")!;
    await assert.rejects(
      tool.handler(ctx, parseArgs(tool, { seed: "roof" })),
      (e: unknown) => e instanceof tools.ToolError && e.code === "keyword_provider_failed" && !/secret/.test((e as Error).message),
    );
  });

  it("scopes and credit passthrough are unchanged", async () => {
    const { TOOL_CREDIT_PASSTHROUGH, TOOL_MIN_ROLE } = await import("@/lib/mcp/scopes");
    assert.deepEqual(TOOL_CREDIT_PASSTHROUGH.run_seo_audit, { action: "site_audit", credits: 30 });
    assert.deepEqual(TOOL_CREDIT_PASSTHROUGH.get_keyword_ideas, { action: "keyword_ideas", credits: 50 });
    assert.equal(TOOL_MIN_ROLE.run_seo_audit, "editor");
    assert.equal(TOOL_MIN_ROLE.get_keyword_ideas, "editor");
  });
});
