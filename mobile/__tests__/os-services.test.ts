// ShapesOS mobile — Phase 18.3 (WS=trust): the data layer of the new screens
// (unified approvals, notifications + preferences, read-only Files /
// Calendar / Mail). Pinned to the REAL route shapes; fetch is a recorder.
import { describe, expect, it } from "vitest";
import {
  OsApiError,
  decideInboxItem,
  decisionRequest,
  fetchCalendar,
  fetchFiles,
  fetchInbox,
  fetchMail,
  fetchNotificationPrefs,
  fetchNotifications,
  fetchWorkspace,
  formatSize,
  groupByDay,
  groupInbox,
  markNotificationsRead,
  parentPrefix,
  saveNotificationPrefs,
  setPhonePush,
  toggleMuted,
  type InboxItem,
} from "../src/api/os";

function recorder(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  let i = 0;
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return Response.json(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, opts: { baseUrl: "https://x.example.com", authHeaders: () => ({ Cookie: "authjs.session-token=t" }), fetchImpl } };
}

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  key: "autopilot:i1",
  id: "i1",
  source: "autopilot",
  typeLabel: "Content refresh",
  title: "Refresh pricing",
  detail: null,
  requester: null,
  createdAt: "2026-10-06T10:00:00.000Z",
  risk: "low",
  href: "/dashboard/projects/p1/autopilot",
  canDecide: true,
  blockedReason: null,
  approve: { method: "POST", url: "/api/autopilot/items/i1/approve", body: { projectId: "p1" } },
  deny: { method: "POST", url: "/api/autopilot/items/i1/reject", body: { projectId: "p1" } },
  agent: "Autopilot",
  ...over,
});

describe("unified approvals (all 17 sources)", () => {
  it("reads /api/approvals/inbox with the session cookie", async () => {
    const r = recorder([{ body: { items: [item()], sources: [{ source: "autopilot", label: "Autopilot", total: 1, actionable: 1 }], errors: [], total: 1, actionable: 1 } }]);
    const res = await fetchInbox(r.opts);
    expect(r.calls[0]!.url).toBe("https://x.example.com/api/approvals/inbox");
    expect(r.calls[0]!.headers.Cookie).toContain("authjs.session-token");
    expect(res.items[0]!.source).toBe("autopilot");
  });

  it("decides through the item's own source route (never a mobile-only path)", async () => {
    const r = recorder([{ body: { ok: true } }]);
    await decideInboxItem(r.opts, item(), "deny");
    expect(r.calls[0]).toMatchObject({ url: "https://x.example.com/api/autopilot/items/i1/reject", method: "POST", body: { projectId: "p1" } });
  });

  it("refuses to decide what the person can't decide here", async () => {
    const blocked = item({ canDecide: false, approve: null, deny: null, blockedReason: "Needs an editor or above to decide." });
    expect(decisionRequest(blocked, "approve")).toBeNull();
    await expect(decideInboxItem(recorder([{ body: {} }]).opts, blocked, "approve")).rejects.toThrow(/editor/);
    expect(decisionRequest(item({ approve: { method: "POST", url: "https://evil.example/x", body: {} } }), "approve")).toBeNull();
  });

  it("groups by source, actionable first", () => {
    const g = groupInbox({
      items: [item({ key: "a", canDecide: false, createdAt: "2026-10-06T11:00:00Z" }), item({ key: "b" }), item({ key: "c", source: "workflow" })],
      sources: [{ source: "autopilot", label: "Autopilot", total: 2, actionable: 1 }, { source: "workflow", label: "Workflow", total: 1, actionable: 1 }],
    });
    expect(g.map((x) => x.label)).toEqual(["Autopilot", "Workflow"]);
    expect(g[0]!.items.map((i) => i.key)).toEqual(["b", "a"]);
  });

  it("surfaces the server's error", async () => {
    await expect(fetchInbox(recorder([{ status: 403, body: { error: "Not a member" } }]).opts)).rejects.toBeInstanceOf(OsApiError);
  });
});

