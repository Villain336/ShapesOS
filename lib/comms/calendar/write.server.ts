// ShapesOS — Phase 18.2 (WS=comms): creating / changing an event on the
// member's OWN connected calendar — through the connector's existing
// create_event / update_event tools (the same live calls, invitations and
// validation as the agent's connector tools).
//
// Who decides:
//   - a person in the Calendar app: their click IS the confirmation
//     (audited as calendar_event_saved);
//   - an agent: the calendar_create_event_* tools (lib/comms/tools.ts) run
//     through executeTool, whose confirmation gate applies the connector's
//     own action (write_google_calendar / write_outlook_calendar, Tier 2:
//     asks unless a per-agent rule says auto). Nothing here skips that gate.

import { HttpError } from "@/lib/api/errors";
import { auditEvent } from "@/lib/auditlog";
import { invokeConnection, ownConnection } from "../connectors.server";

export interface EventInput {
  title?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string;
  description?: string;
  location?: string;
  notifyAttendees?: boolean;
}

export interface SavedEvent {
  ok: true;
  mock: boolean;
  event: Record<string, unknown> | null;
  provider: "google-calendar" | "outlook-calendar";
}

export async function saveCalendarEvent(input: {
  workspaceId: string;
  userId: string;
  connectionId: string;
  eventId?: string | null;
  fields: EventInput;
  /** Who: "person" (audited here) or an agent (audited by executeTool). */
  by: "person" | "agent";
}): Promise<SavedEvent> {
  const conn = await ownConnection(input.workspaceId, input.userId, input.connectionId, ["google-calendar", "outlook-calendar"]);
  if (!conn) throw new HttpError(404, "That calendar is not connected to your account. Connect it in Settings → Connectors.");
  const tool = input.eventId ? "update_event" : "create_event";
  const args: Record<string, unknown> = { ...input.fields };
  if (input.eventId) args.eventId = input.eventId;
  const res = await invokeConnection(conn, tool, args, { workspaceId: input.workspaceId, userId: input.userId });
  if (!res.ok) {
    const status = res.errorCode === "bad_request" ? 400 : res.errorCode === "not_connected" ? 409 : 502;
    throw new HttpError(status, res.error ?? "The calendar refused the change.");
  }
  if (input.by === "person") {
    await auditEvent({
      projectId: null,
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      action: "calendar_event_saved",
      summary: `${input.eventId ? "Changed" : "Created"} "${String(input.fields.title ?? "event").slice(0, 120)}" on ${conn.connectorKey}${res.mock ? " (MOCK — nothing changed)" : ""}`,
    });
  }
  return { ok: true, mock: !!res.mock, event: (res.data as Record<string, unknown>) ?? null, provider: conn.connectorKey as SavedEvent["provider"] };
}
