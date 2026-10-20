// ShapesOS — Phase 18.2 (WS=comms): the comms sweep (POST /api/cron/comms).
//
//   1. Reminders due: every open personal reminder whose due time has come
//      gets ONE `reminder_due` notification per occurrence (the producer's
//      dedup key is the occurrence), then the occurrence is marked notified.
//      Through the producers, so focus holds it and muted kinds drop it.
//   2. Contacts: links new records in the four people stores to their own
//      identity and refreshes merge suggestions (lib/comms/contacts/sync.ts)
//      — suggestions only; nothing is ever merged here.
//
// Every table touched is FORCE RLS, so each workspace runs in its own
// withWorkspaceScope transaction. Never throws for one workspace's failure.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { dueReminders, markReminderNotified } from "./reminders";

export interface ReminderSweepResult {
  workspaces: number;
  due: number;
  notified: number;
  errors: number;
}

export type NotifyReminderFn = (input: { workspaceId: string; userId: string; reminderId: string; title: string; dueAt: Date }) => Promise<number>;

const defaultNotify: NotifyReminderFn = async (input) => {
  const { notifyReminderDue } = await import("@/lib/notifications/producers");
  return notifyReminderDue(input);
};

export async function sweepDueReminders(opts: {
  workspaceIds: readonly string[];
  now?: Date;
  notify?: NotifyReminderFn;
}): Promise<ReminderSweepResult> {
  const now = opts.now ?? new Date();
  const notify = opts.notify ?? defaultNotify;
  const out: ReminderSweepResult = { workspaces: 0, due: 0, notified: 0, errors: 0 };
  for (const workspaceId of opts.workspaceIds) {
    out.workspaces++;
    try {
      const rows = await withWorkspaceScope(workspaceId, (tx) => dueReminders(tx, { workspaceId, now }));
      for (const r of rows) {
        out.due++;
        if (!r.assigneeId || !r.dueAt) continue;
        // At least once: notify (idempotent per occurrence by dedup key), then mark.
        out.notified += await notify({ workspaceId, userId: r.assigneeId, reminderId: r.id, title: r.title, dueAt: r.dueAt });
        await withWorkspaceScope(workspaceId, (tx) => markReminderNotified(tx, workspaceId, r.id, now));
      }
    } catch (err) {
      out.errors++;
      console.warn("[comms] reminder sweep failed for a workspace:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}