describe("notifications and the person's preferences", () => {
  it("lists, marks one and marks all read", async () => {
    const r = recorder([{ body: { notifications: [], unread: 0 } }, { body: { updated: 1, unread: 0 } }, { body: { updated: 3, unread: 0 } }]);
    await fetchNotifications(r.opts, { limit: 10, before: "2026-10-06T10:00:00.000Z" });
    await markNotificationsRead(r.opts, ["n1"]);
    await markNotificationsRead(r.opts, "all");
    expect(r.calls[0]!.url).toBe("https://x.example.com/api/notifications?limit=10&before=2026-10-06T10%3A00%3A00.000Z");
    expect(r.calls[1]).toMatchObject({ url: "https://x.example.com/api/notifications/read", method: "POST", body: { ids: ["n1"] } });
    expect(r.calls[2]!.body).toEqual({ all: true });
  });

  it("reads and saves the SAME preference store as the web (/api/preferences)", async () => {
    const prefs = { inApp: true, push: true, mutedKinds: [] as string[], channels: {} };
    const r = recorder([{ body: { preferences: { notifications: prefs } } }, { body: { preferences: { notifications: { ...prefs, mutedKinds: ["mention"] } } } }]);
    const got = await fetchNotificationPrefs(r.opts);
    const saved = await saveNotificationPrefs(r.opts, toggleMuted(got, "mention", true));
    expect(r.calls[1]).toMatchObject({ url: "https://x.example.com/api/preferences", method: "PATCH", body: { notifications: { mutedKinds: ["mention"] } } });
    expect(saved.mutedKinds).toEqual(["mention"]);
  });

  it("mute and phone-push edits are pure", () => {
    const p = { inApp: true, push: true, mutedKinds: ["mention"] };
    expect(toggleMuted(p, "mention", false).mutedKinds).toEqual([]);
    expect(setPhonePush(p, "invoice_paid", true).channels).toEqual({ invoice_paid: { push: true } });
    expect(p).toEqual({ inApp: true, push: true, mutedKinds: ["mention"] });
  });
});

describe("Files, Calendar and Mail (read-only)", () => {
  it("files: the workspace from /api/projects, then /api/files", async () => {
    const r = recorder([{ body: { workspace: { id: "ws1", name: "Acme" }, projects: [] } }, { body: { prefix: "/files", dirs: [], files: [] } }]);
    const ws = await fetchWorkspace(r.opts);
    await fetchFiles(r.opts, ws!.id, "/files/a b");
    expect(r.calls[1]!.url).toBe("https://x.example.com/api/files?workspaceId=ws1&prefix=%2Ffiles%2Fa+b");
    expect(parentPrefix("/files/a/b")).toBe("/files/a");
    expect(parentPrefix("/files")).toBe("/");
    expect(formatSize(1536)).toBe("2 KB");
  });

  it("calendar: a two-week window, grouped by the person's day", async () => {
    const r = recorder([{ body: { events: [], errors: [], timeZone: "UTC" } }]);
    await fetchCalendar(r.opts, new Date("2026-10-06T00:00:00Z"), 14);
    expect(r.calls[0]!.url).toBe("https://x.example.com/api/comms/calendar/events?from=2026-10-06T00%3A00%3A00.000Z&to=2026-10-20T00%3A00%3A00.000Z");
    const days = groupByDay(
      [
        { id: "b", source: "google", title: "B", start: "2026-10-07T01:00:00Z", end: null, allDay: false, location: null, mock: false },
        { id: "a", source: "booking", title: "A", start: "2026-10-06T23:30:00Z", end: null, allDay: false, location: null, mock: false },
        { id: "c", source: "google", title: "C", start: "2026-10-08", end: null, allDay: true, location: null, mock: false },
      ],
      "America/New_York",
    );
    expect(days.map((d) => [d.day, d.events.map((e) => e.id)])).toEqual([["2026-10-06", ["a", "b"]], ["2026-10-08", ["c"]]]);
  });

  it("mail: the unified inbox", async () => {
    const r = recorder([{ body: { threads: [], sources: [] } }]);
    await fetchMail(r.opts);
    expect(r.calls[0]!.url).toBe("https://x.example.com/api/comms/mail/threads?folder=inbox");
  });
});
