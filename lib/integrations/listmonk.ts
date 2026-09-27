// Marketr — Phase 12: Listmonk email-engine sidecar client.
//
// BYO-key pattern (same as lib/design/unsplash.ts and brandfetch.ts):
//   LISTMONK_URL, LISTMONK_USER, LISTMONK_TOKEN live on the host
//   environment, are read server-side only, and never reach the browser.
//   No credentials → loud honest error, never fake lists/subscribers.
//
// SIDECAR CONTRACT: Listmonk is AGPL-3.0 (single Go binary + Postgres).
// It is a separate process — talked to ONLY over HTTP (Basic auth,
// user:token). Never copy, fork, or import Listmonk code into Marketr.
// See docs/phase12/integration-survey.md §Tier 1 #2.
//
// API shape (verified 2026-09-27 against knadh/listmonk docs):
//   GET    /api/lists?per_page=all           → { data: { results: [...], total } }
//   POST   /api/lists                        → create { name, type, optin, tags, description }
//   GET    /api/lists/{id}
//   GET    /api/subscribers?query=&page=     → { data: { results: [...], total } }
//   POST   /api/subscribers                  → { email, name, status, lists: [ids], attribs }
//   PUT    /api/subscribers/lists            → { ids, action: "add"|"remove"|"unsub", list_ids }
//   GET    /api/campaigns?status=&query=     → { data: { results: [...], total } }
//   POST   /api/campaigns                    → { name, subject, lists, type, messenger, content_type, body, altbody, template_id?, from_email?, status }
//   PUT    /api/campaigns/{id}/status        → { status: "running"|"scheduled", run_at? }
//   POST   /api/campaigns/{id}/test          → test send (subscribers only, campaign stays draft)
//   GET    /api/campaigns/{id}/report/summary → stats

/** Base URL of the Listmonk instance (no trailing slash). */
export const LISTMONK_TIMEOUT_MS = 15_000;

/** Honest unconfigured-credentials message. Names the env vars; never their values. */
export const LISTMONK_NOT_CONFIGURED_MESSAGE =
  "Listmonk isn't connected. Set LISTMONK_URL, LISTMONK_USER and LISTMONK_TOKEN in Settings → Providers, then try again.";

export function getListmonkConfig(): { url: string; user: string; token: string } {
  return {
    url: (process.env.LISTMONK_URL ?? "").replace(/\/+$/, ""),
    user: (process.env.LISTMONK_USER ?? "").trim(),
    token: (process.env.LISTMONK_TOKEN ?? "").trim(),
  };
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function listmonkStatus() {
  const { url, user, token } = getListmonkConfig();
  const configured = url.length > 0 && user.length > 0 && token.length > 0;
  return { name: "listmonk", isLive: configured, configured };
}

function notConfigured(): never {
  throw new ListmonkConfigError(LISTMONK_NOT_CONFIGURED_MESSAGE);
}

// ── Errors ─────────────────────────────────────────────────────────────

/** 400-class local failure (missing credentials, bad input). Routes map it to JSON. */
export class ListmonkConfigError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ListmonkConfigError";
  }
}

/** A Listmonk HTTP response that was not 2xx. Never carries credentials. */
export class ListmonkApiError extends Error {
  readonly status: number;
  readonly listmonkBody: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ListmonkApiError";
    this.status = status;
    this.listmonkBody = body;
  }
}

// ── Trimmed shapes (client-safe: no key material, no vendor internals) ──

export interface ListmonkList {
  id: number;
  name: string;
  type: string;
  optin: string;
  tags: string[];
  description: string;
  subscriberCount: number | null;
}

export interface ListmonkSubscriber {
  id: number;
  email: string;
  name: string;
  status: string;
  lists: Array<{ id: number; name: string }>;
  createdAt: string | null;
}

export interface ListmonkCampaign {
  id: number;
  name: string;
  subject: string;
  status: string;
  lists: Array<{ id: number; name: string }>;
  type: string;
  messenger: string;
  sendAt: string | null;
  sentCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ListmonkCampaignStats {
  sent: number;
  viewed: number;
  clicked: number;
  bounced: number;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────

async function listmonkFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const { url, user, token } = getListmonkConfig();
  if (!url || !user || !token) notConfigured();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LISTMONK_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
        ...(opts.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const msg =
        body && typeof body === "object" && "message" in body
          ? String((body as { message: unknown }).message)
          : `Listmonk request failed (${res.status})`;
      throw new ListmonkApiError(res.status, msg, body);
    }
    return body;
  } catch (e) {
    if (e instanceof ListmonkApiError || e instanceof ListmonkConfigError) throw e;
    throw new ListmonkApiError(502, `Listmonk unreachable: ${e instanceof Error ? e.message : "network error"}`, null);
  } finally {
    clearTimeout(t);
  }
}

