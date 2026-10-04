// Phase 11 (conncore): Google Calendar + Outlook calendar event reads/writes.
// Request shapes follow the provider docs; fetch is scripted (no network).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/calendar-writes.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GoogleCalendarAdapter } from "../../native/google-calendar";
import { OutlookCalendarAdapter } from "../../native/outlook-calendar";
import { parseEventArgs } from "../graph";
import { googleEventBody, eventWindow } from "../gcal";
import { OAUTH_CONFIGS } from "@/lib/vault/oauth";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith } from "./fixtures";

describe("event argument parsing", () => {
  it("requires title/start/end on create, validates times, zones and attendees", () => {
    assert.throws(() => parseEventArgs({ title: "x" }, true), /start and end are required/);
    assert.throws(() => parseEventArgs({ title: "x", start: "tomorrow", end: "2026-10-12T10:00:00" }, true), /ISO date-time/);
    assert.throws(() => parseEventArgs({ title: "x", start: "2026-10-12T10:00:00", end: "2026-10-12T09:00:00" }, true), /end must be after start/);
    assert.throws(() => parseEventArgs({ start: "2026-10-12T10:00:00", timeZone: "Mars/Olympus Mons!" }, false), /IANA/);
    assert.throws(() => parseEventArgs({ attendees: "bob" }, false), /valid email/);
    const f = parseEventArgs({ title: "Sync\r\nX", start: "2026-10-12T10:00:00", end: "2026-10-12T10:30:00", attendees: "a@x.com, b@y.com" }, true);
    assert.equal(f.title, "Sync X");
    assert.deepEqual(f.attendees, ["a@x.com", "b@y.com"]);
  });

  it("Google body: timeZone defaults to UTC for local times; offsets pass through", () => {
    assert.deepEqual(googleEventBody({ start: "2026-10-12T10:00:00", end: "2026-10-12T11:00:00" }), {
      start: { dateTime: "2026-10-12T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-12T11:00:00", timeZone: "UTC" },
    });
    assert.deepEqual(googleEventBody({ start: "2026-10-12T10:00:00+02:00" }), { start: { dateTime: "2026-10-12T10:00:00+02:00" } });
  });

  it("list window defaults to now → +14 days and is bounded", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    assert.deepEqual(eventWindow({}, now), { from: "2026-10-01T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" });
    assert.throws(() => eventWindow({ from: "2026-10-01T00:00:00Z", to: "2028-10-01T00:00:00Z" }), /at most a year/);
  });
});

