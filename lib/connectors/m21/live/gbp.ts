// ShapesOS — Phase 4b live Google Business Profile client.
//
// The Business Profile APIs are split across hosts (verified 2026-10
// against developers.google.com/my-business):
//   Account Management v1:  GET  https://mybusinessaccountmanagement.googleapis.com/v1/accounts
//   Business Information v1:
//     GET   https://mybusinessbusinessinformation.googleapis.com/v1/accounts/{a}/locations?readMask=…
//     PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/{l}?updateMask=…
//     PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/{l}/attributes?attributeMask=…
//   My Business v4 (reviews, local posts, media):
//     GET  https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews
//     GET  https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews/{r}
//     PUT  https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews/{r}/reply
//     POST https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/localPosts
//     POST https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/media
// Scope: business.manage (the only GBP scope). API access needs Google's
// application approval (0 QPM until approved) — see GBP_APPLICATION_COPY.
//
// Every mutation reaching this file has already passed the approval gate
// (review_reply_post / listing_edit approvals, or the connector-tool
// confirmation gate). planGbpSync() is pure: it turns an approved payload
// into the exact provider calls and REJECTS unknown keys rather than
// silently dropping part of what was approved.

import { liveRequest, ConnectorApiError, type LiveDeps, type TokenSource } from "./http";

export const GBP_ACCOUNTS_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
export const GBP_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
export const GBP_V4_BASE = "https://mybusiness.googleapis.com/v4";
const PROVIDER = "Google Business Profile";
const LOCATION_READ_MASK = "name,title,storefrontAddress,websiteUri,phoneNumbers,categories,regularHours,metadata";

type Json = Record<string, unknown>;

