// Marketr — Phase 10 M5: authority-signal adapters.
//
// Three sources, all obtainable without scraping (§2 boundary map):
//   1. Open PageRank — 30,000 free domain lookups/mo, no card.
//      GET https://openpagerank.com/api/v1.0/getPageRank?domains[]=… with
//      header `API-OPR: <key>`. Key: OPENPAGERANK_API_KEY (env or data_source).
//   2. Moz Links API — free tier 2,500 rows/mo.
//      POST https://lsapi.seomoz.com/v2/url_metrics, HTTP Basic
//      (MOZ_ACCESS_ID / MOZ_SECRET_KEY).
//   3. Common Crawl hyperlink graph — domain-level ranks (PageRank +
//      harmonic centrality), quarterly. $0/query after a one-time download.
//      Loader reads a LOCAL slice: see ccGraphPaths() and
//      scripts/cc-graph-download.sh. Nothing here ever hits the network for
//      CC data — the graph is too big; it must be downloaded once.
//
// Every adapter is graceful-without-credentials: it returns
// { available: false, reason } and the model proceeds with the sources it
// has (uncertainty widens — see model.ts). No adapter ever throws for a
// missing key.
// (node:sqlite types: types/node-sqlite.d.ts — @types/node is pinned to v20.)

import { createGunzip } from "node:zlib";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditEvent } from "@/lib/auditlog";
import type { FileChangeAction } from "@prisma/client";
import {
  blendAuthority,
  normalizeDomain,
  type AuthorityBlend,
  type AuthoritySourceId,
  type RawAuthoritySignals,
} from "./model";

export interface AdapterResult {
  available: boolean;
  reason: string;
  /** Per-domain raw signals, keyed by normalized domain. Empty when unavailable. */
  signals: Map<string, Partial<RawAuthoritySignals>>;
}

const noKey = (name: string, hint: string): AdapterResult => ({
  available: false,
  reason: `${name} not configured — ${hint}`,
  signals: new Map(),
});

function auditAuthority(workspaceId: string, summary: string): Promise<void> {
  // Same cast pattern as lib/intelligence/providers/audit.ts: the intent
  // name is written before the schema enum knows it; auditEvent no-ops
  // on the invalid enum value until the coordinator adds it.
  return auditEvent({
    projectId: null,
    workspaceId,
    action: "authority_lookup" as FileChangeAction,
    summary: summary.slice(0, 500),
    actor: "ai",
  });
}

// ── 1. Open PageRank ─────────────────────────────────────────────────────────

interface OprResponse {
  status_code?: number;
  response?: Array<{
    domain?: string;
    page_rank_integer?: number;
    page_rank_decimal?: number;
    rank?: number;
  }>;
}

