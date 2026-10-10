// ShapesOS — Phase 21A round 2 (WS=agentweb): replay a finished (or live) session from its receipts.
//
// No live re-execution: this only reads what was stored while the session ran: one delegation
// record per step (what, where, tier decision, who delegated) joined to its signed capture
// (page excerpt, hashes, whether a screenshot was kept). Retention applies: when a capture has
// expired the step is still listed, marked "receipt expired".

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { Prisma } from "@prisma/client";
import { receiptSecret, verifyCapture } from "../receipts";

type Tx = Prisma.TransactionClient;

export interface ReplayStep {
  n: number;
  at: string;
  action: string;
  url: string;
  origin: string;
  tier: number;
  decision: string;
  agent: string;
  captureId: string | null;
  /** null = the receipt has expired or was never stored */
  receipt: { excerpt: string; domHash: string; textHash: string; verified: boolean; hasScreenshot: boolean } | null;
}

export async function loadReplay(workspaceId: string, runId: string, limit = 500): Promise<ReplayStep[]> {
  const secret = receiptSecret();
  const rows = await withWorkspaceScope(workspaceId, async (tx) => {
    const delegations = await (tx as Tx).agentwebDelegation.findMany({ where: { workspaceId, runId }, orderBy: { createdAt: "asc" }, take: Math.min(limit, 1000) });
    const ids = delegations.map((d) => d.captureId).filter((x): x is string => !!x);
    const captures = ids.length ? await (tx as Tx).webCapture.findMany({ where: { workspaceId, id: { in: ids }, retentionUntil: { gt: new Date() } } }) : [];
    return { delegations, captures: new Map(captures.map((c) => [c.id, c])) };
  });
  return rows.delegations.map((d, i) => {
    const c = d.captureId ? rows.captures.get(d.captureId) : undefined;
    return {
      n: i + 1,
      at: d.createdAt.toISOString(),
      action: d.action,
      url: d.url,
      origin: d.origin,
      tier: d.tier,
      decision: d.decision,
      agent: d.agent,
      captureId: d.captureId,
      receipt: c
        ? {
            excerpt: c.excerpt,
            domHash: c.domHash,
            textHash: c.textHash,
            verified: !!secret && c.alg === "hmac-sha256" && !!c.signature && verifyCapture({ id: c.id, url: c.url, fetchedAt: c.fetchedAt.toISOString(), domHash: c.domHash, textHash: c.textHash, excerpt: c.excerpt, screenshotRef: c.screenshotRef ?? undefined, alg: "hmac-sha256", signature: c.signature }, secret),
            hasScreenshot: !!c.screenshotRef,
          }
        : null,
    };
  });
}
