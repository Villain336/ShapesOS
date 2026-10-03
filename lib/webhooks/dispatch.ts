// ShapesOS — outbound webhook delivery (Phase 4a).
//
// Drains webhook_deliveries: claim due rows (FOR UPDATE SKIP LOCKED, so two
// cron ticks never send the same row twice), POST the signed envelope via
// safeFetch (SSRF-safe, no redirects followed), record the outcome.
//
//   2xx                       → succeeded
//   anything else / network   → pending again after exponential backoff
//                               (1m, 4m, 16m, ~1h, ~4h, ~17h, 24h …)
//   MAX_ATTEMPTS exhausted    → dead (the dead letter; redeliver from the UI)
//   endpoint disabled/deleted,
//   plan without webhooks,
//   unreadable secret         → dead immediately (no retry would help)
//
// A row stuck in `delivering` (process died mid-request) is reclaimed after
// STUCK_MS. Every table access is inside withWorkspaceScope (FORCE RLS); the
// HTTP request itself runs outside any transaction.

import { Prisma, type WebhookDeliveryStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { safeFetch } from "@/lib/connectors/safe-fetch";
import type { ResolveFn } from "@/lib/safe-url";
import { secrets } from "@/lib/secrets";
import { planHasFeature } from "@/lib/billing/entitlements";
import {
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  WEBHOOK_USER_AGENT,
  signatureHeader,
} from "./signing";

export const MAX_ATTEMPTS = 8;
export const BASE_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 24 * 60 * 60_000;
export const STUCK_MS = 10 * 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RESPONSE_EXCERPT_BYTES = 1024;
/** Delivered/dead rows older than this are pruned by the cron. */
export const RETENTION_DAYS = 30;

/**
 * Delay before the next attempt, after `attempts` attempts have failed
 * (attempts ≥ 1): 1m × 4^(attempts−1), capped at 24h, ±10% jitter.
 */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempts));
  const base = Math.min(BASE_BACKOFF_MS * 4 ** (n - 1), MAX_BACKOFF_MS);
  const jitter = 1 + (rand() * 0.2 - 0.1);
  return Math.round(base * jitter);
}

/** Status + next attempt time after a failed attempt number `attempts`. */
export function afterFailure(
  attempts: number,
  now: Date,
  rand?: () => number,
): { status: WebhookDeliveryStatus; nextAttemptAt: Date } {
  if (attempts >= MAX_ATTEMPTS) return { status: "dead", nextAttemptAt: now };
  return { status: "pending", nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, rand)) };
}

export interface DispatchDeps {
  fetchFn?: typeof fetch;
  resolve?: ResolveFn;
  now?: () => Date;
  timeoutMs?: number;
  rand?: () => number;
}

export interface AttemptOutcome {
  deliveryId: string;
  status: WebhookDeliveryStatus;
  responseStatus: number | null;
  error: string | null;
}

async function readExcerpt(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < RESPONSE_EXCERPT_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    /* body errors only shorten the excerpt */
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, RESPONSE_EXCERPT_BYTES).toString("utf8");
}

function clip(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}

/** A UTC timestamp literal for the timestamp(3) (no time zone) columns,
 * independent of the database session's TimeZone setting. */
function utc(d: Date): Prisma.Sql {
  return Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Claim up to `limit` due rows in one workspace; returns their ids. */
async function claimDue(workspaceId: string, now: Date, limit: number, onlyId?: string): Promise<string[]> {
  const stuckBefore = new Date(now.getTime() - STUCK_MS);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE webhook_deliveries
         SET status = 'delivering', last_attempt_at = ${utc(now)}, updated_at = ${utc(now)}
       WHERE id IN (
         SELECT id FROM webhook_deliveries
          WHERE workspace_id = ${workspaceId}
            ${onlyId ? Prisma.sql`AND id = ${onlyId}` : Prisma.empty}
            AND ((status = 'pending' AND next_attempt_at <= ${utc(now)})
              OR (status = 'delivering' AND last_attempt_at < ${utc(stuckBefore)}))
          ORDER BY next_attempt_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    return rows.map((r) => r.id);
  });
}

