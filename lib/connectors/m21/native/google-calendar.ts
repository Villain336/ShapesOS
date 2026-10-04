// Marketr — M21 Google Calendar adapter (Connector Agent slice 2).
//
// LIVE WIRING: this adapter calls the Google Calendar API v3 with the
// tenant's OAuth2 bearer token (scope calendar.readonly, granted via the
// vault OAuth flow). It reads event ATTENDEES + organizer only — event
// titles, descriptions, and locations are never fetched or stored.
//
//   GET https://www.googleapis.com/calendar/v3/calendarList
//     → the tenant's calendars (primary id = tenant's own email)
//   GET https://www.googleapis.com/calendar/v3/calendars/{id}/events
//     ?singleEvents=true&orderBy=startTime&timeMin=…
//     → attendees[]/organizer per event instance
//
// Meetings are mutual: direction is always null (neither inbound nor
// outbound) — they count toward frequency/recency, not reciprocity.
// Declined attendees and resource/room attendees are skipped.
//
// Rate bounds: first 5 calendars, max 1000 events per call.
// Auth: OAuth2 Bearer <redacted> refresh via lib/vault/refresh.ts.
//
// Phase 11 (conncore): list_events (read) and create_event / update_event
// (MUTATING — the chat confirmation gate asks first; they map to the
// default Tier-2 connector_write action, so they always ask). Scope
// calendar.events. Live calls: lib/connectors/m21/live/gcal.ts. Without a
// credential they fail "not connected" (no mock writes).

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { boolProp, fail, liveOk, numProp, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import { eventWindow, gcalCreateEvent, gcalListEvents, gcalUpdateEvent } from "../live/gcal";
import { parseEventArgs } from "../live/graph";
import { inputFailure } from "./outlook";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const MAX_EVENTS_HARD_CAP = 1000;
const MAX_CALENDARS = 5;

export interface CalendarNetworkContact {
  email: string;
  name: string | null;
  /** Meetings shared with this contact. */
  interactionCount: number;
  /** Always 0 for calendar (mutual) — kept so the shape matches Gmail's. */
  inboundCount: number;
  outboundCount: number;
  /** ISO date of the newest shared meeting. */
  lastInteractionAt: string | null;
}

export interface CalendarNetworkResult {
  contacts: CalendarNetworkContact[];
  /** ISO date of the newest event processed — the import cursor. */
  cursor: string | null;
}

async function calFetch(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${CAL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Google Calendar API request failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<unknown>;
}

export class GoogleCalendarAdapter implements ConnectorAdapter {
  readonly key = "google-calendar";
  readonly displayName = "Google Calendar";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {},
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      // Phase 11 (conncore): events read + gated writes.
      ...calendarEventTools("Google Calendar", true),
      {
        name: "list_network_contacts",
        description:
          "Aggregate the tenant's meeting network from calendar event attendees and organizers. Event titles and details are never read. Returns per-contact meeting counts and an import cursor.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            since: strProp(
              "ISO date — only events starting after this are scanned (incremental sync).",
            ),
            maxEvents: strProp("Max events to scan (default 250, hard cap 1000)."),
          },
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    _ctx: InvokeContext,
  ): Promise<InvokeResult> {
    if (tool === "list_events" || tool === "create_event" || tool === "update_event") {
      return this.events(tool, args, credential, _ctx);
    }
    if (tool !== "list_network_contacts") {
      return fail(`Unknown tool "${tool}" for the Google Calendar connector.`);
    }
    const token =
      credential?.kind === "oauth2" && typeof credential.payload.access_token === "string"
        ? (credential.payload.access_token as string)
        : null;
    if (!token) {
      return fail(
        "Google Calendar is not connected. Connect it first so the connector can read event attendees.",
      );
    }
    const maxEvents = Math.min(
      Math.max(Number(args.maxEvents) || 250, 1),
      MAX_EVENTS_HARD_CAP,
    );
    const since = typeof args.since === "string" && args.since ? new Date(args.since) : null;
    const sinceValid = since && !Number.isNaN(since.getTime()) ? since : null;
    const timeMin = (sinceValid ?? new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)).toISOString();

    try {
      const list = (await calFetch("/calendarList?maxResults=100", token)) as {
        items?: Array<{ id: string; primary?: boolean }>;
      };
      const calendars = (list.items ?? []).slice(0, MAX_CALENDARS);
      if (calendars.length === 0) {
        return liveOk({ contacts: [], cursor: null } satisfies CalendarNetworkResult);
      }
      const primary = calendars.find((c) => c.primary) ?? calendars[0];
      const ownEmail = primary.id.toLowerCase();

      const contacts = new Map<string, CalendarNetworkContact>();
      let newest: Date | null = null;
      let scanned = 0;

      outer: for (const cal of calendars) {
        let pageToken: string | undefined;
        while (scanned < maxEvents) {
          const params = new URLSearchParams({
            singleEvents: "true",
            orderBy: "startTime",
            timeMin,
            maxResults: String(Math.min(250, maxEvents - scanned)),
            fields:
              "items(attendees(email,displayName,responseStatus,resource),organizer(email,displayName),start),nextPageToken",
            ...(pageToken ? { pageToken } : {}),
          });
          const page = (await calFetch(
            `/calendars/${encodeURIComponent(cal.id)}/events?${params.toString()}`,
            token,
          )) as {
            items?: Array<{
              start?: { dateTime?: string; date?: string };
              attendees?: Array<{
                email?: string;
                displayName?: string;
                responseStatus?: string;
                resource?: boolean;
              }>;
              organizer?: { email?: string; displayName?: string };
            }>;
            nextPageToken?: string;
          };
          for (const ev of page.items ?? []) {
            scanned += 1;
            const startRaw = ev.start?.dateTime ?? ev.start?.date;
            const start = startRaw ? new Date(startRaw) : null;
            const startValid = start && !Number.isNaN(start.getTime());
            if (startValid) {
              if (!newest || (start as Date) > newest) newest = start as Date;
              // Incremental guard: timeMin is exact, but be strict anyway.
              if (sinceValid && (start as Date).getTime() <= sinceValid.getTime()) continue;
            }

            const seen = new Set<string>();
            const people: Array<{ email: string; name: string | null }> = [];
            if (ev.organizer?.email) {
              people.push({
                email: ev.organizer.email,
                name: ev.organizer.displayName ?? null,
              });
            }
            for (const a of ev.attendees ?? []) {
              if (!a.email || a.resource) continue;
              if (a.responseStatus === "declined") continue;
              people.push({ email: a.email, name: a.displayName ?? null });
            }
            for (const p of people) {
              const email = p.email.toLowerCase();
              if (email === ownEmail || seen.has(email)) continue;
              seen.add(email);
              const existing = contacts.get(email);
              const row: CalendarNetworkContact = existing ?? {
                email,
                name: null,
                interactionCount: 0,
                inboundCount: 0,
                outboundCount: 0,
                lastInteractionAt: null,
              };
              if (!row.name && p.name) row.name = p.name;
              row.interactionCount += 1;
              if (startValid) {
                const iso = (start as Date).toISOString();
                if (!row.lastInteractionAt || iso > row.lastInteractionAt) {
                  row.lastInteractionAt = iso;
                }
              }
              contacts.set(email, row);
            }
          }
          pageToken = page.nextPageToken;
          if (!pageToken) break;
        }
        if (scanned >= maxEvents) break outer;
      }

      return liveOk({
        contacts: [...contacts.values()],
        cursor: newest ? newest.toISOString() : null,
      } satisfies CalendarNetworkResult);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Calendar import failed.");
    }
  }

  /** Phase 11 (conncore): events read/write (writes gated upstream). */
  private async events(
    tool: "list_events" | "create_event" | "update_event",
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) {
      return { ok: false, mock: false, errorCode: "not_connected", error: "Google Calendar is not connected. Connect it to manage events." };
    }
    const notify = args.notifyAttendees !== false && args.notifyAttendees !== "false";
    try {
      if (tool === "list_events") {
        return liveOk(await gcalListEvents(auth, { calendarId: args.calendarId, ...eventWindow(args), max: Number(args.limit) || 50 }, this.deps));
      }
      if (tool === "create_event") {
        return liveOk(await gcalCreateEvent(auth, { calendarId: args.calendarId, fields: parseEventArgs(args, true), notify }, this.deps));
      }
      return liveOk(
        await gcalUpdateEvent(auth, { calendarId: args.calendarId, eventId: args.eventId, fields: parseEventArgs(args, false), notify }, this.deps),
      );
    } catch (err) {
      return inputFailure(err, "Google Calendar");
    }
  }
}

