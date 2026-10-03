// Marketr — Phase 8 G1: Tier-M manual/assisted connectors (SPEC-PHASE8.md §2 G1).
//
// WooCommerce (per-site consumer key handoff + GENTLE polling — never melt a
// shared host), CSV import, and the onboarding-wizard bootstrap that seeds
// entities from a Phase 6 Intelligence Report's 12 audits (flow B1).

import { prisma } from "@/lib/prisma";
import { appendFact } from "../facts";
import { resolveMode, platformSpec } from "./types";
import { withWorkspaceScope } from "../rls";
import type { FactPayload } from "../types";

// ---------------------------------------------------------------------------
// WooCommerce: gentle polling. The spec is blunt — no central OAuth,
// host-dependent webhooks, per-site key handoffs — so the poller enforces a
// floor on the interval (default 15 min) and small pages. Webhooks are
// treated as opportunistic (best-effort), never relied upon.
// ---------------------------------------------------------------------------

export interface WooPollResult {
  ran: boolean;
  rowsIngested: number;
  detail: string;
}

export async function pollWooCommerce(opts: {
  workspaceId: string;
  connectorId: string;
  now?: Date;
}): Promise<WooPollResult> {
  const { workspaceId, connectorId } = opts;
  const now = opts.now ?? new Date();
  return withWorkspaceScope(workspaceId, async (tx) => {
    const connector = await tx.graphConnector.findFirst({
      where: { workspaceId, id: connectorId, platform: "woocommerce" },
    });
    if (!connector) throw new Error("woocommerce connector not found");
    const spec = platformSpec("woocommerce");
    const minInterval = (spec.rateBudget.minPollIntervalSec ?? 900) * 1000;

    let job = await tx.graphSyncJob.findFirst({ where: { workspaceId, connectorId } });
    if (job?.lastRunAt && now.getTime() - job.lastRunAt.getTime() < minInterval) {
      return {
        ran: false,
        rowsIngested: 0,
        detail: `gentle polling: last run ${job.lastRunAt.toISOString()} — next run no earlier than ${new Date(job.lastRunAt.getTime() + minInterval).toISOString()}`,
      };
    }

    const { mode, reason } = resolveMode(connector);
    if (!job) {
      job = await tx.graphSyncJob.create({
        data: { workspaceId, connectorId, tier: "manual", cursorState: {}, rateBudget: spec.rateBudget as unknown as object },
      });
    }
    await tx.graphSyncJob.update({
      where: { id: job.id, workspaceId },
      data: { status: "running", lastRunAt: now },
    });

    try {
      // Fake mode: fixture rows, no network. Live mode: the WooCommerce REST
      // client lands here (consumer key/secret from the vault, page size ≤25,
      // sequential pages, never parallel against a shared host).
      if (mode !== "fake") {
        throw new Error(
          "woocommerce live poll not configured — per-site consumer key handoff required (see connector honesty note)",
        );
      }
      const rows = wooFixtureRows(now);
      let ingested = 0;
      for (const row of rows) {
        const fact = await appendFact(
          {
            workspaceId,
            source: connector.id,
            sourceRecordId: row.sourceRecordId,
            entityRef: row.entityRef,
            factType: row.factType,
            payload: row.payload,
            observedAt: row.observedAt,
            actor: "sync:woocommerce",
            deferProjection: true,
          },
          tx,
        );
        const { projectFact } = await import("../project");
        await projectFact(tx, fact);
        ingested++;
      }
      await tx.graphSyncJob.update({
        where: { id: job.id, workspaceId },
        data: { status: "succeeded", lastSuccessAt: now, errorCount: 0, backoffUntil: null },
      });
      return { ran: true, rowsIngested: ingested, detail: `${ingested} row(s) (fake mode: ${reason})` };
    } catch (e) {
      await tx.graphSyncJob.update({
        where: { id: job.id, workspaceId },
        data: { status: "failed", errorCount: { increment: 1 } },
      });
      return { ran: true, rowsIngested: 0, detail: `poll failed honestly: ${(e as Error).message}` };
    }
  });
}