/** Attempt one claimed delivery and record the outcome. */
async function attempt(workspaceId: string, deliveryId: string, deps: DispatchDeps): Promise<AttemptOutcome> {
  const now = deps.now?.() ?? new Date();
  const loaded = await withWorkspaceScope(workspaceId, async (tx) => {
    const delivery = await tx.webhookDelivery.findFirst({
      where: { id: deliveryId, workspaceId },
      include: { endpoint: true },
    });
    const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
    return { delivery, plan: ws?.plan ?? null };
  });
  const delivery = loaded.delivery;
  if (!delivery) return { deliveryId, status: "dead", responseStatus: null, error: "Delivery not found" };
  const attempts = delivery.attempts + 1;

  const finish = async (o: {
    ok: boolean;
    permanent?: boolean;
    responseStatus?: number | null;
    responseBody?: string | null;
    error?: string | null;
    durationMs?: number | null;
  }): Promise<AttemptOutcome> => {
    const next = o.ok
      ? { status: "succeeded" as const, nextAttemptAt: now }
      : o.permanent
        ? { status: "dead" as const, nextAttemptAt: now }
        : afterFailure(attempts, now, deps.rand);
    await withWorkspaceScope(workspaceId, async (tx) => {
      await tx.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: next.status,
          attempts,
          nextAttemptAt: next.nextAttemptAt,
          lastAttemptAt: now,
          deliveredAt: o.ok ? now : null,
          responseStatus: o.responseStatus ?? null,
          responseBody: clip(o.responseBody, RESPONSE_EXCERPT_BYTES),
          lastError: clip(o.error, 500),
          durationMs: o.durationMs ?? null,
        },
      });
      if (delivery.endpoint) {
        await tx.webhookEndpoint.updateMany({
          where: { id: delivery.endpoint.id, workspaceId },
          data: o.ok
            ? { consecutiveFailures: 0, lastSuccessAt: now }
            : { consecutiveFailures: { increment: 1 }, lastFailureAt: now },
        });
      }
    });
    return { deliveryId: delivery.id, status: next.status, responseStatus: o.responseStatus ?? null, error: o.error ?? null };
  };

  const endpoint = delivery.endpoint;
  if (!endpoint || !endpoint.enabled) {
    return finish({ ok: false, permanent: true, error: "Endpoint is disabled or was deleted." });
  }
  if (!planHasFeature(loaded.plan, "webhooks")) {
    return finish({ ok: false, permanent: true, error: "The workspace plan doesn't include webhooks." });
  }
  let secret: string;
  try {
    secret = secrets().decrypt(endpoint.secretEnc);
  } catch {
    return finish({ ok: false, permanent: true, error: "The signing secret could not be read. Rotate the secret." });
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(now.getTime() / 1000);
  const started = Date.now();
  try {
    const res = await safeFetch(
      endpoint.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": WEBHOOK_USER_AGENT,
          [SIGNATURE_HEADER]: signatureHeader(secret, body, timestamp),
          [EVENT_ID_HEADER]: delivery.eventId,
          [EVENT_TYPE_HEADER]: delivery.eventType,
          [DELIVERY_ID_HEADER]: delivery.id,
        },
        body,
        signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      },
      // Redirects are not followed: a 3xx is a failed delivery.
      { fetchFn: deps.fetchFn, resolve: deps.resolve, maxRedirects: 0 },
    );
    const excerpt = await readExcerpt(res);
    const ok = res.status >= 200 && res.status < 300;
    return finish({
      ok,
      responseStatus: res.status,
      responseBody: excerpt,
      error: ok ? null : `Endpoint answered HTTP ${res.status}.`,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || /timeout|aborted/i.test(msg));
    return finish({
      ok: false,
      error: timedOut ? "Timed out waiting for the endpoint." : msg,
      durationMs: Date.now() - started,
    });
  }
}

/** Claim and attempt a single delivery now (test send, redeliver). */
export async function deliverNow(
  workspaceId: string,
  deliveryId: string,
  deps: DispatchDeps = {},
): Promise<AttemptOutcome | null> {
  const now = deps.now?.() ?? new Date();
  const claimed = await claimDue(workspaceId, now, 1, deliveryId);
  if (claimed.length === 0) return null;
  return attempt(workspaceId, claimed[0]!, deps);
}

export interface DispatchSummary {
  workspaces: number;
  attempted: number;
  succeeded: number;
  retrying: number;
  dead: number;
  pruned: number;
}

/**
 * Drain due deliveries. `workspaceId` limits the run to one workspace
 * (session-triggered); otherwise every workspace whose plan includes
 * webhooks (CRON_SECRET). Bounded per tick so a cron call stays short.
 */
export async function deliverDue(
  opts: { workspaceId?: string | null; limit?: number; perWorkspace?: number; concurrency?: number; deps?: DispatchDeps } = {},
): Promise<DispatchSummary> {
  const deps = opts.deps ?? {};
  const limit = opts.limit ?? 200;
  const perWorkspace = opts.perWorkspace ?? 50;
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const summary: DispatchSummary = { workspaces: 0, attempted: 0, succeeded: 0, retrying: 0, dead: 0, pruned: 0 };

  const workspaces = opts.workspaceId
    ? [{ id: opts.workspaceId }]
    : (await prisma.workspace.findMany({ select: { id: true, plan: true } })).filter((w) =>
        planHasFeature(w.plan, "webhooks"),
      );

  for (const ws of workspaces) {
    if (summary.attempted >= limit) break;
    summary.workspaces++;
    const now = deps.now?.() ?? new Date();
    let ids: string[];
    try {
      ids = await claimDue(ws.id, now, Math.min(perWorkspace, limit - summary.attempted));
    } catch (e) {
      console.warn("[webhooks] claim failed:", e instanceof Error ? e.message : e);
      continue;
    }
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency);
      const outcomes = await Promise.all(
        batch.map((id) =>
          attempt(ws.id, id, deps).catch((e: unknown) => {
            console.warn("[webhooks] attempt failed:", e instanceof Error ? e.message : e);
            return null;
          }),
        ),
      );
      for (const o of outcomes) {
        if (!o) continue;
        summary.attempted++;
        if (o.status === "succeeded") summary.succeeded++;
        else if (o.status === "dead") summary.dead++;
        else summary.retrying++;
      }
    }
    try {
      summary.pruned += await pruneOld(ws.id, now);
    } catch {
      /* retention is best-effort */
    }
  }
  return summary;
}

/** Drop delivered/dead rows past retention. */
export async function pruneOld(workspaceId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const res = await tx.webhookDelivery.deleteMany({
      where: { workspaceId, status: { in: ["succeeded", "dead"] }, createdAt: { lt: cutoff } },
    });
    return res.count;
  });
}