/** Phase 11 (conncore): the event tools shared by Google and Outlook calendars. */
export function calendarEventTools(provider: string, hasCalendarId: boolean): ConnectorToolDef[] {
  const cal = hasCalendarId ? { calendarId: strProp('Calendar id (default "primary").') } : {};
  const fields = {
    title: strProp("Event title."),
    start: strProp("Start, ISO date-time (e.g. 2026-10-12T15:00:00)."),
    end: strProp("End, ISO date-time."),
    timeZone: strProp("IANA time zone for start/end without an offset (default UTC), e.g. Europe/London."),
    description: strProp("Event description (plain text)."),
    location: strProp("Location."),
    attendees: strProp("Attendee email addresses, comma-separated."),
  };
  return [
    {
      name: "list_events",
      description: `List ${provider} events in a window (default: the next 14 days) with ids, titles, times and attendees.`,
      mutating: false,
      argsSchema: {
        type: "object",
        properties: { ...cal, from: strProp("Window start (ISO date-time; default now)."), to: strProp("Window end (ISO date-time; default from + 14 days)."), limit: numProp("Max events (default 50).") },
      },
    },
    {
      name: "create_event",
      description: `Create a ${provider} event and invite attendees. Asks for confirmation first.`,
      mutating: true,
      argsSchema: {
        type: "object",
        properties: { ...cal, ...fields, ...(hasCalendarId ? { notifyAttendees: boolProp("Email invitations to attendees (default true).") } : {}) },
        required: ["title", "start", "end"],
      },
    },
    {
      name: "update_event",
      description: `Change a ${provider} event (only the fields you pass). Asks for confirmation first.`,
      mutating: true,
      argsSchema: {
        type: "object",
        properties: { ...cal, eventId: strProp("Event id (from list_events or create_event)."), ...fields, ...(hasCalendarId ? { notifyAttendees: boolProp("Email the change to attendees (default true).") } : {}) },
        required: ["eventId"],
      },
    },
  ];
}
