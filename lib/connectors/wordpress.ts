// Marketr — WordPress content connector (milestone 8, live implementation).
//
// Auth: WordPress Application Passwords (Users → Profile → Application
// Passwords). HTTP Basic auth `username:appPassword`, encrypted at rest with
// the milestone-6 crypto helper — decrypted server-side only, never sent to
// the client.
//
// Scope (honest): the WP REST API exposes CONTENT — pages, posts, and the
// media library. It cannot edit theme or plugin files, menus/widgets beyond
// basic endpoints, or server configuration. The UI must label this as
// content-level access. Untested against a live WP site from this sandbox
// (egress blocked); the mock in ./mock-wordpress.ts covers the full flow.

import type {
  ContentConnector,
  ContentDetail,
  ContentItem,
  ContentKind,
  SaveContentInput,
  WordPressConfig,
} from "./types";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/safe-url";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch";

const MAX_READ = 2_000_000;

interface WpRendered {
  rendered: string;
}
interface WpPost {
  id: number;
  slug: string;
  status: string;
  modified: string | null;
  link?: string;
  title?: WpRendered;
  content?: WpRendered;
}

interface WpMedia {
  id: number;
  slug: string;
  source_url?: string;
  modified: string | null;
  mime_type?: string;
}

function authHeader(cfg: WordPressConfig): string {
  const pair = `${cfg.username}:${cfg.appPassword}`;
  return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
}

export class WordPressConnector implements ContentConnector {
  readonly kind = "wordpress" as const;
  readonly name = "wordpress";
  readonly isLive = true;

  constructor(
    private cfg: WordPressConfig,
    private deps: SafeFetchOptions = {},
  ) {}

  /**
   * Validated factory (day-1 hardening, M6): the baseUrl is SSRF-checked
   * (scheme, no embedded credentials, no loopback/private/link-local/
   * metadata destinations) before any request is made. Prefer this over the
   * raw constructor for any operator-supplied config.
   */
  static async create(
    cfg: WordPressConfig,
    deps: SafeFetchOptions = {},
  ): Promise<WordPressConnector> {
    const baseUrl = await assertSafeUrl(cfg.baseUrl, { resolve: deps.resolve });
    return new WordPressConnector({ ...cfg, baseUrl }, deps);
  }

  private get base(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  /**
   * The single request path for every WordPress operation (day-1, M6).
   * safeFetch re-validates the URL on every request (per-request DNS, so a
   * rebinding hostname is caught on the next call) and re-validates every
   * redirect hop manually — native fetch's automatic redirect following
   * would otherwise let a server bounce the request to an internal address.
   * UnsafeUrlError propagates typed so callers can distinguish an SSRF block
   * (bad config → 400) from a network failure (→ 502).
   */
  private async wp(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await safeFetch(
        `${this.base}/wp-json${path}`,
        {
          ...init,
          headers: {
            Authorization: authHeader(this.cfg),
            Accept: "application/json",
            ...(init?.headers ?? {}),
          },
        },
        this.deps,
      );
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw err;
      throw new Error(
        `WordPress request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async wpJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.wp(path, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WordPress API error ${res.status}: ${text.slice(0, 300) || res.statusText}`,
      );
    }
    return (await res.json()) as T;
  }

  async test(): Promise<{ ok: boolean; info: string }> {
    const info = await this.wpJson<{ name?: string; description?: string }>(
      "/",
    );
    const name = info.name ?? this.cfg.baseUrl;
    return { ok: true, info: `Connected to “${name}” (${this.base})` };
  }

  private restKind(kind: ContentKind): "pages" | "posts" {
    if (kind === "page") return "pages";
    if (kind === "post") return "posts";
    throw new Error(`WordPress has no content kind "${kind}"`);
  }

  private toItem(kind: ContentKind, p: WpPost): ContentItem {
    return {
      id: String(p.id),
      kind,
      title: p.title?.rendered?.replace(/<[^>]+>/g, "") ?? `(untitled ${kind})`,
      slug: p.slug,
      status: p.status,
      link: p.link ?? null,
      updatedAt: p.modified ?? null,
    };
  }

  async listContent(kind: ContentKind): Promise<ContentItem[]> {
    const posts = await this.wpJson<WpPost[]>(
      `/wp/v2/${this.restKind(kind)}?per_page=100&_fields=id,title,slug,status,modified,link`,
    );
    return posts.map((p) => this.toItem(kind, p));
  }

  async getContent(kind: ContentKind, id: string): Promise<ContentDetail> {
    const p = await this.wpJson<WpPost>(
      `/wp/v2/${this.restKind(kind)}/${encodeURIComponent(id)}?_fields=id,title,slug,status,modified,link,content`,
    );
    return { ...this.toItem(kind, p), content: p.content?.rendered ?? "" };
  }

  async saveContent(kind: ContentKind, input: SaveContentInput): Promise<ContentDetail> {
    const rest = this.restKind(kind);
    // Day-1 (#15): fail closed instead of silently truncating — posting a
    // silently-cut article is data loss the user can't see.
    if (input.content.length > MAX_READ) {
      throw new Error(
        `Content is ${(input.content.length / 1_000_000).toFixed(1)}MB; ` +
        `WordPress connector limit is ${MAX_READ / 1_000_000}MB. Shorten the content and retry.`,
      );
    }
    const body: Record<string, unknown> = {
      title: input.title,
      content: input.content,
      status: input.status,
    };
    if (input.slug?.trim()) body.slug = input.slug.trim();
    const method = input.id ? "PUT" : "POST";
    const path = input.id
      ? `/wp/v2/${rest}/${encodeURIComponent(input.id)}`
      : `/wp/v2/${rest}`;
    const p = await this.wpJson<WpPost>(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.getContent(kind, String(p.id));
  }

  async deleteContent(kind: ContentKind, id: string): Promise<{ ok: boolean }> {
    const res = await this.wp(
      `/wp/v2/${this.restKind(kind)}/${encodeURIComponent(id)}?force=true`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WordPress delete failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }
    return { ok: true };
  }

  /* -- Media library (extra, beyond the ContentConnector interface) -- */

  async listMedia(): Promise<
    { id: string; title: string; url: string | null; mime: string | null; updatedAt: string | null }[]
  > {
    const items = await this.wpJson<WpMedia[]>(
      "/wp/v2/media?per_page=100&_fields=id,slug,source_url,modified,mime_type",
    );
    return items.map((m) => ({
      id: String(m.id),
      title: m.slug,
      url: m.source_url ?? null,
      mime: m.mime_type ?? null,
      updatedAt: m.modified ?? null,
    }));
  }

  async uploadMedia(args: {
    filename: string;
    bytes: Uint8Array;
    mime: string;
  }): Promise<{ id: string; url: string | null }> {
    const safeName = args.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "upload.bin";
    const m = await this.wpJson<WpMedia>("/wp/v2/media", {
      method: "POST",
      headers: {
        "Content-Type": args.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeName}"`,
      },
      body: args.bytes as unknown as BodyInit,
    });
    return { id: String(m.id), url: m.source_url ?? null };
  }
}