function unwrapList<T>(body: unknown): { results: T[]; total: number } {
  const data = (body as { data?: { results?: T[]; total?: number } })?.data;
  return { results: data?.results ?? [], total: data?.total ?? 0 };
}

function unwrapOne<T>(body: unknown): T {
  const data = (body as { data?: T })?.data;
  if (data === undefined) throw new ListmonkApiError(502, "Unexpected Listmonk response shape", body);
  return data;
}

// ── Lists ──────────────────────────────────────────────────────────────

export function mapList(raw: unknown): ListmonkList {
  const r = raw as Record<string, unknown>;
  const lists = Array.isArray(r.subscriber_count) ? null : (r.subscriber_count ?? null);
  return {
    id: Number(r.id ?? 0),
    name: String(r.name ?? ""),
    type: String(r.type ?? ""),
    optin: String(r.optin ?? ""),
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    description: String(r.description ?? ""),
    subscriberCount: typeof lists === "number" ? lists : null,
  };
}

export async function listmonkLists(): Promise<ListmonkList[]> {
  const { results } = unwrapList<unknown>(await listmonkFetch("/api/lists?per_page=all"));
  return results.map(mapList);
}

export async function createListmonkList(input: {
  name: string;
  type?: "public" | "private";
  optin?: "single" | "double";
  description?: string;
}): Promise<ListmonkList> {
  const name = input.name.trim();
  if (!name) throw new ListmonkConfigError("List name is required.");
  const raw = await listmonkFetch("/api/lists", {
    method: "POST",
    body: JSON.stringify({
      name,
      type: input.type ?? "private",
      optin: input.optin ?? "double",
      tags: [],
      description: input.description ?? "",
    }),
  });
  return mapList(unwrapOne<unknown>(raw));
}

// ── Subscribers ────────────────────────────────────────────────────────

export function mapSubscriber(raw: unknown): ListmonkSubscriber {
  const r = raw as Record<string, unknown>;
  const lists = Array.isArray(r.lists) ? r.lists : [];
  return {
    id: Number(r.id ?? 0),
    email: String(r.email ?? ""),
    name: String(r.name ?? ""),
    status: String(r.status ?? ""),
    lists: lists.map((l) => {
      const lr = l as Record<string, unknown>;
      return { id: Number(lr.id ?? 0), name: String(lr.name ?? "") };
    }),
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
  };
}

export async function listmonkSubscribers(opts: { query?: string; page?: number } = {}): Promise<{
  subscribers: ListmonkSubscriber[];
  total: number;
}> {
  const sp = new URLSearchParams({ per_page: "100" });
  if (opts.query?.trim()) sp.set("query", opts.query.trim());
  if (opts.page && opts.page > 0) sp.set("page", String(opts.page));
  const { results, total } = unwrapList<unknown>(await listmonkFetch(`/api/subscribers?${sp}`));
  return { subscribers: results.map(mapSubscriber), total };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function addListmonkSubscriber(input: {
  email: string;
  name?: string;
  listIds: number[];
}): Promise<ListmonkSubscriber> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ListmonkConfigError("A valid email is required.");
  if (!input.listIds.length) throw new ListmonkConfigError("At least one list is required.");
  const raw = await listmonkFetch("/api/subscribers", {
    method: "POST",
    body: JSON.stringify({
      email,
      name: input.name?.trim() ?? "",
      status: "enabled",
      lists: input.listIds,
      attribs: {},
    }),
  });
  return mapSubscriber(unwrapOne<unknown>(raw));
}

// ── Campaigns ──────────────────────────────────────────────────────────

