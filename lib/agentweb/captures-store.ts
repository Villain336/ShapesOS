// ShapesOS — Phase 21A (WS=agentweb): the capture store (workspace-scoped, FORCE RLS).
//
// A capture is the receipt behind a cited source or a browser step. The row
// holds the hashes and an excerpt; the page text itself, when kept, goes to the
// blob store (namespace "web-captures"). Retention is a workspace setting
// (agentweb_settings.capture_retention_days, default 30): expired rows and their
// blobs are removed lazily, a few at a time, whenever a capture is stored.

import { blobDelete, blobGet, blobPut, parseBlobRef, workspaceBlobPath } from "@/lib/filesystem/storage";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { receiptSecret, verifyCapture, type SignedCapture } from "./receipts";

export type CaptureVia = "search-snippet" | "fetch" | "browser" | "step";

export interface StoreCaptureMeta {
  via: CaptureVia;
  provider?: string;
  answerId?: string;
  runId?: string;
  step?: { action: string; klass: string; tier: number };
  /** Page text to keep in the blob store (clipped). */
  bodyText?: string;
  retentionDays?: number;
}

export interface StoredCapture extends SignedCapture {
  workspaceId: string;
  via: string;
  provider: string | null;
  answerId: string | null;
  runId: string | null;
  bodyRef: string | null;
  retentionUntil: Date;
  /** true = the signature checks out now; false = it does not (or the capture is unsigned); */
  verified: boolean;
  signedWith: "hmac-sha256" | "none";
}

const BODY_CAP = 200_000;
export const DEFAULT_RETENTION_DAYS = 30;

export async function storeCapture(workspaceId: string, c: SignedCapture, meta: StoreCaptureMeta): Promise<void> {
  const days = Math.min(Math.max(Math.floor(meta.retentionDays ?? (await retentionDays(workspaceId))), 1), 3650);
  const bodyRef = meta.bodyText ? await blobPut("web-captures", workspaceBlobPath(workspaceId, `${c.id}.txt`), meta.bodyText.slice(0, BODY_CAP), "text/plain; charset=utf-8") : null;
  await withWorkspaceScope(workspaceId, (tx) =>
    (tx as import("@prisma/client").Prisma.TransactionClient).webCapture.upsert({
      where: { workspaceId_id: { workspaceId, id: c.id } },
      create: {
        id: c.id,
        workspaceId,
        url: c.url,
        fetchedAt: new Date(c.fetchedAt),
        domHash: c.domHash,
        textHash: c.textHash,
        excerpt: c.excerpt,
        screenshotRef: c.screenshotRef ?? null,
        bodyRef,
        alg: c.alg,
        signature: c.signature,
        via: meta.via,
        provider: meta.provider ?? null,
        answerId: meta.answerId ?? null,
        runId: meta.runId ?? null,
        stepAction: meta.step?.action ?? null,
        stepClass: meta.step?.klass ?? null,
        tier: meta.step?.tier ?? null,
        retentionUntil: new Date(Date.now() + days * 86_400_000),
      },
      update: {},
    }),
  );
  // Retention, lazily: never fails the store.
  await purgeExpiredCaptures(workspaceId).catch(() => undefined);
}

async function retentionDays(workspaceId: string): Promise<number> {
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as import("@prisma/client").Prisma.TransactionClient).agentwebSettings.findUnique({ where: { workspaceId }, select: { captureRetentionDays: true } }));
  return row?.captureRetentionDays ?? DEFAULT_RETENTION_DAYS;
}

type Row = import("@prisma/client").WebCapture;
function toStored(r: Row): StoredCapture {
  const signed: SignedCapture = {
    id: r.id,
    url: r.url,
    fetchedAt: r.fetchedAt.toISOString(),
    domHash: r.domHash,
    textHash: r.textHash,
    excerpt: r.excerpt,
    ...(r.screenshotRef ? { screenshotRef: r.screenshotRef } : {}),
    alg: r.alg === "hmac-sha256" ? "hmac-sha256" : "none",
    signature: r.signature,
  };
  const secret = receiptSecret();
  return {
    ...signed,
    workspaceId: r.workspaceId,
    via: r.via,
    provider: r.provider,
    answerId: r.answerId,
    runId: r.runId,
    bodyRef: r.bodyRef,
    retentionUntil: r.retentionUntil,
    signedWith: signed.alg,
    verified: !!secret && verifyCapture(signed, secret),
  };
}

export async function getCapture(workspaceId: string, id: string): Promise<(StoredCapture & { bodyText: string | null }) | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as import("@prisma/client").Prisma.TransactionClient).webCapture.findUnique({ where: { workspaceId_id: { workspaceId, id } } }));
  if (!row || row.retentionUntil < new Date()) return null;
  let bodyText: string | null = null;
  const ref = row.bodyRef ? parseBlobRef(row.bodyRef) : null;
  if (ref && ref.namespace === "web-captures" && ref.path.startsWith(`${workspaceId}/`)) bodyText = (await blobGet(ref.namespace, ref.path))?.toString("utf8") ?? null;
  return { ...toStored(row), bodyText };
}

export async function listCaptures(workspaceId: string, opts: { answerId?: string; ids?: string[]; limit?: number } = {}): Promise<StoredCapture[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as import("@prisma/client").Prisma.TransactionClient).webCapture.findMany({
      where: { workspaceId, retentionUntil: { gt: new Date() }, ...(opts.answerId ? { answerId: opts.answerId } : {}), ...(opts.ids ? { id: { in: opts.ids } } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
    }),
  );
  return rows.map(toStored);
}

/** Remove a workspace's expired captures and their blobs. Returns how many. */
export async function purgeExpiredCaptures(workspaceId: string, now = new Date(), limit = 50): Promise<number> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as import("@prisma/client").Prisma.TransactionClient).webCapture.findMany({ where: { workspaceId, retentionUntil: { lt: now } }, take: limit, select: { id: true, bodyRef: true } }),
  );
  for (const r of rows) {
    const ref = r.bodyRef ? parseBlobRef(r.bodyRef) : null;
    if (ref && ref.namespace === "web-captures" && ref.path.startsWith(`${workspaceId}/`)) await blobDelete(ref.namespace, ref.path).catch(() => undefined);
  }
  if (rows.length) {
    await withWorkspaceScope(workspaceId, (tx) => (tx as import("@prisma/client").Prisma.TransactionClient).webCapture.deleteMany({ where: { workspaceId, id: { in: rows.map((r) => r.id) } } }));
  }
  return rows.length;
}