/** Real HTTP adapter. 100 domains max per call (OPR bulk limit). */
export async function fetchOpenPageRank(
  workspaceId: string,
  domains: string[],
  apiKey?: string,
): Promise<AdapterResult> {
  const key = apiKey ?? process.env.OPENPAGERANK_API_KEY;
  if (!key) {
    return noKey(
      "Open PageRank",
      "set OPENPAGERANK_API_KEY (free: 30,000 lookups/mo, no card) or connect it in Intelligence → Data sources.",
    );
  }
  const unique = [...new Set(domains.map(normalizeDomain))].slice(0, 100);
  const signals = new Map<string, Partial<RawAuthoritySignals>>();
  try {
    const qs = unique.map((d) => `domains[]=${encodeURIComponent(d)}`).join("&");
    const res = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?${qs}`, {
      headers: { "API-OPR": key },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        available: false,
        reason: `Open PageRank HTTP ${res.status}`,
        signals,
      };
    }
    const body = (await res.json()) as OprResponse;
    for (const row of body.response ?? []) {
      if (!row.domain) continue;
      const d = normalizeDomain(row.domain);
      signals.set(d, {
        domain: d,
        oprInteger:
          typeof row.page_rank_integer === "number" ? row.page_rank_integer : null,
      });
    }
    await auditAuthority(
      workspaceId,
      `Open PageRank: ${signals.size}/${unique.length} domains resolved.`,
    );
    return { available: true, reason: "ok", signals };
  } catch (e) {
    return {
      available: false,
      reason: `Open PageRank request failed: ${(e as Error).message}`,
      signals,
    };
  }
}

// ── 2. Moz Links API ─────────────────────────────────────────────────────────

interface MozMetricsResponse {
  results_by_target?: Record<string, { domain_authority?: number }>;
}

/** Real HTTP adapter. Free tier: 2,500 rows/mo. */
export async function fetchMoz(
  workspaceId: string,
  domains: string[],
  accessId?: string,
  secretKey?: string,
): Promise<AdapterResult> {
  const id = accessId ?? process.env.MOZ_ACCESS_ID;
  const secret = secretKey ?? process.env.MOZ_SECRET_KEY;
  if (!id || !secret) {
    return noKey(
      "Moz Links API",
      "set MOZ_ACCESS_ID + MOZ_SECRET_KEY (free tier: 2,500 rows/mo).",
    );
  }
  const unique = [...new Set(domains.map(normalizeDomain))].slice(0, 50);
  const signals = new Map<string, Partial<RawAuthoritySignals>>();
  try {
    const auth = Buffer.from(`${id}:${secret}`).toString("base64");
    const res = await fetch("https://lsapi.seomoz.com/v2/url_metrics", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ targets: unique }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return {
        available: false,
        reason: `Moz Links API HTTP ${res.status}`,
        signals,
      };
    }
    const body = (await res.json()) as MozMetricsResponse;
    for (const [target, metrics] of Object.entries(body.results_by_target ?? {})) {
      const d = normalizeDomain(target);
      signals.set(d, {
        domain: d,
        mozDA: typeof metrics.domain_authority === "number" ? metrics.domain_authority : null,
      });
    }
    await auditAuthority(
      workspaceId,
      `Moz Links API: ${signals.size}/${unique.length} domains resolved.`,
    );
    return { available: true, reason: "ok", signals };
  } catch (e) {
    return {
      available: false,
      reason: `Moz Links API request failed: ${(e as Error).message}`,
      signals,
    };
  }
}

// ── 3. Common Crawl hyperlink-graph domain ranks ─────────────────────────────

/**
 * Local CC graph layout (see scripts/cc-graph-download.sh):
 *
 *   <CC_GRAPH_DIR>/
 *     <crawl>/                     e.g. cc-main-2026-26
 *       <crawl>-domain-ranks.txt.gz   (the ~1.9GB domain ranks file)
 *     cc-domain-ranks.sqlite       (built index: domain → pr_pos, harmonicc_pos)
 *
 * One-time download ≈ 16GB total for the full domain graph release
 * (vertices + edges + ranks); the ranks file alone is what the index needs
 * for the difficulty model (~1.9GB compressed).
 */
export function ccGraphPaths() {
  const dir = process.env.CC_GRAPH_DIR ?? join(homedir(), "workspace", "marketr", ".cc-graph");
  const crawl = process.env.CC_GRAPH_CRAWL ?? "cc-main-2026-26";
  return {
    dir,
    crawl,
    ranksFile: join(dir, crawl, `${crawl}-domain-ranks.txt.gz`),
    indexFile: join(dir, "cc-domain-ranks.sqlite"),
  };
}

export interface CcRankRow {
  domain: string;
  prPos: number | null;
  harmoniccPos: number | null;
}

/**
 * Parse one domain-ranks line. Format (tab-separated, header starts with #):
 *   #harmonicc_pos  #harmonicc_val  #pr_pos  #pr_val  <domain>
 * Domains may be reversed (com.example) or plain — the index stores both
 * orientations so lookups work either way.
 */
export function parseCcRankLine(line: string): CcRankRow | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const parts = trimmed.split("\t");
  if (parts.length < 5) return null;
  const harmoniccPos = Number(parts[0]);
  const prPos = Number(parts[2]);
  const domain = normalizeDomain(parts[4]);
  if (!domain) return null;
  return {
    domain,
    prPos: Number.isFinite(prPos) && prPos > 0 ? prPos : null,
    harmoniccPos: Number.isFinite(harmoniccPos) && harmoniccPos > 0 ? harmoniccPos : null,
  };
}

function reversedDomain(d: string): string {
  return d.split(".").reverse().join(".");
}

/**
 * Build (or rebuild) the SQLite index from a downloaded domain-ranks file.
 * Streams the gzip — never loads the ~2GB file into memory.
 */
export async function buildCcIndex(
  ranksFile?: string,
  indexFile?: string,
): Promise<{ rows: number; indexFile: string }> {
  const paths = ccGraphPaths();
  const src = ranksFile ?? paths.ranksFile;
  const dest = indexFile ?? paths.indexFile;
  if (!existsSync(src)) {
    throw new Error(
      `CC domain-ranks file not found at ${src}. ` +
        `Run scripts/cc-graph-download.sh first (one-time ~16GB download).`,
    );
  }
  const db = new DatabaseSync(dest);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cc_domain_rank (
        domain TEXT PRIMARY KEY,
        pr_pos REAL,
        harmonicc_pos REAL,
        crawl TEXT
      );
    `);
    db.exec("DELETE FROM cc_domain_rank;");
    const insert = db.prepare(
      "INSERT INTO cc_domain_rank (domain, pr_pos, harmonicc_pos, crawl) VALUES (?, ?, ?, ?)",
    );
    db.prepare("BEGIN").run();
    let rows = 0;
    let batch = 0;
    const rl = createInterface({
      input: createReadStream(src).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const row = parseCcRankLine(line);
      if (!row) continue;
      insert.run(row.domain, row.prPos, row.harmoniccPos, paths.crawl);
      // Also index the reversed orientation — ranks files differ by release.
      insert.run(reversedDomain(row.domain), row.prPos, row.harmoniccPos, paths.crawl);
      rows += 2;
      if (++batch >= 50_000) {
        db.prepare("COMMIT").run();
        db.prepare("BEGIN").run();
        batch = 0;
      }
    }
    try {
      db.prepare("COMMIT").run();
    } catch {
      /* already committed */
    }
    db.close();
    return { rows, indexFile: dest };
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Look up domains in the local CC index. Graceful when the slice isn't downloaded. */
export function lookupCcDomains(domains: string[]): AdapterResult {
  const { indexFile, crawl } = ccGraphPaths();
  if (!existsSync(indexFile)) {
    return noKey(
      "CC hyperlink graph",
      `no local index at ${indexFile} — run scripts/cc-graph-download.sh (one-time ~16GB) then build the index.`,
    );
  }
  const signals = new Map<string, Partial<RawAuthoritySignals>>();
  const unique = [...new Set(domains.map(normalizeDomain))];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(indexFile, { readOnly: true });
  } catch (e) {
    return {
      available: false,
      reason: `CC index unreadable: ${(e as Error).message}`,
      signals,
    };
  }
  try {
    const stmt = db.prepare(
      "SELECT domain, pr_pos, harmonicc_pos FROM cc_domain_rank WHERE domain = ?",
    );
    for (const d of unique) {
      const row = stmt.get(d) as
        | { domain: string; pr_pos: number | null; harmonicc_pos: number | null }
        | undefined;
      if (row) {
        signals.set(d, {
          domain: d,
          ccPrPos: row.pr_pos,
          ccHarmoniccPos: row.harmonicc_pos,
        });
      }
    }
    return {
      available: true,
      reason: `ok (crawl ${crawl}; ${signals.size}/${unique.length} domains in index)`,
      signals,
    };
  } finally {
    db.close();
  }
}

// ── Blending across adapters ─────────────────────────────────────────────────

export interface AuthorityResolution {
  blends: Map<string, AuthorityBlend>;
  sources: Record<
    AuthoritySourceId,
    { available: boolean; reason: string; domainsCovered: number }
  >;
}

export interface ResolveAuthorityOpts {
  openPageRankKey?: string;
  mozAccessId?: string;
  mozSecretKey?: string;
  skipCc?: boolean;
}

/**
 * Run every available authority adapter and blend per domain.
 * Adapters run in parallel; a missing/failed adapter only reduces
 * confidence (recorded in provenance), never throws.
 */
export async function resolveAuthority(
  workspaceId: string,
  domains: string[],
  opts: ResolveAuthorityOpts = {},
): Promise<AuthorityResolution> {
  const unique = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  const [opr, moz] = await Promise.all([
    fetchOpenPageRank(workspaceId, unique, opts.openPageRankKey),
    fetchMoz(workspaceId, unique, opts.mozAccessId, opts.mozSecretKey),
  ]);
  const cc = opts.skipCc ? noKey("CC hyperlink graph", "skipped by caller") : lookupCcDomains(unique);

  const raws = new Map<string, RawAuthoritySignals>();
  const merge = (result: AdapterResult) => {
    for (const [d, sig] of result.signals) {
      const cur = raws.get(d) ?? { domain: d };
      raws.set(d, { ...cur, ...sig });
    }
  };
  merge(opr);
  merge(moz);
  merge(cc);

  const blends = new Map<string, AuthorityBlend>();
  for (const d of unique) {
    const raw = raws.get(d);
    if (!raw) continue;
    blends.set(d, blendAuthority(raw));
  }

  const source = (r: AdapterResult): AuthorityResolution["sources"][AuthoritySourceId] => ({
    available: r.available,
    reason: r.reason,
    domainsCovered: r.signals.size,
  });
  return {
    blends,
    sources: {
      moz: source(moz),
      openpagerank: source(opr),
      cc_graph: source(cc),
    },
  };
}
