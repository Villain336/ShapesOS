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

import { currentSidecarSource, sidecarEnv, sidecarRefusalMessage } from "./sidecar-tenancy";
export const POSTIZ_TIMEOUT_MS = 15_000;
export const PUBLIC_V1 = "/public/v1";

/** Honest unconfigured-key message. Names the env vars; never their values. */
export const POSTIZ_NOT_CONFIGURED_MESSAGE =
  "Postiz isn't connected. Set POSTIZ_URL and POSTIZ_API_KEY in Settings → Providers, then try again.";

export function getPostizConfig(): { url: string; apiKey: string } {
  // Phase 15.1: the workspace's own Postiz, else env — refused on hosted
  // (lib/integrations/sidecar-tenancy.ts).
  const env = sidecarEnv("postiz");
  return {
    url: (env.POSTIZ_URL ?? "").replace(/\/+$/, ""),
    apiKey: (env.POSTIZ_API_KEY ?? "").trim(),
  };
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function postizStatus() {
  const { url, apiKey } = getPostizConfig();
  const configured = url.length > 0 && apiKey.length > 0;
  return { name: "postiz", isLive: configured, configured };
}

function notConfigured(): never {
  throw new PostizConfigError(
    currentSidecarSource("postiz") === "refused" ? sidecarRefusalMessage("postiz") : POSTIZ_NOT_CONFIGURED_MESSAGE,
  );
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

async function postizFetch(
  path: string,
  opts: RequestInit = {},
  timeoutMs: number = POSTIZ_TIMEOUT_MS,
): Promise<unknown> {
  const { url, apiKey } = getPostizConfig();
  if (!url || !apiKey) notConfigured();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  // Multipart bodies set their own boundary Content-Type.
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  try {
    const res = await fetch(`${url}${PUBLIC_V1}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
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
  /** Remote media URLs (images/video) to attach. Each is uploaded to
      Postiz via upload-from-url first — Postiz requires its own hosted
      URLs in the post payload, and many platforms reject external links. */
  mediaUrls?: string[];
}

/** A Postiz-hosted media reference, as returned by the upload endpoints. */
export interface PostizMedia {
  id?: string;
  path: string;
}

/**
 * Upload a remote media URL to Postiz (Wave B: media passthrough).
 * Postiz requires media to be hosted by Postiz itself before it can be
 * attached to a post — external URLs are rejected by several platforms.
 * Returns the { id, path } reference for the post payload's image array.
 */
export async function uploadPostizMediaFromUrl(url: string): Promise<PostizMedia> {
  if (!url.trim()) throw new PostizConfigError("Media URL is required.");
  const body = (await postizFetch("/upload-from-url", {
    method: "POST",
    body: JSON.stringify({ url }),
  })) as Record<string, unknown> | null;
  const r = body ?? {};
  const data = (r.data as Record<string, unknown> | undefined) ?? {};
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const id = str(r.id) ?? str(data.id);
  const path = str(r.path) ?? str(data.path);
  if (!id && !path) {
    throw new PostizConfigError(`Postiz media upload failed for ${url}.`);
  }
  return { ...(id ? { id } : {}), path: path ?? (id as string) };
}

function defaultSettingsFor(identifier: string): Record<string, unknown> {
  return { __type: identifier || "x" };
}

export function buildPostizPayload(
  input: SchedulePostInput & { images?: PostizMedia[] },
): Record<string, unknown> {
  const content = input.content.trim();
  if (!content) throw new PostizConfigError("Post content is required.");
  if (!input.channelIds.length) throw new PostizConfigError("At least one channel is required.");
  const images = (input.images ?? []).map((m) => ({ ...(m.id ? { id: m.id } : {}), path: m.path }));
  const payload: Record<string, unknown> = {
    type: input.type,
    shortLink: false,
    tags: [],
    posts: input.channelIds.map((channelId) => ({
      integration: { id: channelId },
      value: [{ content, image: images }],
      settings: defaultSettingsFor(input.platformTypes?.[channelId] ?? ""),
    })),
  };
  if (input.type === "schedule") {
    if (!input.date) throw new PostizConfigError("A date is required to schedule a post.");
    const when = new Date(input.date);
    if (!Number.isFinite(when.getTime())) throw new PostizConfigError("date must be a valid date/time.");
    if (when.getTime() <= Date.now()) throw new PostizConfigError("Scheduled date must be in the future.");
    payload.date = when.toISOString();
  } else {
    // The create-post docs list `date` as required for every type; "now"
    // and "draft" carry the current time.
    payload.date = new Date().toISOString();
  }
  return payload;
}

export async function schedulePostizPost(input: SchedulePostInput): Promise<unknown> {
  // Upload media first: Postiz requires its own hosted URLs in the payload.
  // Sequential (not parallel) so a failure names the offending URL.
  const images: PostizMedia[] = [];
  for (const url of input.mediaUrls ?? []) {
    images.push(await uploadPostizMediaFromUrl(url));
  }
  const payload = buildPostizPayload({ ...input, images });
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

// ── Draft-first queue (Wave B) ─────────────────────────────────────────
// Shared by the ads + studio "send to social" flows. The post TYPE is
// hardcoded to "draft" here — the only draft path outside the clipper's
// own chokepoint. Publishing happens only when a human approves the draft
// in Postiz (or the Social tab). No caller can smuggle "now"/"schedule"
// through this helper: the PostizPostType union is not a parameter.

export interface QueuedPostizDraft {
  /** Postiz draft id (whatever the sidecar returned), for deep-linking. */
  postizRef: string;
  raw: unknown;
}

export async function queuePostizDraft(input: {
  content: string;
  channelIds: string[];
  platformTypes?: Record<string, string>;
  /** Remote media URLs to upload + attach (ad creatives, studio assets). */
  mediaUrls?: string[];
}): Promise<QueuedPostizDraft> {
  const raw = await schedulePostizPost({
    type: "draft",
    content: input.content,
    channelIds: input.channelIds,
    platformTypes: input.platformTypes,
    mediaUrls: input.mediaUrls,
  });
  const r = raw as Record<string, unknown> | null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const postizRef =
    parseCreatedPosts(raw)[0]?.postId ??
    str(r?.id) ??
    str((r?.data as Record<string, unknown> | undefined)?.id) ??
    "draft";
  return { postizRef, raw };
}

// ── Phase 4b: media upload, created-post refs, post states, analytics ──
// Verified 2026-10-03 against docs.postiz.com/public-api:
//   POST /public/v1/upload (multipart, field "file"; images + MP4 only)
//     → { id, name, path, organizationId, createdAt, updatedAt }
//   POST /public/v1/posts → [ { postId, integration } ] (one per channel)
//   GET  /public/v1/posts?startDate=&endDate= (ISO, UTC)
//     → { posts: [ { id, content, publishDate, releaseURL,
//                    state: QUEUE|PUBLISHED|ERROR|DRAFT,
//                    integration: { id, providerIdentifier, name } } ] }
//   GET  /public/v1/analytics/post/{postId}?date=<days>
//     → [ { label, data: [ { total, date } ], percentageChange } ]

/** Uploads can be large (video); give them longer than a JSON call. */
export const POSTIZ_UPLOAD_TIMEOUT_MS = 120_000;

/** Upload raw bytes to Postiz (multipart) and return its hosted reference. */
export async function uploadPostizFile(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<PostizMedia> {
  if (!bytes.length) throw new PostizConfigError("Media file is empty.");
  const form = new FormData();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.append("file", new Blob([copy.buffer], { type: mimeType }), filename);
  const body = (await postizFetch("/upload", { method: "POST", body: form }, POSTIZ_UPLOAD_TIMEOUT_MS)) as
    | Record<string, unknown>
    | null;
  const r = body ?? {};
  const id = typeof r.id === "string" && r.id ? r.id : undefined;
  const path = typeof r.path === "string" && r.path ? r.path : undefined;
  if (!path) throw new PostizApiError(502, "Postiz upload returned no media path.", null);
  return { ...(id ? { id } : {}), path };
}

export interface PostizCreatedPost {
  postId: string;
  integrationId: string | null;
}

/** Parse the create-post response ([{ postId, integration }]). */
export function parseCreatedPosts(raw: unknown): PostizCreatedPost[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).data)
      ? ((raw as Record<string, unknown>).data as unknown[])
      : [];
  const out: PostizCreatedPost[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const postId = typeof r.postId === "string" ? r.postId : typeof r.id === "string" ? r.id : "";
    if (!postId) continue;
    const integ = r.integration;
    const integrationId =
      typeof integ === "string"
        ? integ
        : integ && typeof integ === "object" && typeof (integ as Record<string, unknown>).id === "string"
          ? ((integ as Record<string, unknown>).id as string)
          : null;
    out.push({ postId, integrationId });
  }
  return out;
}

/** Create posts from a prebuilt payload; returns one ref per channel. */
export async function createPostizPosts(payload: Record<string, unknown>): Promise<PostizCreatedPost[]> {
  const raw = await postizFetch("/posts", { method: "POST", body: JSON.stringify(payload) });
  return parseCreatedPosts(raw);
}

export type PostizPostState = "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT" | "UNKNOWN";

export interface PostizPostStatus {
  id: string;
  state: PostizPostState;
  publishDate: string | null;
  releaseUrl: string | null;
  integrationId: string | null;
  providerIdentifier: string | null;
}

export function mapPostStatus(raw: unknown): PostizPostStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const integ = (r.integration ?? {}) as Record<string, unknown>;
  const st = String(r.state ?? "").toUpperCase();
  const state: PostizPostState =
    st === "QUEUE" || st === "PUBLISHED" || st === "ERROR" || st === "DRAFT" ? st : "UNKNOWN";
  return {
    id: String(r.id ?? ""),
    state,
    publishDate: typeof r.publishDate === "string" ? r.publishDate : null,
    releaseUrl: typeof r.releaseURL === "string" && r.releaseURL ? r.releaseURL : null,
    integrationId: typeof integ.id === "string" ? integ.id : null,
    providerIdentifier: typeof integ.providerIdentifier === "string" ? integ.providerIdentifier : null,
  };
}

/** Post states in a window (documented startDate/endDate parameters). */
export async function listPostizPostStatuses(startDate: Date, endDate: Date): Promise<PostizPostStatus[]> {
  const sp = new URLSearchParams({ startDate: startDate.toISOString(), endDate: endDate.toISOString() });
  const body = (await postizFetch(`/posts?${sp.toString()}`)) as unknown;
  const arr = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).posts)
      ? ((body as Record<string, unknown>).posts as unknown[])
      : [];
  return arr.map(mapPostStatus).filter((p) => p.id.length > 0);
}

export interface PostizMetricSeries {
  label: string;
  data: Array<{ date: string; total: number }>;
}

export function parseAnalytics(raw: unknown): PostizMetricSeries[] {
  if (!Array.isArray(raw)) return [];
  const out: PostizMetricSeries[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    if (typeof r.label !== "string" || !Array.isArray(r.data)) continue;
    const data: PostizMetricSeries["data"] = [];
    for (const d of r.data) {
      if (!d || typeof d !== "object") continue;
      const dr = d as Record<string, unknown>;
      const total = Number(dr.total);
      if (typeof dr.date !== "string" || !Number.isFinite(total)) continue;
      data.push({ date: dr.date.slice(0, 10), total: Math.max(0, Math.round(total)) });
    }
    out.push({ label: r.label, data });
  }
  return out;
}

/** Daily metric series for one published post over the last `days` days. */
export async function getPostizPostAnalytics(postId: string, days: number): Promise<PostizMetricSeries[]> {
  if (!postId.trim()) throw new PostizConfigError("Post id is required.");
  const d = Math.min(Math.max(Math.round(days), 1), 90);
  const body = await postizFetch(`/analytics/post/${encodeURIComponent(postId)}?date=${d}`);
  return parseAnalytics(body);
}
