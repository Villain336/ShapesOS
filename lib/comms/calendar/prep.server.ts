// ShapesOS — Phase 18.2 (WS=comms): meeting prep for the Today briefing.
//
// The member's next meetings (their connected calendars, bookings, Ops
// events, calls) in the coming hours, each with what ShapesOS knows about
// the people in it: their contact card (lib/comms/contacts) — company, the
// latest thing that happened with them, open deals. Facts only; the
// briefing's model is told to use nothing else. Mock rows never count.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { loadCalendarEvents } from "./sources.server";

export interface MeetingPrep {
  start: string;
  title: string;
  attendees: string[];
  /** One line per known attendee: "Ana Ruiz (Acme) — last: Pricing question · open deal: Renewal". */
  prep: string[];
}

export async function nextMeetingsPrep(input: { workspaceId: string; userId: string; timeZone: string; now: Date; hours?: number; max?: number }): Promise<MeetingPrep[]> {
  const to = new Date(input.now.getTime() + (input.hours ?? 24) * 3_600_000);
  const load = await loadCalendarEvents({ workspaceId: input.workspaceId, userId: input.userId, timeZone: input.timeZone }, input.now, to, { include: ["google", "outlook", "booking", "ops_event", "meeting"] });
  const meetings = load.events.filter((e) => !e.mock && !e.allDay && new Date(e.start) >= input.now).slice(0, input.max ?? 3);
  if (!meetings.length) return [];
  return withWorkspaceScope(input.workspaceId, async (tx) => {
    const { identityTimeline, loadRecordsByKeys } = await import("../contacts/store");
    const out: MeetingPrep[] = [];
    for (const m of meetings) {
      const prep: string[] = [];
      for (const email of m.attendees.slice(0, 3)) {
        const identity = await tx.contactIdentity.findFirst({ where: { workspaceId: input.workspaceId, emails: { has: email.toLowerCase() } }, include: { links: { select: { recordKind: true, recordId: true } } } });
        if (!identity) continue;
        const recs = await loadRecordsByKeys(
          tx,
          input.workspaceId,
          identity.links.map((l) => ({ kind: l.recordKind as "lead", id: l.recordId })),
        );
        const timeline = await identityTimeline(tx, input.workspaceId, [...recs.values()], 10, input.userId);
        const last = timeline.find((t) => t.type !== "meeting");
        const deals = timeline.filter((t) => t.type === "deal" && /\bopen\b/.test(t.detail ?? "")).slice(0, 2);
        const parts = [`${identity.displayName}${identity.companies[0] ? ` (${identity.companies[0]})` : ""}`];
        if (last) parts.push(`last: ${last.title.slice(0, 80)}`);
        if (deals.length) parts.push(`open deal: ${deals.map((d) => d.title.slice(0, 60)).join(", ")}`);
        prep.push(parts.join(" — "));
      }
      out.push({ start: m.start, title: m.title || "(no title)", attendees: m.attendees.slice(0, 10), prep });
    }
    return out;
  });
}