const bad = (msg: string) => new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: ${msg}`);

export interface LocationRef {
  accountId: string | null;
  locationId: string;
}

/** "accounts/{a}/locations/{l}" (preferred) or "locations/{l}" (v1-only calls). */
export function parseLocationRef(ref: unknown): LocationRef {
  const s = String(ref ?? "").trim();
  let m = /^accounts\/(\d{1,30})\/locations\/(\d{1,30})$/.exec(s);
  if (m) return { accountId: m[1], locationId: m[2] };
  m = /^locations\/(\d{1,30})$/.exec(s);
  if (m) return { accountId: null, locationId: m[1] };
  throw bad(`locationRef must look like accounts/{accountId}/locations/{locationId} (got "${s.slice(0, 60)}").`);
}

function v4Location(ref: LocationRef): string {
  if (!ref.accountId) {
    throw bad("this call needs the account too — use accounts/{accountId}/locations/{locationId}.");
  }
  return `${GBP_V4_BASE}/accounts/${ref.accountId}/locations/${ref.locationId}`;
}

export function normalizeReviewId(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(s)) throw bad("reviewId is not a valid review id.");
  return s;
}

// ---------------------------------------------------------------- reads

export async function gbpListAccounts(auth: TokenSource, deps: LiveDeps = {}) {
  const out: Array<{ name: string; accountName: string; type: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await liveRequest<{ accounts?: Json[]; nextPageToken?: string }>(
      { provider: PROVIDER, url: `${GBP_ACCOUNTS_BASE}/accounts`, query: { pageSize: 20, pageToken }, auth },
      deps,
    );
    for (const a of res.accounts ?? []) {
      out.push({ name: String(a.name ?? ""), accountName: String(a.accountName ?? ""), type: String(a.type ?? "") });
    }
    pageToken = res.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
}

export async function gbpListLocations(auth: TokenSource, accountId: string, deps: LiveDeps = {}) {
  if (!/^\d{1,30}$/.test(accountId)) throw bad("accountId must be numeric (accounts/{id} → id).");
  const out: Json[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await liveRequest<{ locations?: Json[]; nextPageToken?: string }>(
      {
        provider: PROVIDER,
        url: `${GBP_INFO_BASE}/accounts/${accountId}/locations`,
        query: { readMask: LOCATION_READ_MASK, pageSize: 100, pageToken },
        auth,
      },
      deps,
    );
    out.push(...(res.locations ?? []));
    pageToken = res.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out.map((l) => {
    const name = String(l.name ?? ""); // "locations/{id}"
    return {
      locationRef: `accounts/${accountId}/${name}`,
      title: String(l.title ?? ""),
      websiteUri: (l.websiteUri as string | undefined) ?? null,
      primaryPhone: ((l.phoneNumbers as Json | undefined)?.primaryPhone as string | undefined) ?? null,
      primaryCategory: (((l.categories as Json | undefined)?.primaryCategory as Json | undefined)?.displayName as string | undefined) ?? null,
    };
  });
}

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function shapeReview(r: Json) {
  const reply = r.reviewReply as Json | undefined;
  return {
    reviewId: String(r.reviewId ?? ""),
    reviewer: ((r.reviewer as Json | undefined)?.displayName as string | undefined) ?? null,
    rating: STARS[String(r.starRating ?? "")] ?? null,
    comment: (r.comment as string | undefined) ?? "",
    createTime: (r.createTime as string | undefined) ?? null,
    updateTime: (r.updateTime as string | undefined) ?? null,
    reply: reply
      ? {
          comment: (reply.comment as string | undefined) ?? "",
          updateTime: (reply.updateTime as string | undefined) ?? null,
          state: (reply.reviewReplyState as string | undefined) ?? null,
        }
      : null,
  };
}

export async function gbpListReviews(auth: TokenSource, locationRef: string, limit: number, deps: LiveDeps = {}) {
  const base = v4Location(parseLocationRef(locationRef));
  const reviews: Json[] = [];
  let pageToken: string | undefined;
  let summary: { averageRating: number | null; totalReviewCount: number | null } = { averageRating: null, totalReviewCount: null };
  for (let page = 0; page < 20 && reviews.length < limit; page++) {
    const res = await liveRequest<{ reviews?: Json[]; averageRating?: number; totalReviewCount?: number; nextPageToken?: string }>(
      {
        provider: PROVIDER,
        url: `${base}/reviews`,
        query: { pageSize: Math.min(50, limit - reviews.length), pageToken, orderBy: "updateTime desc" },
        auth,
      },
      deps,
    );
    if (page === 0) summary = { averageRating: res.averageRating ?? null, totalReviewCount: res.totalReviewCount ?? null };
    reviews.push(...(res.reviews ?? []));
    pageToken = res.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return { locationRef, ...summary, reviews: reviews.slice(0, limit).map(shapeReview) };
}

export async function gbpGetReview(auth: TokenSource, locationRef: string, reviewId: string, deps: LiveDeps = {}) {
  const base = v4Location(parseLocationRef(locationRef));
  const r = await liveRequest<Json>(
    { provider: PROVIDER, url: `${base}/reviews/${normalizeReviewId(reviewId)}`, auth },
    deps,
  );
  return shapeReview(r);
}

// ---------------------------------------------------------------- writes (approval-gated upstream)

/** Google caps a reply at 4096 bytes. */
export const GBP_REPLY_MAX_BYTES = 4096;

export async function gbpReplyToReview(
  auth: TokenSource,
  locationRef: string,
  reviewId: string,
  comment: string,
  deps: LiveDeps = {},
) {
  const text = comment.trim();
  if (!text) throw bad("reply text is empty.");
  if (Buffer.byteLength(text, "utf8") > GBP_REPLY_MAX_BYTES) throw bad("reply exceeds 4096 bytes.");
  const base = v4Location(parseLocationRef(locationRef));
  const res = await liveRequest<Json>(
    {
      provider: PROVIDER,
      method: "PUT",
      url: `${base}/reviews/${normalizeReviewId(reviewId)}/reply`,
      json: { comment: text },
      auth,
    },
    deps,
  );
  return {
    reviewId,
    state: (res?.reviewReplyState as string | undefined) ?? null,
    updateTime: (res?.updateTime as string | undefined) ?? null,
  };
}

export interface GbpPostInput {
  topicType: "update" | "offer" | "event" | "standard";
  title?: string;
  summary: string;
  actionUrl?: string | null;
  actionType?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  recurring?: boolean | null;
  recurrence?: unknown;
}

function gDate(iso: string, field: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw bad(`${field} must be YYYY-MM-DD.`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

const CTA = new Set(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);

/** Map an approved post payload to a v4 LocalPost body. Pure. */
export function buildLocalPost(p: GbpPostInput): Json {
  if (p.recurring || p.recurrence) {
    // Recurring posts use a newer recurrence surface we have not verified
    // against a live account; fail closed instead of posting a one-off.
    throw bad("recurring local posts are not supported by the live adapter yet — post a single occurrence.");
  }
  const summary = (p.summary ?? "").trim();
  if (!summary) throw bad("a local post needs a summary.");
  if (summary.length > 1500) throw bad("local post summary exceeds 1500 characters.");
  const topic = p.topicType === "update" || p.topicType === "standard" ? "STANDARD" : p.topicType.toUpperCase();
  if (!["STANDARD", "OFFER", "EVENT"].includes(topic)) throw bad(`unsupported topicType "${p.topicType}".`);
  const body: Json = { languageCode: "en", summary, topicType: topic };
  if (p.actionUrl) {
    if (!/^https:\/\/[^\s]+$/i.test(p.actionUrl)) throw bad("actionUrl must be an https URL.");
    const actionType = (p.actionType ?? "LEARN_MORE").toUpperCase();
    if (!CTA.has(actionType)) throw bad(`unsupported actionType "${actionType}".`);
    body.callToAction = { actionType, url: p.actionUrl };
  }
  if (topic === "EVENT" || topic === "OFFER") {
    const title = (p.title ?? "").trim();
    if (!title) throw bad(`${topic.toLowerCase()} posts need a title.`);
    if (!p.startDate || !p.endDate) throw bad(`${topic.toLowerCase()} posts need startDate and endDate.`);
    body.event = { title, schedule: { startDate: gDate(p.startDate, "startDate"), endDate: gDate(p.endDate, "endDate") } };
  }
  return body;
}

export async function gbpCreatePost(auth: TokenSource, locationRef: string, post: GbpPostInput, deps: LiveDeps = {}) {
  const base = v4Location(parseLocationRef(locationRef));
  const res = await liveRequest<Json>(
    { provider: PROVIDER, method: "POST", url: `${base}/localPosts`, json: buildLocalPost(post), auth },
    deps,
  );
  return { name: (res?.name as string | undefined) ?? null, state: (res?.state as string | undefined) ?? null, searchUrl: (res?.searchUrl as string | undefined) ?? null };
}

// ---------------------------------------------------------------- profile sync plan

export type GbpSyncOp =
  | { kind: "patch_location"; updateMask: string[]; body: Json }
  | { kind: "patch_attributes"; attributeMask: string[]; body: Json }
  | { kind: "create_post"; body: Json }
  | { kind: "create_media"; body: Json };

function toCategory(c: unknown): { name: string } {
  const s = String(c ?? "").trim();
  const m = /^(?:categories\/)?(gcid:[a-z0-9_]+)$/i.exec(s);
  if (!m) throw bad(`category "${s.slice(0, 60)}" must be a GBP category id like gcid:dentist.`);
  return { name: `categories/${m[1]}` };
}

function hoursBody(h: unknown): Json {
  if (!h || typeof h !== "object") throw bad("hours must be an object.");
  const o = h as Json;
  if (Array.isArray(o.periods)) return { periods: o.periods };
  if (o.regularHours && typeof o.regularHours === "object" && Array.isArray((o.regularHours as Json).periods)) {
    return o.regularHours as Json;
  }
  throw bad("hours must carry GBP periods [{openDay, openTime, closeDay, closeTime}].");
}

const PAYLOAD_KEYS = new Set([
  "locationRef", "title", "name", "nap", "phone", "primaryPhone", "website", "websiteUri",
  "storefrontAddress", "address", "hours", "regularHours", "specialHours", "categories",
  "description", "profile", "attributes", "posts", "photos", "topicType", "summary",
  "actionUrl", "recurrence",
]);

/**
 * Pure: approved sync payload → ordered provider operations. Unknown keys
 * are rejected so nothing approved is silently dropped.
 */
export function planGbpSync(locationRef: string, payload: Json): GbpSyncOp[] {
  parseLocationRef(locationRef);
  const unknown = Object.keys(payload).filter((k) => !PAYLOAD_KEYS.has(k));
  if (unknown.length) throw bad(`unsupported profile fields: ${unknown.join(", ")}.`);

  const ops: GbpSyncOp[] = [];
  const loc: Json = {};
  const mask: string[] = [];
  const nap = (payload.nap && typeof payload.nap === "object" ? payload.nap : {}) as Json;
  const isPost = typeof payload.topicType === "string";

  const title = (!isPost ? payload.title : undefined) ?? payload.name ?? nap.name ?? nap.title;
  if (title !== undefined) {
    if (typeof title !== "string" || !title.trim()) throw bad("title must be a non-empty string.");
    loc.title = title.trim();
    mask.push("title");
  }
  const phone = payload.primaryPhone ?? payload.phone ?? nap.phone ?? nap.primaryPhone;
  if (phone !== undefined) {
    if (typeof phone !== "string" || !phone.trim()) throw bad("phone must be a non-empty string.");
    loc.phoneNumbers = { primaryPhone: phone.trim() };
    mask.push("phoneNumbers");
  }
  const website = payload.websiteUri ?? payload.website ?? nap.website ?? nap.websiteUri;
  if (website !== undefined) {
    if (typeof website !== "string" || !/^https?:\/\/[^\s]+$/i.test(website)) throw bad("website must be an http(s) URL.");
    loc.websiteUri = website;
    mask.push("websiteUri");
  }
  const address = payload.storefrontAddress ?? payload.address ?? nap.address ?? nap.storefrontAddress;
  if (address !== undefined) {
    if (!address || typeof address !== "object" || !Array.isArray((address as Json).addressLines)) {
      throw bad("address must be a GBP PostalAddress with addressLines.");
    }
    loc.storefrontAddress = address;
    mask.push("storefrontAddress");
  }
  const hours = payload.regularHours ?? payload.hours;
  if (hours !== undefined && hours !== null) {
    loc.regularHours = hoursBody(hours);
    mask.push("regularHours");
  }
  if (payload.specialHours !== undefined && payload.specialHours !== null) {
    const sh = payload.specialHours as Json;
    if (!sh || typeof sh !== "object" || !Array.isArray(sh.specialHourPeriods)) {
      throw bad("specialHours must carry specialHourPeriods.");
    }
    loc.specialHours = sh;
    mask.push("specialHours");
  }
  if (payload.categories !== undefined && payload.categories !== null) {
    if (!Array.isArray(payload.categories) || payload.categories.length === 0) throw bad("categories must be a non-empty list.");
    const [primary, ...rest] = payload.categories.map(toCategory);
    loc.categories = { primaryCategory: primary, additionalCategories: rest };
    mask.push("categories");
  }
  const description = payload.description ?? (payload.profile as Json | undefined)?.description;
  if (description !== undefined) {
    if (typeof description !== "string" || description.length > 750) throw bad("description must be a string of at most 750 characters.");
    loc.profile = { description };
    mask.push("profile");
  }
  if (mask.length) ops.push({ kind: "patch_location", updateMask: mask, body: loc });

  if (payload.attributes !== undefined && payload.attributes !== null) {
    const attrs = payload.attributes;
    let list: Array<{ name: string; values: unknown[] }>;
    if (Array.isArray(attrs)) {
      list = attrs.map((a) => {
        const o = a as Json;
        if (typeof o.name !== "string" || !Array.isArray(o.values)) throw bad("attributes entries need name + values.");
        return { name: o.name.startsWith("attributes/") ? o.name : `attributes/${o.name}`, values: o.values };
      });
    } else if (typeof attrs === "object") {
      list = Object.entries(attrs as Json).map(([k, v]) => ({
        name: k.startsWith("attributes/") ? k : `attributes/${k}`,
        values: Array.isArray(v) ? v : [v],
      }));
    } else {
      throw bad("attributes must be an object or a list.");
    }
    for (const a of list) {
      if (!/^attributes\/[a-z0-9_]+$/i.test(a.name)) throw bad(`invalid attribute name "${a.name}".`);
    }
    if (list.length) {
      ops.push({
        kind: "patch_attributes",
        attributeMask: list.map((a) => a.name),
        body: { attributes: list },
      });
    }
  }

  if (isPost) {
    ops.push({
      kind: "create_post",
      body: buildLocalPost({
        topicType: payload.topicType as GbpPostInput["topicType"],
        title: payload.title as string | undefined,
        summary: String(payload.summary ?? ""),
        actionUrl: (payload.actionUrl as string | null | undefined) ?? null,
        recurrence: payload.recurrence ?? null,
      }),
    });
  }
  if (payload.posts !== undefined && payload.posts !== null) {
    if (!Array.isArray(payload.posts)) throw bad("posts must be a list.");
    for (const raw of payload.posts) {
      const p = raw as Json;
      ops.push({
        kind: "create_post",
        body: buildLocalPost({
          topicType: (p.topic ?? p.topicType ?? "update") as GbpPostInput["topicType"],
          title: p.title as string | undefined,
          summary: String(p.body ?? p.summary ?? ""),
          actionUrl: (p.actionUrl as string | undefined) ?? null,
          startDate: (p.startDate as string | undefined) ?? null,
          endDate: (p.endDate as string | undefined) ?? null,
          recurring: (p.recurring as boolean | undefined) ?? null,
        }),
      });
    }
  }
  if (payload.photos !== undefined && payload.photos !== null) {
    if (!Array.isArray(payload.photos)) throw bad("photos must be a list of https URLs.");
    for (const url of payload.photos) {
      if (typeof url !== "string" || !/^https:\/\/[^\s]+$/i.test(url)) throw bad("photo URLs must be https.");
      ops.push({
        kind: "create_media",
        body: { mediaFormat: "PHOTO", locationAssociation: { category: "ADDITIONAL" }, sourceUrl: url },
      });
    }
  }
  if (ops.length === 0) throw bad("nothing to sync — the payload has no supported fields.");
  return ops;
}

/** Execute a sync plan in order; stops at the first failure. */
export async function gbpExecuteSync(auth: TokenSource, locationRef: string, ops: GbpSyncOp[], deps: LiveDeps = {}) {
  const ref = parseLocationRef(locationRef);
  const results: Array<{ kind: GbpSyncOp["kind"]; name: string | null }> = [];
  for (const op of ops) {
    let res: Json | null;
    switch (op.kind) {
      case "patch_location":
        res = await liveRequest<Json>(
          {
            provider: PROVIDER,
            method: "PATCH",
            url: `${GBP_INFO_BASE}/locations/${ref.locationId}`,
            query: { updateMask: op.updateMask.join(",") },
            json: op.body,
            auth,
          },
          deps,
        );
        break;
      case "patch_attributes":
        res = await liveRequest<Json>(
          {
            provider: PROVIDER,
            method: "PATCH",
            url: `${GBP_INFO_BASE}/locations/${ref.locationId}/attributes`,
            query: { attributeMask: op.attributeMask.join(",") },
            json: { name: `locations/${ref.locationId}/attributes`, ...op.body },
            auth,
          },
          deps,
        );
        break;
      case "create_post":
        res = await liveRequest<Json>({ provider: PROVIDER, method: "POST", url: `${v4Location(ref)}/localPosts`, json: op.body, auth }, deps);
        break;
      case "create_media":
        res = await liveRequest<Json>({ provider: PROVIDER, method: "POST", url: `${v4Location(ref)}/media`, json: op.body, auth }, deps);
        break;
    }
    results.push({ kind: op.kind, name: (res?.name as string | undefined) ?? null });
  }
  return results;
}

export async function gbpPing(auth: TokenSource, deps: LiveDeps = {}) {
  await liveRequest({ provider: PROVIDER, url: `${GBP_ACCOUNTS_BASE}/accounts`, query: { pageSize: 1 }, auth }, deps);
  return { reachable: true };
}