export function mapCampaign(raw: unknown): ListmonkCampaign {
  const r = raw as Record<string, unknown>;
  const lists = Array.isArray(r.lists) ? r.lists : [];
  return {
    id: Number(r.id ?? 0),
    name: String(r.name ?? ""),
    subject: String(r.subject ?? ""),
    status: String(r.status ?? ""),
    lists: lists.map((l) => {
      const lr = l as Record<string, unknown>;
      return { id: Number(lr.id ?? 0), name: String(lr.name ?? "") };
    }),
    type: String(r.type ?? ""),
    messenger: String(r.messenger ?? ""),
    sendAt: typeof r.send_at === "string" ? r.send_at : null,
    sentCount: typeof r.sent === "number" ? r.sent : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
  };
}

export async function listmonkCampaigns(opts: { status?: string; query?: string } = {}): Promise<ListmonkCampaign[]> {
  const sp = new URLSearchParams({ per_page: "all" });
  if (opts.status?.trim()) sp.set("status", opts.status.trim());
  if (opts.query?.trim()) sp.set("query", opts.query.trim());
  const { results } = unwrapList<unknown>(await listmonkFetch(`/api/campaigns?${sp}`));
  return results.map(mapCampaign);
}

export async function getListmonkCampaign(id: number): Promise<ListmonkCampaign> {
  if (!Number.isInteger(id) || id <= 0) throw new ListmonkConfigError("Invalid campaign id.");
  const raw = await listmonkFetch(`/api/campaigns/${id}`);
  return mapCampaign(unwrapOne<unknown>(raw));
}

export interface CreateCampaignInput {
  name: string;
  subject: string;
  listIds: number[];
  body: string;
  /** Optional Listmonk template id; omit to use default. */
  templateId?: number;
  fromEmail?: string;
  contentType?: "html" | "richtext" | "markdown" | "plain";
}

export async function createListmonkCampaign(input: CreateCampaignInput): Promise<ListmonkCampaign> {
  const name = input.name.trim();
  if (!name) throw new ListmonkConfigError("Campaign name is required.");
  if (!input.subject.trim()) throw new ListmonkConfigError("Subject is required.");
  if (!input.listIds.length) throw new ListmonkConfigError("At least one list is required.");
  if (!input.body.trim()) throw new ListmonkConfigError("Body is required.");
  const raw = await listmonkFetch("/api/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name,
      subject: input.subject.trim(),
      lists: input.listIds,
      type: "regular",
      messenger: "email",
      content_type: input.contentType ?? "html",
      body: input.body,
      altbody: input.body.replace(/<[^>]*>/g, " ").slice(0, 2000),
      template_id: input.templateId ?? 1,
      from_email: input.fromEmail?.trim() || undefined,
      status: "draft",
    }),
  });
  return mapCampaign(unwrapOne<unknown>(raw));
}

/**
 * Send a campaign now. This is an irreversible real-world send — the API
 * routes gate this behind an explicit editor confirmation in the UI and
 * never schedule anything without it.
 */
export async function sendListmonkCampaign(id: number): Promise<ListmonkCampaign> {
  if (!Number.isInteger(id) || id <= 0) throw new ListmonkConfigError("Invalid campaign id.");
  const raw = await listmonkFetch(`/api/campaigns/${id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status: "running" }),
  });
  return mapCampaign(unwrapOne<unknown>(raw));
}

/** Schedule a campaign for a future RFC3339 time. Never schedules the past. */
export async function scheduleListmonkCampaign(id: number, runAt: string): Promise<ListmonkCampaign> {
  if (!Number.isInteger(id) || id <= 0) throw new ListmonkConfigError("Invalid campaign id.");
  const when = new Date(runAt);
  if (!Number.isFinite(when.getTime())) throw new ListmonkConfigError("runAt must be a valid date/time.");
  if (when.getTime() <= Date.now()) throw new ListmonkConfigError("runAt must be in the future.");
  const raw = await listmonkFetch(`/api/campaigns/${id}/status`, {
    method: "PUT",
    body: JSON.stringify({ status: "scheduled", run_at: when.toISOString() }),
  });
  return mapCampaign(unwrapOne<unknown>(raw));
}

export async function listmonkCampaignStats(id: number): Promise<ListmonkCampaignStats> {
  if (!Number.isInteger(id) || id <= 0) throw new ListmonkConfigError("Invalid campaign id.");
  const body = (await listmonkFetch(`/api/campaigns/${id}/report/summary`)) as Record<string, unknown>;
  const d = (body.data ?? body) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return { sent: n(d.sent), viewed: n(d.viewed), clicked: n(d.clicked), bounced: n(d.bounced) };
}
