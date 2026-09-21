// Marketr — alert delivery (milestone 13).
//
// deliverEvent(): fan one AlertEvent out to its rule's enabled channels and
// record per-channel results. flushQueued(): the digest/quiet-hours sweeper
// run by POST /api/cron/alerts. Nothing here throws — every failure is
// captured on the event row and audit-logged.

import { prisma } from "@/lib/prisma";
import type { AlertChannel, AlertEvent } from "@prisma/client";
import { dispatchToChannel, type AlertPayload } from "./adapters";

/** Digest batch: sent at most once every DIGEST_INTERVAL_MS per rule. */
export const DIGEST_INTERVAL_MS = 20 * 60 * 60 * 1000;

export interface ChannelResult {
  channelId: string;
  name: string;
  type: string;
  ok: boolean;
  error?: string;
  providerResponse?: string;
}

/** Write an alert-hub audit event (milestone 11 pattern on file_change_log). */
export async function auditAlert(
  workspaceId: string,
  action: "alert_sent" | "alert_failed",
  summary: string,
  ref: string,
  actor: "user" | "system" = "system",
  approvedBy: string | null = null,
) {
  await prisma.fileChangeLog.create({
    data: {
      workspaceId,
      projectId: null,
      connectionId: null,
      filePath: ref,
      actor,
      action,
      summary: summary.slice(0, 280),
      approvedBy,
    },
  });
}

/**
 * Deliver an existing event to its rule's enabled channels.
 * Updates results/status/sentAt and the rule's lastFiredAt; audit-logs.
 */
export async function deliverEvent(eventId: string): Promise<AlertEvent> {
  const event = await prisma.alertEvent.findUnique({
    where: { id: eventId },
    include: { rule: { include: { channels: true } } },
  });
  if (!event) throw new Error(`AlertEvent not found: ${eventId}`);

  const payload: AlertPayload = {
    title: event.title,
    body: event.body,
    links: event.link ? [{ label: "Open in Marketr", url: event.link }] : [],
  };

  const channels = event.rule.channels.filter((c: AlertChannel) => c.enabled);
  const results: ChannelResult[] = [];
  for (const channel of channels) {
    try {
      results.push(await dispatchToChannel(channel, payload));
    } catch (err) {
      results.push({
        channelId: channel.id,
        name: channel.name,
        type: channel.type,
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : "dispatch failed",
      });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const status =
    channels.length === 0 ? "failed" : okCount === channels.length ? "sent" : okCount > 0 ? "sent" : "failed";
  const retryCount = event.retryCount + 1;

  const updated = await prisma.$transaction(async (tx) => {
    const e = await tx.alertEvent.update({
      where: { id: event.id },
      data: {
        results: results as unknown as object,
        status,
        sentAt: new Date(),
        retryCount,
        queueReason: null,
      },
    });
    await tx.alertRule.update({
      where: { id: event.ruleId },
      data: { lastFiredAt: new Date() },
    });
    return e;
  });

  await auditAlert(
    event.workspaceId,
    status === "sent" ? "alert_sent" : "alert_failed",
    `${okCount}/${channels.length} channels delivered "${event.title}"`,
    `alert-event:${event.id}`,
  ).catch(() => {});

  return updated;
}

/**
 * Flush queued events: quiet-hours holds whose window has ended are sent;
 * digest-mode rules batch their queued events into one daily message.
 * Returns counts for the cron response.
 */
export async function flushQueued(
  now = new Date(),
  workspaceId?: string,
): Promise<{ sent: number; failed: number; digests: number }> {
  let sent = 0;
  let failed = 0;
  let digests = 0;

  const queued = await prisma.alertEvent.findMany({
    where: { status: "queued", ...(workspaceId ? { workspaceId } : {}) },
    include: { rule: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  const digestGroups = new Map<string, typeof queued>();

  for (const event of queued) {
    if (event.queueReason === "digest") {
      const arr = digestGroups.get(event.ruleId) ?? [];
      arr.push(event);
      digestGroups.set(event.ruleId, arr);
      continue;
    }
    // Quiet-hours hold: only deliver when the window has ended.
    const qh = (event.rule.quietHours as { start?: string; end?: string } | null) ?? null;
    if (qh?.start && qh?.end && inQuietHours(qh, now)) continue;
    const delivered = await deliverEvent(event.id);
    if (delivered.status === "sent") sent += 1;
    else failed += 1;
  }

  for (const [ruleId, events] of digestGroups) {
    const rule = events[0].rule;
    const lastDigest = rule.lastDigestAt?.getTime() ?? 0;
    if (now.getTime() - lastDigest < DIGEST_INTERVAL_MS) continue;

    const lines = events.map((e) => `• ${e.title}`).join("\n");
    const digestEvent = await prisma.alertEvent.create({
      data: {
        ruleId,
        workspaceId: rule.workspaceId,
        trigger: rule.trigger,
        title: `${events.length} alerts: ${rule.name}`,
        body: `Daily digest for rule "${rule.name}":\n\n${lines}`,
        queueReason: null,
      },
    });
    await prisma.alertRule.update({ where: { id: ruleId }, data: { lastDigestAt: now } });
    // Mark the batched originals as folded into the digest.
    await prisma.alertEvent.updateMany({
      where: { id: { in: events.map((e) => e.id) } },
      data: {
        status: "suppressed",
        queueReason: null,
        results: [{ digest: digestEvent.id }] as unknown as object,
      },
    });
    const delivered = await deliverEvent(digestEvent.id);
    if (delivered.status === "sent") sent += 1;
    else failed += 1;
    digests += 1;
  }

  return { sent, failed, digests };
}

/** True when `now` (UTC) falls inside the quiet window {start,end} "HH:MM". */
export function inQuietHours(qh: { start?: string | null; end?: string | null }, now = new Date()): boolean {
  if (!qh.start || !qh.end) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = toMin(qh.start);
  const end = toMin(qh.end);
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
