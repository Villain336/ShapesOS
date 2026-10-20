// ShapesOS — push delivery for notifications (Phase 4b).
//
// The Phase 3 notification producers (lib/notifications/producers.ts) call
// queuePushForNotifications() right after they write notification rows. For
// the push kinds (approval needed / decided, run failed) it looks up each
// recipient's enabled, un-muted devices in that workspace and sends one Expo
// push per device. Best-effort like every producer: never throws, never
// blocks the action (fire-and-forget), and is a no-op unless PUSH_PROVIDER=expo.
//
// Token hygiene: a ticket with DeviceNotRegistered deletes the device at
// once (Expo: "stop sending to this token"); any other per-message error
// bumps failureCount, and a device that fails MAX_CONSECUTIVE_FAILURES times
// in a row is deleted too. A successful ticket resets the count. A
// request-level failure (Expo down, bad access token) touches no device.

import type { Prisma, PrismaClient } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { log } from "@/lib/observability/log";
import type { NotificationInput } from "@/lib/notifications/store";
import { isPushKind } from "./devices";
import { pushProvider, sendExpoPush, type ExpoPushMessage, type FetchLike } from "./expo";

type Db = Prisma.TransactionClient | PrismaClient;
type Scope = <T>(workspaceId: string, fn: (db: Db) => Promise<T>) => Promise<T>;

export const MAX_CONSECUTIVE_FAILURES = 5;

export interface PushDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Runs fn with the workspace GUC set (default withWorkspaceScope). */
  scope?: Scope;
}

export interface PushResult {
  sent: number;
  failed: number;
  pruned: number;
  skipped: "disabled" | "no_kinds" | null;
}

function clip(s: string | null | undefined, n: number): string | undefined {
  const t = (s ?? "").trim();
  return t ? t.slice(0, n) : undefined;
}

/** The push message for one notification on one device (exported for tests). */
export function pushMessageFor(n: NotificationInput, token: string): ExpoPushMessage {
  return {
    to: token,
    title: clip(n.title, 120) ?? "ShapesOS",
    body: clip(n.body, 180),
    sound: "default",
    priority: n.kind === "approval_needed" || n.kind === "run_failed" || n.kind === "meeting_starting" || n.kind === "direct_message" ? "high" : "default",
    channelId: "default",
    data: {
      kind: n.kind,
      workspaceId: n.workspaceId,
      href: n.href ?? null,
      sourceType: n.sourceType ?? null,
      sourceId: n.sourceId ?? null,
    },
  };
}

/** Send push for these notification rows. Awaitable; never throws. */
export async function pushNotifications(inputs: NotificationInput[], deps: PushDeps = {}): Promise<PushResult> {
  const env = deps.env ?? process.env;
  const result: PushResult = { sent: 0, failed: 0, pruned: 0, skipped: null };
  if (pushProvider(env) !== "expo") return { ...result, skipped: "disabled" };
  const pushable = inputs.filter((n) => isPushKind(n.kind) && n.workspaceId && n.userId);
  if (pushable.length === 0) return { ...result, skipped: "no_kinds" };
  const scope: Scope = deps.scope ?? ((ws, fn) => withWorkspaceScope(ws, fn));

  const byWorkspace = new Map<string, NotificationInput[]>();
  for (const n of pushable) byWorkspace.set(n.workspaceId, [...(byWorkspace.get(n.workspaceId) ?? []), n]);

  for (const [workspaceId, list] of byWorkspace) {
    try {
      const userIds = [...new Set(list.map((n) => n.userId))];
      const devices = await scope(workspaceId, (db) =>
        db.pushDevice.findMany({
          where: { workspaceId, userId: { in: userIds }, enabled: true },
          select: { id: true, userId: true, expoToken: true, mutedKinds: true },
        }),
      );
      const targets: Array<{ deviceId: string; message: ExpoPushMessage }> = [];
      for (const n of list) {
        for (const d of devices) {
          if (d.userId !== n.userId || d.mutedKinds.includes(n.kind)) continue;
          targets.push({ deviceId: d.id, message: pushMessageFor(n, d.expoToken) });
        }
      }
      if (targets.length === 0) continue;

      const tickets = await sendExpoPush(
        targets.map((t) => t.message),
        { fetchImpl: deps.fetchImpl, accessToken: env.EXPO_ACCESS_TOKEN ?? null },
      );

      const ok = new Set<string>();
      const dead = new Set<string>();
      const errors = new Map<string, string>();
      tickets.forEach((t, i) => {
        const id = targets[i]!.deviceId;
        if (t.status === "ok") ok.add(id);
        else if (t.details?.error === "DeviceNotRegistered") dead.add(id);
        else errors.set(id, t.details?.error ?? t.message);
      });
      for (const id of dead) {
        ok.delete(id);
        errors.delete(id);
      }
      for (const id of errors.keys()) ok.delete(id);
      result.sent += tickets.filter((t) => t.status === "ok").length;
      result.failed += tickets.filter((t) => t.status !== "ok").length;

      await scope(workspaceId, async (db) => {
        const now = new Date();
        if (dead.size) {
          const del = await db.pushDevice.deleteMany({ where: { workspaceId, id: { in: [...dead] } } });
          result.pruned += del.count;
        }
        if (ok.size) {
          await db.pushDevice.updateMany({
            where: { workspaceId, id: { in: [...ok] } },
            data: { lastSentAt: now, failureCount: 0, lastError: null },
          });
        }
        for (const [id, error] of errors) {
          const row = await db.pushDevice.update({
            where: { id, workspaceId },
            data: { failureCount: { increment: 1 }, lastError: error.slice(0, 200) },
            select: { failureCount: true },
          });
          if (row.failureCount >= MAX_CONSECUTIVE_FAILURES) {
            await db.pushDevice.deleteMany({ where: { workspaceId, id } });
            result.pruned += 1;
          }
        }
      });
    } catch (e) {
      log.warn("push delivery skipped", {
        workspaceId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

/**
 * Fire-and-forget entry point for the producers: the action that produced
 * the notification never waits on (or fails because of) Expo.
 */
export function queuePushForNotifications(inputs: NotificationInput[], deps: PushDeps = {}): void {
  if (pushProvider(deps.env ?? process.env) !== "expo") return;
  void pushNotifications(inputs, deps).catch((e: unknown) => {
    log.warn("push delivery failed", { error: e instanceof Error ? e.message : String(e) });
  });
}
