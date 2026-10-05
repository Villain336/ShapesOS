// ShapesOS — Phase 11 (conncore): Outlook calendar adapter (Microsoft Graph).
//
// LIVE WIRING: with a vault credential (Microsoft identity platform OAuth,
// scopes Calendars.ReadWrite User.Read offline_access) the tools call
// Microsoft Graph v1.0 (lib/connectors/m21/live/graph.ts):
//   list_events   GET   /me/calendarView?startDateTime&endDateTime
//   create_event  POST  /me/events          [mutating — Graph emails invitations]
//   update_event  PATCH /me/events/{id}     [mutating]
// Mutating tools pass the chat confirmation gate first (default Tier-2
// connector_write: always asks).
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected"): labelled "(MOCK)" events; mock writes create nothing.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { fail, liveOk, mockOk } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import { graphCreateEvent, graphListEvents, graphMe, graphUpdateEvent, parseEventArgs } from "../live/graph";
import { eventWindow } from "../live/gcal";
import { calendarEventTools } from "./google-calendar";
import { inputFailure } from "./outlook";

export class OutlookCalendarAdapter implements ConnectorAdapter {
  readonly key = "outlook-calendar";
  readonly displayName = "Outlook Calendar";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return calendarEventTools("Outlook Calendar", false);
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return this.mock(tool, args);
    try {
      switch (tool) {
        case "list_events":
          return liveOk(await graphListEvents(auth, { ...eventWindow(args), top: Number(args.limit) || 50 }, this.deps));
        case "create_event":
          return liveOk(await graphCreateEvent(auth, parseEventArgs(args, true), this.deps));
        case "update_event":
          return liveOk(await graphUpdateEvent(auth, String(args.eventId ?? ""), parseEventArgs(args, false), this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "Outlook Calendar");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Outlook Calendar is not connected." };
    try {
      return liveOk(await graphMe(auth, this.deps));
    } catch (err) {
      return liveFailure(err, "Outlook Calendar");
    }
  }

  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_events":
        return mockOk([
          { id: "mock-evt-1", title: "Weekly sync (MOCK)", start: "2026-10-12T15:00:00", end: "2026-10-12T15:30:00", timeZone: "UTC", location: null, attendees: ["ada@example.com"], url: null, mock: true },
        ]);
      case "create_event":
      case "update_event":
        return mockOk({ created: false, mock: true, title: `${String(args.title ?? "Event")} (MOCK)`, info: "MOCK — Outlook Calendar is not connected; nothing was changed." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
