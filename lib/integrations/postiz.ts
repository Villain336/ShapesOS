// Marketr — Phase 12: Postiz social-publishing sidecar client.
//
// BYO-key pattern (same as lib/design/unsplash.ts and brandfetch.ts):
//   POSTIZ_URL, POSTIZ_API_KEY live on the host environment, are read
//   server-side only, and never reach the browser. No key → loud honest
//   error, never fabricated channels/posts.
//
// SIDECAR CONTRACT — READ THIS. Postiz is AGPL-3.0 (self-host, ~30
// channels behind one OAuth surface, built-in MCP). It is a separate
// process — talked to ONLY over raw fetch against its PUBLIC REST API
// (<host>/public/v1). NEVER `npm i` or import the AGPL `@postiz/node`
// SDK — linking it into Marketr's process would pull Marketr into
// AGPL copyleft territory. Raw fetch only. (integration-survey.md §Tier
// 1 #3, and its Public API docs.)
//
// API shape (verified 2026-09-27 from Postiz public-API docs):
//   Auth: `Authorization: <api-key>` header — no Bearer prefix.
//   GET    /public/v1/is-connected → verify key
//   GET    /public/v1/integrations → connected channels (integration ids)
//   POST   /public/v1/posts → { type: "now"|"schedule"|"draft",
//              date?, shortLink?, tags?, posts: [ { integration: { id },
//              value: [ { content, image: [] } ], settings?: { __type } } ] }
//   GET    /public/v1/posts?from=&to= → scheduled posts
//   DELETE /public/v1/posts/{id}

export const POSTIZ_TIMEOUT_MS = 15_000;
export const PUBLIC_V1 = "/public/v1";

/** Honest unconfigured-key message. Names the env vars; never their values. */
export const POSTIZ_NOT_CONFIGURED_MESSAGE =
  "Postiz isn't connected. Set POSTIZ_URL and POSTIZ_API_KEY in Settings → Providers, then try again.";

export function getPostizConfig(): { url: string; apiKey: string } {
  return {
    url: (process.env.POSTIZ_URL ?? "").replace(/\/+$/, ""),
    apiKey: (process.env.POSTIZ_API_KEY ?? "").trim(),
  };
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function postizStatus() {
  const { url, apiKey } = getPostizConfig();
  const configured = url.length > 0 && apiKey.length > 0;
  return { name: "postiz", isLive: configured, configured };
}

function notConfigured(): never {
  throw new PostizConfigError(POSTIZ_NOT_CONFIGURED_MESSAGE);
}

// ── Errors ─────────────────────────────────────────────────────────────

/** 400-class local failure (missing key, bad input). Routes map it to JSON. */
export class PostizConfigError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PostizConfigError";
  }
}

/** A Postiz HTTP response that was not 2xx. Never carries credentials. */
export class PostizApiError extends Error {
  readonly status: number;
  readonly postizBody: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "PostizApiError";
    this.status = status;
    this.postizBody = body;
  }
}

// ── Trimmed shapes (client-safe: no key material, no vendor internals) ──

export interface PostizChannel {
  /** Postiz integration id — used as the target in schedule calls. */
  id: string;
  /** Channel platform identifier (e.g. "x", "linkedin", "instagram"). */
  identifier: string;
  name: string | null;
  picture: string | null;
  connectedAt: string | null;
}

export interface PostizPost {
  id: string;
  type: string;
  date: string | null;
  content: string | null;
  channels: string[];
  createdAt: string | null;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────

async function postizFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const { url, apiKey } = getPostizConfig();
  if (!url || !apiKey) notConfigured();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POSTIZ_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${PUBLIC_V1}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        // Postiz public API: raw API key in the Authorization header —
        // no "Bearer" prefix (per its docs).
        Authorization: apiKey,
        ...(opts.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const msg =
        body && typeof body === "object" && "message" in body
          ? String((body as { message: unknown }).message)
          : `Postiz request failed (${res.status})`;
      throw new PostizApiError(res.status, msg, body);
    }
    return body;
  } catch (e) {
    if (e instanceof PostizApiError || e instanceof PostizConfigError) throw e;
    throw new PostizApiError(502, `Postiz unreachable: ${e instanceof Error ? e.message : "network error"}`, null);
  } finally {
    clearTimeout(t);
  }
}

