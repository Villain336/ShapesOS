// ShapesOS Phase 11 (seotools): audit storage against Postgres (as the app
// role). A live crawl (stubbed fetcher — no network) stores a "live"
// SiteAudit with its crawl summary and URL findings; a live audit and a
// files audit supersede only their own kind of issue; the inbox returns the
// latest live audit; the start URL resolves from real deployments, never
// mock ones; Core Web Vitals (stubbed PSI) are stored on the audit; the fix
// agent never picks up a live finding.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/audit/__tests__/live-audit-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { FetchedPage } from "@/lib/intelligence/fleet/polite-fetch";
import { runAudit, getAuditInbox } from "../audit";
import { resolveLiveAuditUrl } from "../project-audit";
import { isIssueEligible } from "../runner";
import type { LiveFetcher } from "../live";
import { memoryProvider } from "./memory-provider";

const RUN = `p11a-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
let projectId = "";
let siteId = "";

const publicDns = async () => ["93.184.216.34"];
const fetcher: LiveFetcher = {
  async get(url): Promise<FetchedPage> {
    const pages: Record<string, string> = {
      "https://live.example/": `<html><head><title>Home</title></head><body><a href="/dead">x</a></body></html>`,
    };
    const text = pages[url];
    return { url, status: text ? 200 : 404, text: text ?? "", contentType: text ? "text/html" : "text/plain", redirects: [], headers: {} };
  },
};

// PageSpeed Insights stub (labelled mock): lab-only, poor LCP.
const psiStub = (async () =>
  new Response(
    JSON.stringify({
      loadingExperience: {},
      lighthouseResult: {
        lighthouseVersion: "12.2.0",
        categories: { performance: { score: 0.42 } },
        audits: { "largest-contentful-paint": { numericValue: 5100 }, "cumulative-layout-shift": { numericValue: 0.02 }, "total-blocking-time": { numericValue: 120 } },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

before(async () => {
  await prisma.workspace.create({ data: { id: WS, name: "P11 audit", ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: "fallback.example" } })).id;
  siteId = (await prisma.site.create({ data: { projectId, name: "Live site", sourceType: "file", configEnc: "" } })).id;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
});

describe("live audit storage", () => {
  it("resolves the start URL from a real deployment, else the project domain", async () => {
    assert.equal(await resolveLiveAuditUrl(siteId, projectId), "https://fallback.example");
    await prisma.deployment.create({ data: { siteId, projectId, target: "vercel", url: "https://mock-only.vercel.app", status: "ready", mock: true } });
    assert.equal(await resolveLiveAuditUrl(siteId, projectId), "https://fallback.example", "mock deployments never count");
    await prisma.deployment.create({ data: { siteId, projectId, target: "netlify", url: "live.example", status: "ready" } });
    assert.equal(await resolveLiveAuditUrl(siteId, projectId), "https://live.example");
  });

  it("stores a live audit with its crawl summary and URL findings", async () => {
    // A files audit first, so we can see the live one leave it alone.
    const files = await runAudit({
      siteId,
      projectId,
      siteName: "Live site",
      provider: memoryProvider({ "/index.html": "<html><head></head><body><img src=a.png></body></html>" }),
      mock: false,
      skipMetering: true,
    });
    assert.equal(files.audit.mode, "files");
    const filesOpen = files.issues.length;
    assert.ok(filesOpen > 0);

    const live = await runAudit({
      siteId,
      projectId,
      siteName: "Live site",
      provider: null,
      mock: false,
      skipMetering: true,
      live: { url: "https://live.example/", fetcher, resolve: publicDns, maxExternalChecks: 0, vitals: { fetchImpl: psiStub, strategies: ["mobile"] } },
    });
    assert.equal(live.audit.mode, "live");
    // Core Web Vitals stored on the audit, and the poor lab LCP became a finding.
    const vitals = live.audit.vitals as { source: string; strategies: { strategy: string; lab: { performanceScore: number; lcp: { value: number; rating: string } } }[] };
    assert.equal(vitals.source, "pagespeed-insights");
    assert.equal(vitals.strategies[0].lab.performanceScore, 42);
    assert.deepEqual(vitals.strategies[0].lab.lcp, { value: 5100, rating: "poor" });
    assert.ok(live.issues.some((i) => i.category === "poor-core-web-vitals" && i.filePath === "https://live.example/"));
    assert.equal(live.audit.targetUrl, "https://live.example/");
    assert.equal(live.audit.status, "completed");
    const crawl = live.audit.crawl as { pagesCrawled: number; rendering: string; statusCounts: Record<string, number> };
    assert.equal(crawl.pagesCrawled, 2);
    assert.equal(crawl.rendering, "static");
    assert.deepEqual(crawl.statusCounts, { "2xx": 1, "4xx": 1 });
    assert.ok(live.issues.every((i) => i.filePath.startsWith("https://") && !i.autoFixable));
    assert.ok(live.issues.some((i) => i.category === "broken-internal-link" && i.severity === "error"));

    const stillOpenFiles = await prisma.siteIssue.count({ where: { siteId, auditId: files.audit.id, status: "open" } });
    assert.equal(stillOpenFiles, filesOpen, "a live audit does not supersede files findings");

    const inbox = await getAuditInbox(siteId);
    assert.equal(inbox.latestLiveAudit?.id, live.audit.id);
    assert.equal(inbox.issues.length, filesOpen + live.issues.length);

    // A second live audit supersedes the first one's issues only.
    const again = await runAudit({
      siteId,
      projectId,
      siteName: "Live site",
      provider: null,
      mock: false,
      skipMetering: true,
      live: { url: "https://live.example/", fetcher, resolve: publicDns, maxExternalChecks: 0, vitals: false },
    });
    assert.equal(again.audit.vitals, null, "vitals: false never stores a measurement");
    assert.equal(await prisma.siteIssue.count({ where: { auditId: live.audit.id, status: "open" } }), 0);
    assert.equal(await prisma.siteIssue.count({ where: { auditId: files.audit.id, status: "open" } }), filesOpen);
    assert.equal(await prisma.siteIssue.count({ where: { auditId: again.audit.id, status: "open" } }), again.issues.length);
  });

  it("never makes a live finding eligible for the fix agent, even when approved", async () => {
    const issue = await prisma.siteIssue.findFirstOrThrow({ where: { siteId, filePath: { startsWith: "https://" }, status: "open" } });
    await prisma.siteIssue.update({ where: { id: issue.id }, data: { status: "approved", autoFixable: true } });
    const row = await prisma.siteIssue.findUniqueOrThrow({ where: { id: issue.id } });
    assert.equal(isIssueEligible(row, { enabled: true, allowedCategories: [row.category] }), false);
  });

  it("marks the audit failed when the start URL is refused", async () => {
    await assert.rejects(
      runAudit({ siteId, projectId, siteName: "Live site", provider: null, mock: false, skipMetering: true, live: { url: "http://10.0.0.1/", fetcher, vitals: false } }),
      /Can't audit that URL/,
    );
    const last = await prisma.siteAudit.findFirstOrThrow({ where: { siteId }, orderBy: { createdAt: "desc" } });
    assert.equal(last.status, "failed");
    assert.equal(last.mode, "live");
  });
});
