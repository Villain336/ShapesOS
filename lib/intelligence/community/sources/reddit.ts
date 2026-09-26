// Marketr — Phase 10 M8: Reddit opportunity adapter.
//
// OFFICIAL API ONLY, with the USER'S OWN OAuth credentials. This module
// never scrapes Reddit (SPEC-PHASE10 §2 🚫 — "Scraping Reddit … Terms of
// Service just got teeth" after Reddit v. Anthropic, Sept 2026), and
// Marketr never proxies Reddit at platform scale.
//
// Legal/ops notes (also in README.md):
//   - Reddit's public API access wound down Sept 30, 2026; reported
//     commercial pricing is ~$12K/mo [UNVERIFIED]. A platform-scale proxy
//     inside Marketr would be a commercial/ToS violation — so every call
//     here carries the user's own script-app credentials, for that user's
//     workspace only.
//   - Read-only scopes suffice (read). Nothing here posts, votes, or
//     messages — see the no-autopost invariant in __tests__.
//   - When no credentials are configured the adapter returns
//     { configured: false } and the scanner skips Reddit gracefully.

import type { RawThread, RedditConfig } from "../types";

export interface RedditSearchOptions {
  fetchImpl?: typeof fetch;
  limit?: number;
}

export interface RedditSearchResult {
  configured: boolean;
  /** Why Reddit was skipped (unconfigured or error). */
  detail: string;
  opportunities: RawThread[];
}

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const OAUTH_BASE = "https://oauth.reddit.com";

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        id?: string;
        name?: string;
        title?: string;
        selftext?: string;
        permalink?: string;
        url?: string;
        author?: string;
        score?: number;
        num_comments?: number;
        created_utc?: number;
        subreddit?: string;
      };
    }>;
  };
}

function basicAuth(config: RedditConfig): string {
  return (
    "Basic " +
    Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")
  );
}

/** Exchange the user's refresh token for a short-lived bearer token. */
async function bearerToken(
  config: RedditConfig,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": `Marketr-M8/1.0 by /u/${config.username}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
    }).toString(),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string };
  return typeof body.access_token === "string" ? body.access_token : null;
}

/**
 * Search Reddit posts via the official OAuth search endpoint using the
 * user's own credentials. Returns configured=false (no throw) when the
 * config is absent or any step fails — the scanner treats Reddit as
 * optional.
 */
export async function searchReddit(
  config: RedditConfig | null | undefined,
  query: string,
  opts: RedditSearchOptions = {},
): Promise<RedditSearchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (
    !config ||
    !config.clientId ||
    !config.clientSecret ||
    !config.refreshToken ||
    !config.username
  ) {
    return {
      configured: false,
      detail: "unconfigured — connect your own Reddit app (OAuth) to enable Reddit opportunities",
      opportunities: [],
    };
  }
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  try {
    const token = await bearerToken(config, fetchImpl);
    if (!token) {
      return { configured: false, detail: "token exchange failed — check Reddit app credentials", opportunities: [] };
    }
    const url =
      `${OAUTH_BASE}/search.json?q=${encodeURIComponent(query)}` +
      `&limit=${limit}&sort=new&type=link&restrict_sr=false`;
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": `Marketr-M8/1.0 by /u/${config.username}`,
      },
    });
    if (!res.ok) {
      return { configured: true, detail: `search HTTP ${res.status}`, opportunities: [] };
    }
    const body = (await res.json()) as RedditListing;
    const children = body?.data?.children ?? [];
    const opportunities: RawThread[] = [];
    for (const child of children) {
      const d = child?.data;
      if (!d || !d.id || !d.title) continue;
      const createdAt = d.created_utc ? new Date(d.created_utc * 1000) : new Date();
      opportunities.push({
        source: "reddit",
        externalId: d.name ?? `t3_${d.id}`,
        title: d.title.slice(0, 300),
        url: d.permalink
          ? `https://www.reddit.com${d.permalink}`
          : (d.url ?? "https://www.reddit.com"),
        author: d.author,
        text: (d.selftext ?? "").slice(0, 4000),
        points: typeof d.score === "number" ? d.score : undefined,
        commentCount: typeof d.num_comments === "number" ? d.num_comments : undefined,
        createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
        feedName: d.subreddit ? `r/${d.subreddit}` : undefined,
      });
    }
    return { configured: true, detail: "ok", opportunities };
  } catch (e) {
    return {
      configured: true,
      detail: `error: ${(e as Error).message}`,
      opportunities: [],
    };
  }
}

/** No part of M8 posts/votes/messages. Kept as a named export so the
 *  no-autopost invariant test can reference the adapter's declared scope. */
export const REDDIT_READ_ONLY_SCOPES = Object.freeze(["read"]) as readonly string[];
