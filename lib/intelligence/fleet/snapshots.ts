// Marketr — Phase 10 M4: per-URL content-snapshot store (changedetection.io
// pattern: hash + normalized text snapshot, diff on change).
//
// Storage: GraphNode with a deterministic fleet-namespaced canonicalKey
// (`fleet-snapshot:<watchId>`). This reuses the workspace-RLS-scoped JSON
// store without touching prisma/schema.prisma, and keeps fleet state out of
// the business-graph entity namespace the Chief Strategy Agent reasons over
// (its competitor entities use `competitor:<domain>` — a different key).
// All access goes through withWorkspaceScope (spec: never raw prisma).

import type { TxClient } from "@/lib/substrate/graph/rls";
import type { Prisma } from "@prisma/client";
import type { PageSnapshot } from "./types";

const SNAPSHOT_KEY_PREFIX = "fleet-snapshot:";

/** Cap per-URL normalized text (keeps the JSON column bounded). */
export const SNAPSHOT_TEXT_CAP = 5000;
/** Cap on tracked URLs per watch (politeness + storage bound). */
export const MAX_TRACKED_URLS = 20;

export function snapshotKey(watchId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${watchId}`;
}

type SnapshotMap = Record<string, PageSnapshot>;

export async function loadSnapshots(
  tx: TxClient,
  workspaceId: string,
  watchId: string,
): Promise<SnapshotMap> {
  const node = await tx.graphNode.findUnique({
    // GraphNode's unique is @@unique([workspaceId, canonicalKey]).
    where: {
      workspaceId_canonicalKey: { workspaceId, canonicalKey: snapshotKey(watchId) },
    },
    select: { properties: true },
  });
  const props = (node?.properties ?? {}) as { snapshots?: unknown };
  if (props.snapshots && typeof props.snapshots === "object") {
    return props.snapshots as SnapshotMap;
  }
  return {};
}

export async function saveSnapshots(
  tx: TxClient,
  workspaceId: string,
  watch: { id: string; competitorDomain: string },
  snapshots: SnapshotMap,
): Promise<void> {
  const now = new Date();
  const properties = {
    snapshots,
    kind: "fleet-snapshot",
  } as unknown as Prisma.InputJsonValue;
  await tx.graphNode.upsert({
    where: {
      workspaceId_canonicalKey: { workspaceId, canonicalKey: snapshotKey(watch.id) },
    },
    create: {
      workspaceId,
      entityType: "competitor",
      canonicalKey: snapshotKey(watch.id),
      displayName: `Fleet snapshot — ${watch.competitorDomain}`,
      properties,
      asOf: now,
      asOfSource: "marketr-fleet",
    },
    update: {
      properties,
      asOf: now,
      asOfSource: "marketr-fleet",
    },
  });
}

/** Normalize visible text: strip scripts/styles, tags → spaces, collapse
 *  whitespace, cap length. Hashing runs on this (layout churn ignored). */
export function normalizeText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNAPSHOT_TEXT_CAP);
}

export function extractMeta(html: string): { title?: string; metaDescription?: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const desc =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1]?.trim() ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html)?.[1]?.trim();
  return { title: title || undefined, metaDescription: desc || undefined };
}
