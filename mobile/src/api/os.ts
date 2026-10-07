// ShapesOS mobile — Phase 18.3 (WS=trust): the OS services the phone shares
// with the web, as one typed client (pure: no React Native imports, so vitest
// covers it). Every call uses the web app's session cookie (src/auth/
// session.ts); the server enforces roles and decides everything — the phone
// never reimplements a rule.
//
//   Unified approvals   GET  /api/approvals/inbox → { items, sources, errors, total, actionable, role }
//                       approve / deny: POST the item's OWN action (its source's
//                       existing decide route, e.g. /api/autopilot/items/[id]/approve)
//   Notifications       GET  /api/notifications?limit=&before= → { notifications, unread }
//                       POST /api/notifications/read { ids } | { all: true } → { updated, unread }
//   Your preferences    GET  /api/preferences → { preferences }
//                       PATCH /api/preferences { notifications } → { preferences }
//   Workspace           GET  /api/projects → { workspace: { id, name } }
//   Files (read-only)   GET  /api/files?workspaceId=&prefix= → { prefix, dirs, files }
//   Calendar (read)     GET  /api/comms/calendar/events?from=&to= → { events, errors, timeZone }
//   Mail (read)         GET  /api/comms/mail/threads?folder=inbox → { threads, sources }

export interface OsClientOptions {
  baseUrl: string;
  authHeaders: () => Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class OsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(opts: OsClientOptions, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { ...opts.authHeaders(), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) message = b.error;
    } catch {
      /* keep the status message */
    }
    throw new OsApiError(res.status, message);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Unified approvals (all 17 sources)
// ---------------------------------------------------------------------------

export interface InboxAction {
  method: "POST";
  url: string;
  body: Record<string, unknown>;
}

export interface InboxItem {
  key: string;
  id: string;
  source: string;
  typeLabel: string;
  title: string;
  detail: string | null;
  requester: string | null;
  createdAt: string;
  risk: "low" | "medium" | "high";
  href: string;
  canDecide: boolean;
  blockedReason: string | null;
  approve: InboxAction | null;
  deny: InboxAction | null;
  agent: string | null;
}

export interface InboxResult {
  items: InboxItem[];
  sources: Array<{ source: string; label: string; total: number; actionable: number }>;
  errors: Array<{ source: string; message: string }>;
  total: number;
  actionable: number;
}

export function fetchInbox(opts: OsClientOptions): Promise<InboxResult> {
  return call<InboxResult>(opts, "/api/approvals/inbox");
}

/**
 * The request a decision makes: the item's own action (its source's existing
 * decide route, which re-checks every rule). Null when this person can't
 * decide it here — open it on the web instead. PURE.
 */
export function decisionRequest(item: InboxItem, decision: "approve" | "deny"): InboxAction | null {
  if (!item.canDecide) return null;
  const a = decision === "approve" ? item.approve : item.deny;
  if (!a || a.method !== "POST" || !a.url.startsWith("/api/")) return null;
  return a;
}

export async function decideInboxItem(opts: OsClientOptions, item: InboxItem, decision: "approve" | "deny"): Promise<void> {
  const a = decisionRequest(item, decision);
  if (!a) throw new OsApiError(403, item.blockedReason ?? "Decide this one on the web.");
  await call<unknown>(opts, a.url, { method: "POST", body: a.body });
}

/** Items grouped by source label, actionable first inside each group. PURE. */
export function groupInbox(result: Pick<InboxResult, "items" | "sources">): Array<{ source: string; label: string; items: InboxItem[] }> {
  const label = new Map(result.sources.map((s) => [s.source, s.label]));
  const groups = new Map<string, InboxItem[]>();
  for (const i of result.items) groups.set(i.source, [...(groups.get(i.source) ?? []), i]);
  return [...groups.entries()].map(([source, items]) => ({
    source,
    label: label.get(source) ?? source,
    items: [...items].sort((a, b) => Number(b.canDecide) - Number(a.canDecide) || b.createdAt.localeCompare(a.createdAt)),
  }));
}

// ---------------------------------------------------------------------------
// Notifications + the person's channels
// ---------------------------------------------------------------------------

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export function fetchNotifications(opts: OsClientOptions, q: { limit?: number; before?: string | null } = {}): Promise<{ notifications: NotificationItem[]; unread: number }> {
  const p = new URLSearchParams({ limit: String(q.limit ?? 30) });
  if (q.before) p.set("before", q.before);
  return call(opts, `/api/notifications?${p.toString()}`);
}

export function markNotificationsRead(opts: OsClientOptions, ids: string[] | "all"): Promise<{ updated: number; unread: number }> {
  return call(opts, "/api/notifications/read", { method: "POST", body: ids === "all" ? { all: true } : { ids } });
}

export interface NotificationPrefs {
  inApp: boolean;
  push: boolean;
  mutedKinds: string[];
  webPush?: boolean;
  emailDigest?: "off" | "daily";
  slack?: boolean;
  summary?: boolean;
  channels?: Record<string, Partial<Record<"inApp" | "push" | "webPush" | "email" | "slack", boolean>>>;
}

export async function fetchNotificationPrefs(opts: OsClientOptions): Promise<NotificationPrefs> {
  const r = await call<{ preferences: { notifications: NotificationPrefs } }>(opts, "/api/preferences");
  return r.preferences.notifications;
}

export async function saveNotificationPrefs(opts: OsClientOptions, prefs: NotificationPrefs): Promise<NotificationPrefs> {
  const r = await call<{ preferences: { notifications: NotificationPrefs } }>(opts, "/api/preferences", { method: "PATCH", body: { notifications: prefs } });
  return r.preferences.notifications;
}

/** Mute or unmute one kind on every channel (the same store the web uses). PURE. */
export function toggleMuted(prefs: NotificationPrefs, kind: string, muted: boolean): NotificationPrefs {
  const set = new Set(prefs.mutedKinds);
  if (muted) set.add(kind);
  else set.delete(kind);
  return { ...prefs, mutedKinds: [...set] };
}

/** Turn phone push on/off for one kind (the per-kind cell). PURE. */
export function setPhonePush(prefs: NotificationPrefs, kind: string, on: boolean): NotificationPrefs {
  const channels = { ...(prefs.channels ?? {}) };
  channels[kind] = { ...(channels[kind] ?? {}), push: on };
  return { ...prefs, channels };
}

/** The kinds the notification settings list, in order (lib/preferences NOTIFICATION_KINDS). */
export const NOTIFICATION_KINDS = [
  "approval_needed",
  "approval_decided",
  "alert_fired",
  "run_failed",
  "invite_accepted",
  "mention",
  "direct_message",
  "reminder_due",
  "run_finished",
  "invoice_paid",
  "ticket_assigned",
  "meeting_starting",
] as const;

export const NOTIFICATION_KIND_LABELS: Record<(typeof NOTIFICATION_KINDS)[number], string> = {
  approval_needed: "Approval needed",
  approval_decided: "Approval decided",
  alert_fired: "Alerts",
  run_failed: "Failed runs",
  invite_accepted: "Invites accepted",
  mention: "Mentions of you",
  direct_message: "Direct messages",
  reminder_due: "Reminders due",
  run_finished: "Runs finished",
  invoice_paid: "Invoices paid",
  ticket_assigned: "Tickets assigned to you",
  meeting_starting: "Meetings starting",
};

// ---------------------------------------------------------------------------
// Files, Calendar, Mail (read-only on the phone)
// ---------------------------------------------------------------------------

export async function fetchWorkspace(opts: OsClientOptions): Promise<{ id: string; name: string } | null> {
  const r = await call<{ workspace?: { id: string; name: string } }>(opts, "/api/projects");
  return r.workspace ?? null;
}

export interface FileEntry {
  id: string;
  filename: string;
  logicalPath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface FileListing {
  prefix: string;
  dirs: string[];
  files: FileEntry[];
}

export function fetchFiles(opts: OsClientOptions, workspaceId: string, prefix = "/files"): Promise<FileListing> {
  const p = new URLSearchParams({ workspaceId, prefix });
  return call(opts, `/api/files?${p.toString()}`);
}

/** The parent of a folder ("/files/a/b" → "/files/a"; never above "/"). PURE. */
export function parentPrefix(prefix: string): string {
  const parts = prefix.split("/").filter(Boolean);
  return parts.length <= 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
}

/** "48 KB", "1.2 MB". PURE. */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export interface CalendarEvent {
  id: string;
  source: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  mock: boolean;
}

export function fetchCalendar(opts: OsClientOptions, from: Date, days = 14): Promise<{ events: CalendarEvent[]; errors: Array<{ source: string; message: string }>; timeZone: string }> {
  const to = new Date(from.getTime() + days * 86_400_000);
  const p = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return call(opts, `/api/comms/calendar/events?${p.toString()}`);
}

/** Events grouped by local day (YYYY-MM-DD in the given zone), in order. PURE. */
export function groupByDay(events: readonly CalendarEvent[], timeZone: string): Array<{ day: string; events: CalendarEvent[] }> {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const days = new Map<string, CalendarEvent[]>();
  for (const e of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
    const day = e.allDay && /^\d{4}-\d{2}-\d{2}/.test(e.start) ? e.start.slice(0, 10) : fmt.format(new Date(e.start));
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return [...days.entries()].map(([day, list]) => ({ day, events: list }));
}

export interface MailThread {
  key: string;
  source: string;
  via: string;
  subject: string;
  from: { name: string | null; address: string | null };
  snippet: string | null;
  lastMessageAt: string;
  unread: boolean;
}

export function fetchMail(opts: OsClientOptions): Promise<{ threads: MailThread[]; sources: Array<{ source: string; connected: boolean; error?: string | null }> }> {
  return call(opts, "/api/comms/mail/threads?folder=inbox");
}