function wooFixtureRows(now: Date) {
  return [
    {
      entityRef: "product:sku:woo-tee-001",
      factType: "woo_product",
      sourceRecordId: "woo:product:101",
      observedAt: now,
      payload: {
        displayName: "Organic Cotton Tee",
        core: { sku: "woo-tee-001", externalId: "101" },
        properties: { price: "29.00", stock: 42 },
      } as FactPayload,
    },
  ];
}

// ---------------------------------------------------------------------------
// CSV import: rows → facts with source "import". The caller supplies the
// column→field mapping; unmapped columns land in properties.
// ---------------------------------------------------------------------------

export interface CsvMapping {
  entityType: string;
  displayNameCol?: string;
  coreCols?: Record<string, string>; // core field -> csv column
}

export async function importCsv(opts: {
  workspaceId: string;
  rows: Array<Record<string, string>>;
  mapping: CsvMapping;
  actor?: string;
}): Promise<{ facts: number; skipped: number }> {
  const { workspaceId, rows, mapping } = opts;
  let facts = 0;
  let skipped = 0;
  for (const [i, row] of rows.entries()) {
    const core: Record<string, unknown> = {};
    for (const [field, col] of Object.entries(mapping.coreCols ?? {})) {
      if (row[col] !== undefined) core[field] = row[col];
    }
    const properties: Record<string, unknown> = {};
    for (const [col, val] of Object.entries(row)) {
      if (!Object.values(mapping.coreCols ?? {}).includes(col) && col !== mapping.displayNameCol) {
        properties[col] = val;
      }
    }
    const displayName =
      (mapping.displayNameCol ? row[mapping.displayNameCol] : undefined) ??
      `CSV row ${i + 1}`;
    const { canonicalKeyFor } = await import("../types");
    const { ENTITY_TYPES } = await import("../types");
    const entityType = (ENTITY_TYPES as string[]).includes(mapping.entityType)
      ? mapping.entityType
      : "crm_record";
    const canonicalKey = canonicalKeyFor(entityType as never, core);
    const before = await withWorkspaceScope(workspaceId, (tx) =>
      tx.graphFact.count({ where: { workspaceId } }),
    );
    await appendFact({
      workspaceId,
      source: "import",
      sourceRecordId: `csv:${i}`,
      entityRef: canonicalKey,
      factType: `csv_${entityType}`,
      payload: { displayName, core, properties },
      actor: opts.actor ?? "user:csv-import",
    });
    const after = await withWorkspaceScope(workspaceId, (tx) =>
      tx.graphFact.count({ where: { workspaceId } }),
    );
    if (after > before) facts++;
    else skipped++;
  }
  return { facts, skipped };
}

// ---------------------------------------------------------------------------
// Onboarding bootstrap (flow B1): the Phase 6 Intelligence Report's 12
// audits seed the initial graph — competitors, keywords, content gaps,
// reviews, local entities — as graph_facts with source "onboarding". The
// client has a living graph on day one, not an empty schema.
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  facts: number;
  byType: Record<string, number>;
  detail: string;
}

