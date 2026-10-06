// ShapesOS — Phase 18.3 (WS=trust): the meeting-starting sweep.
//
// Over the 18.2 Calendar's own sources (lib/comms/calendar/sources.server.ts
// loadCalendarEvents — no event store of its own): each member's connected
// Google / Outlook calendars, plus the workspace's bookings and operations
// events for editors and up. An event starting within MEETING_LEAD_MS gets
// ONE `meeting_starting` notification per person per occurrence (the
// producer's dedup key), through the producer seam (channels, focus, mute).
// Runs from the notifications cron (lib/cron/jobs.ts "notifications").
// Members who muted the kind are skipped before any calendar is read.

import { prisma } from "@/lib/prisma";
import { roleAtLeast } from "@/lib/authz";
import { recipientsAllowing } from "@/lib/preferences";
import type { CalendarEvent, CalendarSource } from "@/lib/comms/calendar/sources.server";

export const MEETING_LEAD_MS = 10 * 60_000;
const MAX_MEMBERS_PER_RUN = 300;

export interface MeetingSweepDeps {
  loadEvents?: (ctx: { workspaceId: string; userId: string; timeZone: string }, from: Date, to: Date, include: readonly CalendarSource[]) => Promise<CalendarEvent[]>;
  notify?: (input: { workspaceId: string; userId: string; eventId: string; title: string; startsAt: Date; href: string | null }) => Promise<number>;
  timeZoneOf?: (userId: string) => Promise<string | null>;
}

export interface MeetingSweepResult {
  members: number;
  events: number;
  notified: number;
  errors: number;
}

/** Events that start inside [now, now + lead) and are not all-day. PURE. */
export function startingSoon(events: readonly CalendarEvent[], now: Date, leadMs: number = MEETING_LEAD_MS): CalendarEvent[] {
  const from = now.getTime();
  const to = from + leadMs;
  return events.filter((e) => {
    if (e.allDay) return false;
    const t = new Date(e.start).getTime();
    return Number.isFinite(t) && t >= from && t < to;
  });
}

export async function sweepMeetingsStarting(opts: { workspaceIds: readonly string[]; now?: Date; deps?: MeetingSweepDeps }): Promise<MeetingSweepResult> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? {};
  const out: MeetingSweepResult = { members: 0, events: 0, notified: 0, errors: 0 };
  const loadEvents =
    deps.loadEvents ??
    (async (ctx, from, to, include) => {
      const { loadCalendarEvents } = await import("@/lib/comms/calendar/sources.server");
      return (await loadCalendarEvents(ctx, from, to, { include })).events;
    });
  const notify =
    deps.notify ??
    (async (input) => {
      const { notifyMeetingStarting } = await import("./producers");
      return notifyMeetingStarting({ ...input, startsAt: input.startsAt });
    });
  const tzOf =
    deps.timeZoneOf ??
    (async (userId: string) => {
      const { getUserPreferences } = await import("@/lib/preferences");
      return (await getUserPreferences(userId).catch(() => null))?.timeZone ?? null;
    });
  let budget = MAX_MEMBERS_PER_RUN;
  for (const workspaceId of opts.workspaceIds) {
    if (budget <= 0) break;
    try {
      const members = await prisma.workspaceMember.findMany({ where: { workspaceId, userId: { not: null } }, select: { userId: true, role: true }, take: 500 });
      const listening = await recipientsAllowing(members.map((m) => m.userId!), "inApp", "meeting_starting");
      for (const m of members) {
        if (budget <= 0) break;
        const userId = m.userId!;
        if (!listening.has(userId)) continue;
        budget--;
        out.members++;
        try {
          const include: CalendarSource[] = roleAtLeast(m.role, "editor") ? ["google", "outlook", "booking", "ops_event"] : ["google", "outlook"];
          const events = startingSoon(await loadEvents({ workspaceId, userId, timeZone: (await tzOf(userId)) ?? "UTC" }, now, new Date(now.getTime() + MEETING_LEAD_MS), include), now);
          out.events += events.length;
          for (const e of events) {
            out.notified += await notify({ workspaceId, userId, eventId: e.id, title: e.title || "Meeting", startsAt: new Date(e.start), href: e.href });
          }
        } catch (err) {
          out.errors++;
          console.warn("[notifications] meeting sweep skipped a member:", err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      out.errors++;
      console.warn("[notifications] meeting sweep skipped a workspace:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}
