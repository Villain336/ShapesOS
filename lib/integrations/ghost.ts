// Marketr — Phase 12 "embeds": Ghost Admin API publishing (MIT).
// BYO pattern: GHOST_URL + GHOST_ADMIN_API_KEY on the host, server-side
// only, never exposed to the browser. "Publish to Ghost" from the content
// engine posts a draft to the Ghost blog and stores the post id + status on
// the content item. No key → honest disabled state, never fake publishing.
//
// Ghost Admin API auth (verified pattern): the Admin API key is
// `{id}:{secret}`; requests carry a JWT signed with HS256 using the
// hex-decoded secret, `kid` = id, audience `/admin/`, 5-minute expiry.
// Implemented with node:crypto — no extra dependency.

import { sidecarEnv } from "./sidecar-tenancy";
import { createHmac } from "node:crypto";

export const GHOST_URL_ENV = "GHOST_URL";
export const GHOST_ADMIN_API_KEY_ENV = "GHOST_ADMIN_API_KEY";

export interface GhostStatus {
  configured: boolean;
  name: string;
}

export function ghostStatus(env: Record<string, string | undefined> = sidecarEnv("ghost")): GhostStatus {
  const configured = !!(env[GHOST_URL_ENV] && env[GHOST_ADMIN_API_KEY_ENV]);
  return { configured, name: "ghost" };
}

function baseUrl(env: Record<string, string | undefined>): string {
  const url = env[GHOST_URL_ENV];
  if (!url) throw new GhostApiError(0, "Ghost is not configured (GHOST_URL).");
  return url.replace(/\/+$/, "");
}

function adminKeyParts(env: Record<string, string | undefined>): { id: string; secret: string } {
  const key = env[GHOST_ADMIN_API_KEY_ENV];
  if (!key) throw new GhostApiError(0, "Ghost is not configured (GHOST_ADMIN_API_KEY).");
  const [id, secret] = key.split(":");
  if (!id || !secret) {
    throw new GhostApiError(0, "GHOST_ADMIN_API_KEY must look like {id}:{secret}.");
  }
  return { id, secret };
}

export class GhostApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GhostApiError";
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build the Admin API JWT. `nowMs` is injectable for tests. */
export function buildGhostJwt(
  id: string,
  secretHex: string,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id }));
  const payload = base64url(
    JSON.stringify({ iat, exp: iat + 5 * 60, aud: "/admin/" }),
  );
  const signature = base64url(
    createHmac("sha256", Buffer.from(secretHex, "hex")).update(
      `${header}.${payload}`,
    ).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

type FetchImpl = typeof fetch;

async function ghostFetch(
  path: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
  env: Record<string, string | undefined>,
): Promise<unknown> {
  const { id, secret } = adminKeyParts(env);
  const token = buildGhostJwt(id, secret);
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl(env)}/ghost/api/admin${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Ghost ${token}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new GhostApiError(0, "Could not reach the Ghost blog.");
  }
  const json = (await res.json().catch(() => null)) as {
    errors?: Array<{ message?: string }>;
  } | null;
  if (!res.ok) {
    const msg =
      json?.errors?.[0]?.message ?? `Ghost request failed with HTTP ${res.status}.`;
    throw new GhostApiError(res.status, msg);
  }
  return json;
}

export interface GhostPostInput {
  title: string;
  /** HTML body. */
  html: string;
  /** "draft" (default) or "published". */
  status?: "draft" | "published";
  tags?: string[];
}

export interface GhostPost {
  id: string;
  title: string;
  status: string;
  url: string;
  updatedAt: string;
}

/** POST /posts — creates a post (draft unless status is published). */export async function createGhostPost(
  input: GhostPostInput,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("ghost"),
): Promise<GhostPost> {
  const json = (await ghostFetch(
    "/posts/?source=html",
    {
      method: "POST",
      body: JSON.stringify({
        posts: [
          {
            title: input.title,
            html: input.html,
            status: input.status ?? "draft",
            tags: (input.tags ?? []).map((name) => ({ name })),
          },
        ],
      }),
    },
    fetchImpl,
    env,
  )) as { posts?: Array<Record<string, unknown>> };
  const post = json.posts?.[0];
  if (!post || typeof post["id"] !== "string") {
    throw new GhostApiError(502, "Ghost returned no post id.");
  }
  return {
    id: post["id"] as string,
    title: String(post["title"] ?? ""),
    status: String(post["status"] ?? "draft"),
    url: String(post["url"] ?? ""),
    updatedAt: String(post["updated_at"] ?? ""),
  };
}

/** GET /posts/:id — reads back the live draft/published status. */
export async function getGhostPost(
  postId: string,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("ghost"),
): Promise<GhostPost> {
  const json = (await ghostFetch(
    `/posts/${encodeURIComponent(postId)}/`,
    { method: "GET" },
    fetchImpl,
    env,
  )) as { posts?: Array<Record<string, unknown>> };
  const post = json.posts?.[0];
  if (!post || typeof post["id"] !== "string") {
    throw new GhostApiError(404, "Ghost post not found.");
  }
  return {
    id: post["id"] as string,
    title: String(post["title"] ?? ""),
    status: String(post["status"] ?? "draft"),
    url: String(post["url"] ?? ""),
    updatedAt: String(post["updated_at"] ?? ""),
  };
}

/**
 * Minimal markdown → HTML for Ghost publishing. Escapes raw HTML first,
 * then handles headings, bold, italic, inline code, links, images,
 * unordered/ordered lists, blockquotes, and paragraphs. Deliberately small
 * — it is a transfer format for Ghost's `?source=html`, not a full
 * renderer. Exported for tests.
 */
export function markdownToHtml(markdown: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s: string): string => {
    let out = escape(s);
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return out;
  };

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    if (/^&gt;/.test(escape(trimmed))) {
      closeList();
      html.push(`<blockquote><p>${inline(trimmed.replace(/^>\s?/, ""))}</p></blockquote>`);
      continue;
    }
    const ulItem = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ulItem) {
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inline(ulItem[1]!)}</li>`);
      continue;
    }
    const olItem = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (olItem) {
      if (list !== "ol") {
        closeList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inline(olItem[1]!)}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inline(trimmed)}</p>`);
  }
  closeList();
  return html.join("\n");
}