// ── Channels ───────────────────────────────────────────────────────────

export function mapChannel(raw: unknown): PostizChannel {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    identifier: String(r.identifier ?? r.platform ?? ""),
    name: typeof r.name === "string" ? r.name : null,
    picture: typeof r.picture === "string" ? r.picture : null,
    connectedAt: typeof r.connectedAt === "string" ? r.connectedAt : null,
  };
}

export async function verifyPostizKey(): Promise<boolean> {
  try {
    await postizFetch("/is-connected");
    return true;
  } catch {
    return false;
  }
}

export async function listPostizChannels(): Promise<PostizChannel[]> {
  const body = (await postizFetch("/integrations")) as Array<unknown> | Record<string, unknown>;
  const arr = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as Array<unknown>)
      : [];
  return arr.map(mapChannel).filter((c) => c.id.length > 0);
}

// ── Posts ──────────────────────────────────────────────────────────────

export type PostizPostType = "now" | "schedule" | "draft";

export interface SchedulePostInput {
  type: PostizPostType;
  /** ISO 8601; required for "schedule". Never in the past. */
  date?: string;
  content: string;
  /** Postiz integration ids to publish to. */
  channelIds: string[];
  /** Postiz settings __type per platform (e.g. "x", "linkedin"). When
      omitted, the first channel's identifier is used for all. */
  platformTypes?: Record<string, string>;
}

function defaultSettingsFor(identifier: string): Record<string, unknown> {
  return { __type: identifier || "x" };
}

export function buildPostizPayload(input: SchedulePostInput): Record<string, unknown> {
  const content = input.content.trim();
  if (!content) throw new PostizConfigError("Post content is required.");
  if (!input.channelIds.length) throw new PostizConfigError("At least one channel is required.");
  const payload: Record<string, unknown> = {
    type: input.type,
    shortLink: false,
    tags: [],
    posts: input.channelIds.map((channelId) => ({
      integration: { id: channelId },
      value: [{ content, image: [] }],
      settings: defaultSettingsFor(input.platformTypes?.[channelId] ?? ""),
    })),
  };
  if (input.type === "schedule") {
    if (!input.date) throw new PostizConfigError("A date is required to schedule a post.");
    const when = new Date(input.date);
    if (!Number.isFinite(when.getTime())) throw new PostizConfigError("date must be a valid date/time.");
    if (when.getTime() <= Date.now()) throw new PostizConfigError("Scheduled date must be in the future.");
    payload.date = when.toISOString();
  }
  return payload;
}

export async function schedulePostizPost(input: SchedulePostInput): Promise<unknown> {
  const payload = buildPostizPayload(input);
  return postizFetch("/posts", { method: "POST", body: JSON.stringify(payload) });
}

export function mapPost(raw: unknown): PostizPost {
  const r = raw as Record<string, unknown>;
  const posts = Array.isArray(r.posts) ? r.posts : [];
  const contents = posts.flatMap((p) => {
    const pr = p as Record<string, unknown>;
    const vals = Array.isArray(pr.value) ? pr.value : [];
    return vals.map((v) => String((v as Record<string, unknown>).content ?? ""));
  });
  const channels = posts.map((p) => String(((p as Record<string, unknown>).settings as Record<string, unknown> | undefined)?.__type ?? "")).filter(Boolean);
  return {
    id: String(r.id ?? ""),
    type: String(r.type ?? ""),
    date: typeof r.date === "string" ? r.date : null,
    content: contents[0] ?? null,
    channels,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
  };
}

export async function listPostizPosts(opts: { from?: string; to?: string } = {}): Promise<PostizPost[]> {
  const sp = new URLSearchParams();
  if (opts.from) sp.set("from", opts.from);
  if (opts.to) sp.set("to", opts.to);
  const qs = sp.toString();
  const body = (await postizFetch(qs ? `/posts?${qs}` : "/posts")) as Array<unknown> | Record<string, unknown>;
  const arr = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown>).data)
      ? ((body as Record<string, unknown>).data as Array<unknown>)
      : [];
  return arr.map(mapPost).filter((p) => p.id.length > 0);
}

export async function deletePostizPost(id: string): Promise<void> {
  if (!id.trim()) throw new PostizConfigError("Post id is required.");
  await postizFetch(`/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
}
