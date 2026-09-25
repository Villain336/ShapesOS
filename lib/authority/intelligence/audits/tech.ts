// Marketr — Phase 6 I1 audit 12: Technology — NEW tech-audit crawler.
// Stack detection: CMS, analytics, pixels, schema + integrations inventory.
//
// The crawler fetches the primary domain's homepage with a short timeout and
// detects stack signals from the markup. When the domain is unreachable (or no
// domain is set), it reports labeled fixture findings — never a fabricated
// "everything looks fine".

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

interface CrawlResult {
  reachable: boolean;
  html: string;
  generator?: string;
}

async function crawlHomepage(domain: string): Promise<CrawlResult> {
  const url = domain.startsWith("http") ? domain : `https://${domain}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Marketr-TechAudit/1.0 (+intelligence-report)" },
      redirect: "follow",
    });
    if (!res.ok) return { reachable: false, html: "" };
    const html = (await res.text()).slice(0, 500_000);
    return { reachable: true, html };
  } catch {
    return { reachable: false, html: "" };
  } finally {
    clearTimeout(timer);
  }
}

function detect(html: string): Record<string, boolean> {
  const h = html.toLowerCase();
  return {
    wordpress: /wp-content|wp-includes|wordpress/.test(h),
    shopify: /cdn\.shopify|shopify-section|myshopify/.test(h),
    webflow: /webflow|assets-global\.website-files/.test(h),
    nextjs: /_next\/static|__next/.test(h),
    gtm: /googletagmanager\.com\/gtm/.test(h),
    ga4: /gtag\/js|google-analytics\.com\/g|ga4/.test(h),
    metaPixel: /connect\.facebook\.net\/.*fbevents/.test(h),
    tiktokPixel: /analytics\.tiktok\.com/.test(h),
    linkedinInsight: /snap\.licdn\.com/.test(h),
    schemaOrg: /schema\.org|application\/ld\+json/.test(h),
    openGraph: /property="og:/.test(h),
    sitemapRef: /sitemap/.test(h),
  };
}

export async function runTechAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  let signals = 0;

  if (!ctx.projectDomain) {
    findings.push({
      severity: "warn", title: "No domain to crawl",
      detail: "The tech crawler needs a primary domain from an SEO project.",
      dataSource: "tech-audit crawler (no target)",
    });
    return {
      id: "technology", name: "Technology", score: null, completeness: "unavailable",
      findings, dataSource: "tech-audit crawler (fake crawl fixtures)",
      computedAt: nowIso(),
    };
  }

  const crawl = await crawlHomepage(ctx.projectDomain);
  if (!crawl.reachable) {
    // Labeled fixture path — the domain didn't answer; say so.
    findings.push({
      severity: "warn",
      title: `${ctx.projectDomain} did not answer the crawler`,
      detail: "Homepage fetch failed or timed out — stack detection is a labeled fixture until a crawl succeeds. Check DNS, robots, and bot-blocking.",
      dataSource: "tech-audit crawler (fixture — crawl failed)",
    });
    const connections = await prisma.connectorConnection.count({
      where: { workspaceId: ctx.workspaceId, status: "active" },
    });
    findings.push({
      severity: "info",
      title: `${connections} active stack connection${connections === 1 ? "" : "s"} in the vault`,
      detail: "The integrations inventory below is real even when the crawl fails.",
      dataSource: "ConnectorConnection",
    });
    return {
      id: "technology", name: "Technology", score: null, completeness: "partial",
      findings, dataSource: "tech-audit crawler (fake crawl fixtures)",
      computedAt: nowIso(),
    };
  }

  signals += 1;
  const d = detect(crawl.html);
  const cms = d.wordpress ? "WordPress" : d.shopify ? "Shopify" : d.webflow ? "Webflow" : d.nextjs ? "Next.js" : "unknown/custom";
  findings.push({
    severity: cms === "unknown/custom" ? "info" : "info",
    title: `CMS: ${cms}`,
    detail: cms === "WordPress"
      ? "WordPress confirmed — keep core/plugins patched; the fix-agent ladder can handle content edits."
      : cms === "Shopify"
        ? "Shopify confirmed — conversion tracking should run through the native pixel + server events."
        : `Detected stack: ${cms}. Stack-specific playbooks apply.`,
    dataSource: "tech-audit crawler (live homepage fetch)",
  });

  const analytics: string[] = [];
  if (d.gtm) analytics.push("Google Tag Manager");
  if (d.ga4) analytics.push("GA4");
  if (analytics.length > 0) {
    signals += 1;
    findings.push({
      severity: "info", title: `Analytics present: ${analytics.join(", ")}`,
      detail: "Measurement foundation exists — connect GA4 in the stack so the report reads live numbers.",
      dataSource: "tech-audit crawler (live homepage fetch)",
    });
  } else {
    findings.push({
      severity: "critical", title: "No analytics detected on the homepage",
      detail: "Flying blind — install GA4 (or your analytics of choice) before spending a dollar on traffic.",
      dataSource: "tech-audit crawler (live homepage fetch)",
    });
  }

  const pixels = [
    d.metaPixel && "Meta pixel",
    d.tiktokPixel && "TikTok pixel",
    d.linkedinInsight && "LinkedIn Insight tag",
  ].filter(Boolean) as string[];
  if (pixels.length > 0) {
    signals += 1;
    findings.push({
      severity: "info", title: `Ad pixels present: ${pixels.join(", ")}`,
      detail: "Retargeting pools can build from day one of any paid push.",
      dataSource: "tech-audit crawler (live homepage fetch)",
    });
  } else {
    findings.push({
      severity: "warn", title: "No ad pixels detected",
      detail: "Install at least the Meta pixel now — retargeting audiences need 30+ days of history before they perform.",
      dataSource: "tech-audit crawler (live homepage fetch)",
    });
  }

  if (d.schemaOrg) {
    signals += 1;
    findings.push({
      severity: "info", title: "Structured data present",
      detail: "Schema.org markup detected — this is the citability foundation the AEO track (Phase 6 A1) builds on.",
      dataSource: "tech-audit crawler (live homepage fetch)",
    });
  } else {
    findings.push({
      severity: "warn", title: "No structured data detected",
      detail: "Add Organization + LocalBusiness schema — it's the cheapest AI-visibility win in the report.",
      dataSource: "tech-audit crawler (live homepage fetch)",
    });
  }
  if (!d.openGraph) {
    findings.push({
      severity: "warn", title: "Open Graph tags missing",
      detail: "Link shares render as bare URLs — add OG tags for the social surface.",
      dataSource: "tech-audit crawler (live homepage fetch)",
    });
  }

  const connections = await prisma.connectorConnection.count({
    where: { workspaceId: ctx.workspaceId, status: "active" },
  });
  findings.push({
    severity: "info",
    title: `Integrations inventory: ${connections} active connection${connections === 1 ? "" : "s"}`,
    detail: "Full list lives in the stack connectors panel.",
    dataSource: "ConnectorConnection",
  });

  return {
    id: "technology", name: "Technology",
    score: clampScore(40 + signals * 12 - (d.ga4 || d.gtm ? 0 : 20)),
    completeness: "full",
    findings, dataSource: "tech-audit crawler (live homepage fetch + fixtures)",
    computedAt: nowIso(),
  };
}