export async function bootstrapFromIntelligenceReport(opts: {
  workspaceId: string;
  reportId: string;
  actor?: string;
}): Promise<BootstrapResult> {
  const { workspaceId, reportId } = opts;
  // NOTE: intentionally bypasses withWorkspaceScope for the report read —
  // the IntelligenceReport table predates RLS; workspace is filtered in the
  // WHERE clause and the caller is already workspace-authorized.
  const report = await prisma.intelligenceReport.findFirst({
    where: { id: reportId, workspaceId },
  });
  if (!report) throw new Error("intelligence report not found");
  const audits = (report.auditsJson ?? {}) as Record<string, unknown>;
  const opportunities = (report.opportunitiesJson ?? []) as Array<Record<string, unknown>>;

  const byType: Record<string, number> = {};
  let facts = 0;
  const seed = async (
    entityRef: string,
    factType: string,
    payload: FactPayload,
    sourceRecordId: string,
  ) => {
    await appendFact({
      workspaceId,
      source: "onboarding",
      sourceRecordId: `ir:${reportId}:${sourceRecordId}`,
      entityRef,
      factType,
      payload,
      observedAt: report.generatedAt ?? report.createdAt,
      actor: opts.actor ?? "system:onboarding",
    });
    facts++;
    byType[factType] = (byType[factType] ?? 0) + 1;
  };

  // Competitors (from the competitor audit, shape-tolerant).
  const competitors = extractList(audits, ["competitors", "competitor_analysis", "competitorAudit"]);
  for (const c of competitors.slice(0, 50)) {
    const name = str(c.name ?? c.domain ?? c.title);
    if (!name) continue;
    await seed(
      `competitor:${str(c.domain).toLowerCase() || name.toLowerCase()}`,
      "onboarding_competitor",
      {
        displayName: name,
        core: { name, domain: str(c.domain).toLowerCase() },
        properties: { source: "intelligence_report" },
      },
      `competitor:${name.toLowerCase()}`,
    );
  }

  // Keywords (from the keyword audit).
  const keywords = extractList(audits, ["keywords", "keyword_gap", "keywordAudit"]);
  for (const k of keywords.slice(0, 200)) {
    const term = str(k.term ?? k.keyword ?? k.query);
    if (!term) continue;
    await seed(
      `keyword:${term.toLowerCase()}`,
      "onboarding_keyword",
      {
        displayName: term,
        core: { term: term.toLowerCase(), intent: str(k.intent), volume: k.volume },
        properties: { source: "intelligence_report" },
      },
      `keyword:${term.toLowerCase()}`,
    );
  }

  // Content gaps → content nodes.
  const gaps = extractList(audits, ["content_gaps", "contentGap", "content"]);
  for (const g of gaps.slice(0, 100)) {
    const title = str(g.title ?? g.topic ?? g.url);
    if (!title) continue;
    await seed(
      `content:${str(g.url).toLowerCase() || title.toLowerCase()}`,
      "onboarding_content_gap",
      {
        displayName: title,
        core: { title, url: str(g.url) },
        properties: { source: "intelligence_report", gap: true },
      },
      `content:${title.toLowerCase().slice(0, 60)}`,
    );
  }

  // Reviews (from the review audit).
  const reviews = extractList(audits, ["reviews", "review_audit", "reputation"]);
  for (const r of reviews.slice(0, 100)) {
    const id = str(r.externalId ?? r.id ?? r.url);
    if (!id) continue;
    await seed(
      `review:${id.toLowerCase()}`,
      "onboarding_review",
      {
        displayName: `Review by ${str(r.author) || "unknown"}`,
        core: { externalId: id, author: str(r.author), rating: r.rating, url: str(r.url) },
        properties: { source: "intelligence_report", text: str(r.text).slice(0, 500) },
      },
      `review:${id.toLowerCase()}`,
    );
  }

  // Opportunities → offers (each opportunity becomes a trackable offer node).
  for (const o of opportunities.slice(0, 50)) {
    const title = str(o.title ?? o.name);
    if (!title) continue;
    await seed(
      `offer:${title.toLowerCase().slice(0, 80)}`,
      "onboarding_opportunity",
      {
        displayName: title,
        core: { name: title },
        properties: { source: "intelligence_report", impact: o.impact, effort: o.effort },
      },
      `opportunity:${title.toLowerCase().slice(0, 60)}`,
    );
  }

  // ER cascade over the seeded graph — duplicates across audits resolve via
  // the human queue, never silently.
  const { resolveWorkspace } = await import("../resolve");
  const er = await resolveWorkspace(workspaceId);

  return {
    facts,
    byType,
    detail: `${facts} onboarding fact(s) seeded from intelligence report ${reportId}; ER cascade queued ${er.queued} candidate(s), auto-merged 0 (human gate)`,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function extractList(audits: Record<string, unknown>, keys: string[]): Array<Record<string, unknown>> {
  for (const k of keys) {
    const v = audits[k];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).items ?? (v as Record<string, unknown>).results;
      if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
    }
  }
  return [];
}