describe("Google Calendar events", () => {
  it("create_event: POST calendars/primary/events?sendUpdates=all with the event resource", async () => {
    const f = scriptedFetch([jsonResponse(200, { id: "evt123", summary: "Kickoff", start: { dateTime: "2026-10-12T15:00:00Z" }, end: { dateTime: "2026-10-12T15:30:00Z" }, attendees: [{ email: "ada@example.com" }], htmlLink: "https://calendar.google.com/e" })]);
    const r = await new GoogleCalendarAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "create_event",
      { title: "Kickoff", start: "2026-10-12T15:00:00", end: "2026-10-12T15:30:00", timeZone: "Europe/London", attendees: "ada@example.com", location: "Zoom" },
      oauthCred("ctok"),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    const c = f.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url.origin + c.url.pathname, "https://www.googleapis.com/calendar/v3/calendars/primary/events");
    assert.equal(c.url.searchParams.get("sendUpdates"), "all");
    assert.equal(c.headers.authorization, "Bearer ctok");
    assert.deepEqual(c.body, {
      summary: "Kickoff",
      location: "Zoom",
      start: { dateTime: "2026-10-12T15:00:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-10-12T15:30:00", timeZone: "Europe/London" },
      attendees: [{ email: "ada@example.com" }],
    });
    assert.equal((r.data as { id: string }).id, "evt123");
  });

  it("update_event: PATCH only the passed fields; notifyAttendees=false → sendUpdates=none", async () => {
    const f = scriptedFetch([jsonResponse(200, { id: "evt123", summary: "Moved" })]);
    const r = await new GoogleCalendarAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "update_event",
      { calendarId: "team@group.calendar.google.com", eventId: "evt123", title: "Moved", notifyAttendees: false },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    const c = f.calls[0];
    assert.equal(c.method, "PATCH");
    assert.equal(c.url.pathname, "/calendar/v3/calendars/team%40group.calendar.google.com/events/evt123");
    assert.equal(c.url.searchParams.get("sendUpdates"), "none");
    assert.deepEqual(c.body, { summary: "Moved" });
  });

  it("list_events: singleEvents + orderBy=startTime in the window; a 5xx write is not retried", async () => {
    const f = scriptedFetch([jsonResponse(200, { items: [] }), jsonResponse(500, { error: { message: "x" } })]);
    const a = new GoogleCalendarAdapter(liveDeps(f.fetchImpl).deps);
    await a.invoke("list_events", { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" }, oauthCred(), ctxWith());
    const q = f.calls[0].url.searchParams;
    assert.equal(q.get("singleEvents"), "true");
    assert.equal(q.get("orderBy"), "startTime");
    assert.equal(q.get("timeMin"), "2026-10-01T00:00:00.000Z");
    const w = await a.invoke("create_event", { title: "t", start: "2026-10-12T15:00:00", end: "2026-10-12T16:00:00" }, oauthCred(), ctxWith());
    assert.equal(w.ok, false);
    assert.equal(f.calls.length, 2);
  });

  it("writes are mutating calendar-group tools; the OAuth grant adds calendar.events", () => {
    const tools = new GoogleCalendarAdapter().listTools();
    assert.equal(tools.find((t) => t.name === "create_event")?.mutating, true);
    assert.equal(tools.find((t) => t.name === "update_event")?.mutating, true);
    assert.equal(tools.find((t) => t.name === "list_events")?.mutating, false);
    assert.equal(connectorGroup("google-calendar"), "calendar");
    assert.equal(connectorAction("google-calendar", "create_event"), "connector_write");
    assert.ok(OAUTH_CONFIGS["google-calendar"].scopes.includes("https://www.googleapis.com/auth/calendar.events"));
  });
});

describe("Outlook calendar (Microsoft Graph)", () => {
  it("create_event: POST /me/events with subject/start/end/attendees (local time + timeZone)", async () => {
    const f = scriptedFetch([jsonResponse(201, { id: "AAMkEvt1", subject: "Kickoff", start: { dateTime: "2026-10-12T15:00:00.0000000", timeZone: "Pacific Standard Time" }, end: { dateTime: "2026-10-12T15:30:00.0000000" }, attendees: [{ emailAddress: { address: "ada@example.com" } }], webLink: "https://outlook.office365.com/e" })]);
    const r = await new OutlookCalendarAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "create_event",
      { title: "Kickoff", start: "2026-10-12T15:00:00", end: "2026-10-12T15:30:00", timeZone: "America/Los_Angeles", attendees: "ada@example.com", description: "Agenda" },
      oauthCred("mtok"),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    const c = f.calls[0];
    assert.equal(c.url.href, "https://graph.microsoft.com/v1.0/me/events");
    assert.deepEqual(c.body, {
      subject: "Kickoff",
      body: { contentType: "Text", content: "Agenda" },
      start: { dateTime: "2026-10-12T15:00:00", timeZone: "America/Los_Angeles" },
      end: { dateTime: "2026-10-12T15:30:00", timeZone: "America/Los_Angeles" },
      attendees: [{ emailAddress: { address: "ada@example.com" }, type: "required" }],
    });
    assert.deepEqual((r.data as { attendees: string[] }).attendees, ["ada@example.com"]);
  });

  it("update_event: PATCH /me/events/{id}; an offset time is normalized to UTC", async () => {
    const f = scriptedFetch([jsonResponse(200, { id: "AAMkEvt1" })]);
    await new OutlookCalendarAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "update_event",
      { eventId: "AAMkEvt1", start: "2026-10-12T17:00:00+02:00" },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(f.calls[0].method, "PATCH");
    assert.equal(f.calls[0].url.pathname, "/v1.0/me/events/AAMkEvt1");
    assert.deepEqual(f.calls[0].body, { start: { dateTime: "2026-10-12T15:00:00.000", timeZone: "UTC" } });
  });

  it("list_events: GET /me/calendarView with the window; labelled mock without a credential", async () => {
    const f = scriptedFetch([jsonResponse(200, { value: [] })]);
    const a = new OutlookCalendarAdapter(liveDeps(f.fetchImpl).deps);
    await a.invoke("list_events", { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }, oauthCred(), ctxWith());
    assert.equal(f.calls[0].url.pathname, "/v1.0/me/calendarView");
    assert.equal(f.calls[0].url.searchParams.get("startDateTime"), "2026-10-01T00:00:00.000Z");
    const m = await a.invoke("create_event", { title: "t", start: "2026-10-12T15:00:00", end: "2026-10-12T16:00:00" }, null, ctxWith());
    assert.equal(m.mock, true);
    assert.equal(f.calls.length, 1);
    assert.equal(connectorGroup("outlook-calendar"), "calendar");
    assert.ok(OAUTH_CONFIGS["outlook-calendar"].scopes.includes("https://graph.microsoft.com/Calendars.ReadWrite"));
  });
});
