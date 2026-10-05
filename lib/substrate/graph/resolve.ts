// Marketr — Phase 8 G1: cascading entity resolution (docs/specs/SPEC-PHASE8.md §2 G1).
//
// Pipeline: deterministic rules (email/phone/domain/sku exact match) →
// pg_trgm blocking for fuzzy candidates → human review queue below the
// auto-merge threshold. v1: NO auto-merge without a human decision
// (safety invariant §9.6) — even deterministic hits land in the queue.
// Every merge writes reversible SAME_AS provenance edges.

import type { GraphNode } from "@prisma/client";
import { withWorkspaceScope, type TxClient } from "./rls";
import type { MatcherSignal } from "./types";

/** Queue anything scoring at/above this; below it the pair is ignored. */
export const REVIEW_THRESHOLD = 0.5;
/** Reserved for a future v2 with human sign-off; unused in v1. */
export const AUTO_MERGE_THRESHOLD = 0.98;

type CoreMap = Record<string, unknown>;

function coreOf(n: GraphNode): CoreMap {
  return { ...((n.core ?? {}) as CoreMap), ...((n.properties ?? {}) as CoreMap) };
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");

/** Deterministic matchers — exact identifier matches. Each returns signals. */
export function deterministicSignals(a: GraphNode, b: GraphNode): MatcherSignal[] {
  if (a.entityType !== b.entityType) return [];
  const ca = coreOf(a);
  const cb = coreOf(b);
  const signals: MatcherSignal[] = [];
  const exact = (field: string, va: string, vb: string, weight: number, label: string) => {
    if (va && vb) {
      if (va === vb) signals.push({ matcher: label, field, valueA: va, valueB: vb, weight });
      else signals.push({ matcher: `${label}_mismatch`, field, valueA: va, valueB: vb, weight: -weight * 0.75 });
    }
  };
  exact("email", norm(ca.email), norm(cb.email), 1.0, "email_exact");
  const pa = digits(ca.phone);
  const pb = digits(cb.phone);
  if (pa.length >= 7 && pb.length >= 7) {
    if (pa === pb || pa.endsWith(pb) || pb.endsWith(pa))
      signals.push({ matcher: "phone_exact", field: "phone", valueA: pa, valueB: pb, weight: 0.95 });
    else signals.push({ matcher: "phone_mismatch", field: "phone", valueA: pa, valueB: pb, weight: -0.7 });
  }
  exact("domain", norm(ca.domain), norm(cb.domain), 0.9, "domain_exact");
  exact("sku", norm(ca.sku), norm(cb.sku), 0.9, "sku_exact");
  exact("externalId", norm(ca.externalId), norm(cb.externalId), 0.85, "external_id_exact");
  exact("url", norm(ca.url), norm(cb.url), 0.8, "url_exact");
  return signals;
}

/** Fuzzy + identifier blocking — candidates only, never decisions.
 *
 * Two recall paths, UNIONed in one query:
 *  1. pg_trgm fuzzy blocking on display_name (similarity > 0.4).
 *  2. Deterministic identifier blocking: exact normalized matches on
 *     email / phone digits / domain / sku / externalId / url read from
 *     core+properties JSON. This is what catches "same phone, spelled
 *     name" duplicates that trgm alone would miss.
 */
export async function blockingCandidates(
  tx: TxClient,
  workspaceId: string,
  node: GraphNode,
  limit = 25,
): Promise<Array<GraphNode & { similarity: number }>> {
  // Raw SQL for the similarity() operator; workspace scoping comes from RLS
  // (the caller runs inside withWorkspaceScope) plus the explicit filter.
  const core = { ...((node.core ?? {}) as CoreMap), ...((node.properties ?? {}) as CoreMap) };
  const email = norm(core.email);
  const phone = digits(core.phone);
  const domain = norm(core.domain);
  const sku = norm(core.sku);
  const externalId = norm(core.externalId);
  const url = norm(core.url);
  const hasPhone = phone.length >= 7;

  // NOTE: $queryRaw returns raw snake_case column names — Prisma's camelCase
  // mapping does not apply. Select explicitly with camelCase aliases so the
  // rows are real GraphNode objects for evaluatePair/queueing below.
  const rows = await tx.$queryRaw<Array<GraphNode & { similarity: number }>>`
    SELECT n.id,
           n.workspace_id AS "workspaceId",
           n.entity_type AS "entityType",
           n.canonical_key AS "canonicalKey",
           n.display_name AS "displayName",
           n.core, n.properties,
           n.first_seen AS "firstSeen",
           n.last_seen AS "lastSeen",
           n.as_of AS "asOf",
           n.as_of_source AS "asOfSource",
           n.merged_into_id AS "mergedIntoId",
           similarity(n.display_name, ${node.displayName}) AS similarity
    FROM graph_nodes n
    WHERE n.workspace_id = ${workspaceId}
      AND n.entity_type = ${node.entityType}::"GraphEntityType"
      AND n.id <> ${node.id}
      AND n.merged_into_id IS NULL
      AND (
        similarity(n.display_name, ${node.displayName}) > 0.4
        OR (${email} <> '' AND (
              lower(n.core->>'email') = ${email}
              OR lower(n.properties->>'email') = ${email}))
        OR (${hasPhone} AND regexp_replace(
              COALESCE(n.core->>'phone', n.properties->>'phone', ''), '\\D', '', 'g') = ${phone})
        OR (${domain} <> '' AND (
              lower(n.core->>'domain') = ${domain}
              OR lower(n.properties->>'domain') = ${domain}))
        OR (${sku} <> '' AND (
              lower(n.core->>'sku') = ${sku}
              OR lower(n.properties->>'sku') = ${sku}))
        OR (${externalId} <> '' AND (
              lower(n.core->>'externalId') = ${externalId}
              OR lower(n.properties->>'externalId') = ${externalId}))
        OR (${url} <> '' AND (
              lower(n.core->>'url') = ${url}
              OR lower(n.properties->>'url') = ${url}))
      )
    ORDER BY similarity DESC
    LIMIT ${limit}`;
  return rows;
}

/** Score a candidate pair: deterministic signals + name similarity. */
export async function evaluatePair(
  tx: TxClient,
  workspaceId: string,
  a: GraphNode,
  b: GraphNode,
): Promise<{ confidence: number; signals: MatcherSignal[] }> {
  const signals = deterministicSignals(a, b);
  const sim = await tx.$queryRaw<Array<{ s: number }>>`
    SELECT similarity(${a.displayName}, ${b.displayName}) AS s`;
  const nameSim = Number(sim[0]?.s ?? 0);
  if (nameSim > 0.6) {
    signals.push({
      matcher: "name_trgm",
      field: "displayName",
      valueA: a.displayName,
      valueB: b.displayName,
      weight: nameSim * 0.5,
      detail: `trigram similarity ${nameSim.toFixed(2)}`,
    });
  } else if (nameSim < 0.3 && signals.length > 0) {
    signals.push({
      matcher: "name_trgm_mismatch",
      field: "displayName",
      valueA: a.displayName,
      valueB: b.displayName,
      weight: -0.3,
      detail: `trigram similarity ${nameSim.toFixed(2)}`,
    });
  }
  // Weighted evidence → [0,1]. Strong positive identifiers dominate; a hard
  // identifier mismatch vetoes (email differs ⇒ not the same person).
  let pos = 0;
  let neg = 0;
  for (const s of signals) {
    if (s.weight > 0) pos += s.weight;
    else neg += -s.weight;
  }
  let confidence = pos / (pos + neg + 1e-9);
  if (neg >= 0.75 && pos < 1.5) confidence = Math.min(confidence, 0.2); // veto
  return { confidence, signals };
}

/** Has this pair already been decided (approved/rejected/pending)? */
async function existingQueueRow(
  tx: TxClient,
  workspaceId: string,
  aId: string,
  bId: string,
) {
  return tx.graphErQueue.findFirst({
    where: {
      workspaceId,
      OR: [
        { nodeAId: aId, nodeBId: bId },
        { nodeAId: bId, nodeBId: aId },
      ],
    },
  });
}

export interface ErScanResult {
  scanned: number;
  queued: number;
  skippedAutoMerge: number; // always >0 by design in v1 — reported, never acted on
}

/**
 * Run the cascade for one node: deterministic signals first, then blocking
 * candidates. Everything at/above REVIEW_THRESHOLD lands in the human queue;
 * NOTHING auto-merges in v1 (spec §9.6).
 */
export async function resolveNode(workspaceId: string, nodeId: string): Promise<ErScanResult> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const node = await tx.graphNode.findFirst({ where: { workspaceId, id: nodeId } });
    if (!node || node.mergedIntoId) return { scanned: 0, queued: 0, skippedAutoMerge: 0 };
    const candidates = await blockingCandidates(tx, workspaceId, node);
    let queued = 0;
    let skippedAutoMerge = 0;
    for (const cand of candidates) {
      if (await existingQueueRow(tx, workspaceId, node.id, cand.id)) continue;
      const { confidence, signals } = await evaluatePair(tx, workspaceId, node, cand);
      if (confidence >= AUTO_MERGE_THRESHOLD) {
        // v1: still human-gated. Counted so the battery can assert the gate.
        skippedAutoMerge++;
      }
      if (confidence >= REVIEW_THRESHOLD) {
        await tx.graphErQueue.create({
          data: {
            workspaceId,
            nodeAId: node.id,
            nodeBId: cand.id,
            matcherSignals: signals as unknown as object,
            confidence,
            status: "pending",
          },
        });
        queued++;
      }
    }
    return { scanned: candidates.length, queued, skippedAutoMerge };
  });
}

/** Scan every unmerged node in the workspace (used after bulk imports). */
export async function resolveWorkspace(workspaceId: string): Promise<ErScanResult> {
  const total = { scanned: 0, queued: 0, skippedAutoMerge: 0 };
  const nodes = await withWorkspaceScope(workspaceId, (tx) =>
    tx.graphNode.findMany({ where: { workspaceId, mergedIntoId: null }, select: { id: true } }),
  );
  for (const n of nodes) {
    const r = await resolveNode(workspaceId, n.id);
    total.scanned += r.scanned;
    total.queued += r.queued;
    total.skippedAutoMerge += r.skippedAutoMerge;
  }
  return total;
}
