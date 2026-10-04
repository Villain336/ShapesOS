// ShapesOS — Phase 10 (finance): recurring invoice schedules.
//
// A schedule (OpsRecurringInvoice) is a template + cadence. The finance cron
// (POST /api/cron/finance) calls draftDueRecurringInvoices() per workspace:
// every active schedule whose nextRunAt has passed gets ONE DRAFT invoice
// per due slot (sending still asks — drafts only), created through the
// generic opsCreate with an idempotency key "recurring:<id>:<slot>", so a
// retried or overlapping sweep can never draft the same period twice. The
// schedule then advances with a guarded write on its old nextRunAt.

import type { Prisma } from "@prisma/client";
import { OPS_ENTITY_MAP } from "../entities";
import { opsCreate, type OpsActor } from "../doctype";

type Tx = Prisma.TransactionClient;

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

const MONTHS: Record<Exclude<Cadence, "weekly">, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * The next run after `from`. Months clamp to the month's last day but keep
 * the schedule's anchor day: a schedule anchored on the 31st runs Jan 31 →
 * Feb 28 → Mar 31 (UTC).
 */
export function advanceCadence(from: Date, cadence: Cadence, intervalCount = 1, anchorDay?: number): Date {
  const n = Math.max(1, Math.floor(intervalCount));
  if (cadence === "weekly") return new Date(from.getTime() + n * 7 * 86_400_000);
  const months = MONTHS[cadence] * n;
  const day = anchorDay ?? from.getUTCDate();
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(day, lastDay), from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()),
  );
}

/** All slots due at `now`, oldest first, capped (a long-paused schedule catches up at most `cap` periods per sweep). */
export function dueSlots(
  s: { nextRunAt: Date; endAt?: Date | null; cadence: Cadence; intervalCount: number; anchorDay?: number },
  now: Date,
  cap = 12,
): { slots: Date[]; next: Date } {
  const slots: Date[] = [];
  let at = s.nextRunAt;
  while (at.getTime() <= now.getTime() && slots.length < cap) {
    if (s.endAt && at.getTime() > s.endAt.getTime()) break;
    slots.push(at);
    at = advanceCadence(at, s.cadence, s.intervalCount, s.anchorDay);
  }
  return { slots, next: at };
}

export interface RecurringRunResult {
  scheduleId: string;
  drafted: string[];
  nextRunAt: Date;
  ended: boolean;
}

export async function draftDueRecurringInvoices(tx: Tx, actor: OpsActor, now = new Date()): Promise<RecurringRunResult[]> {
  const schedules = await tx.opsRecurringInvoice.findMany({
    where: { workspaceId: actor.workspaceId, active: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: 200,
  });
  const out: RecurringRunResult[] = [];
  for (const s of schedules) {
    const { slots, next } = dueSlots(
      { nextRunAt: s.nextRunAt, endAt: s.endAt, cadence: s.cadence as Cadence, intervalCount: s.intervalCount, anchorDay: s.anchorDay ?? undefined },
      now,
    );
    const drafted: string[] = [];
    for (const slot of slots) {
      const r = await opsCreate(tx, OPS_ENTITY_MAP["invoices"]!, actor, {
        ...(s.customerId ? { customerId: s.customerId } : {}),
        lineItems: s.lineItems,
        taxCents: s.taxCents,
        dueAt: new Date(slot.getTime() + s.dueDays * 86_400_000).toISOString(),
        idempotencyKey: `recurring:${s.id}:${slot.toISOString().slice(0, 10)}`,
      });
      if (r.outcome === "done") {
        const id = String(r.row.id);
        drafted.push(id);
        await tx.opsInvoice.updateMany({ where: { id, workspaceId: actor.workspaceId, recurringId: null }, data: { recurringId: s.id } });
      }
    }
    const ended = Boolean(s.endAt && next.getTime() > s.endAt.getTime());
    // Guarded on the nextRunAt we read: an overlapping sweep advances once.
    await tx.opsRecurringInvoice.updateMany({
      where: { id: s.id, workspaceId: actor.workspaceId, nextRunAt: s.nextRunAt },
      data: {
        nextRunAt: next,
        runCount: { increment: drafted.length },
        lastRunAt: now,
        ...(drafted.length ? { lastInvoiceId: drafted[drafted.length - 1] } : {}),
        ...(ended ? { active: false } : {}),
      },
    });
    out.push({ scheduleId: s.id, drafted, nextRunAt: next, ended });
  }
  return out;
}
