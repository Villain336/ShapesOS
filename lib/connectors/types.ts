// Marketr — site connectors (milestone 7).
//
// A Site's files can live in a GitHub repo, on an SFTP host, or in a managed
// local directory (upload / AI-generated). Every connector implements the
// milestone-6 SiteFileProvider interface, so the IDE works identically no
// matter the source. GitHub adds repo-level operations (list/create repos,
// single-commit pushes) on top.

import type { SiteFileProvider } from "@/lib/sitefiles/types";

/** Decrypted GitHub config, server-side only. */
export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** True → serve the deterministic mock repo instead of the GitHub API. */
  demo: boolean;
}

export interface GitHubRepoSummary {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
  mock?: boolean;
}

export interface PushResult {
  /** Commit SHA (real) or mock-sha-… (mock). */
  sha: string;
  files: { path: string; ok: boolean }[];
  mock?: boolean;
}

/** GitHub file connector: SiteFileProvider + repo operations. */
export interface GitHubConnector extends SiteFileProvider {
  readonly kind: "github";
  listRepos(): Promise<GitHubRepoSummary[]>;
  createRepo(name: string, opts?: { private?: boolean; description?: string }): Promise<GitHubRepoSummary>;
  /** Push many files in ONE commit. Used by Deploy. */
  pushFiles(files: { path: string; content: string }[], message: string): Promise<PushResult>;
}

export type { SiteFileProvider };

/* ------------------------------------------------------------------ */
/* Milestone 8 — content-level connectors (WordPress + Webflow).        */
/*                                                                      */
/* Unlike file sources, these APIs cannot see or edit theme/plugin      */
/* files (WordPress REST) or page designs (Webflow API) — they operate  */
/* on content: pages/posts/media (WP) and CMS items + site publish      */
/* (Webflow). ContentConnector extends the interface where file         */
/* sources need new methods, exactly as the milestone brief asks.       */
/* ------------------------------------------------------------------ */

/** Decrypted WordPress config, server-side only. */
export interface WordPressConfig {
  /** Site URL, e.g. https://client.example.com (no trailing slash). */
  baseUrl: string;
  /** WP username that owns the application password. */
  username: string;
  /** Application password (from Users → Profile → Application Passwords). */
  appPassword: string;
  /** True → serve the deterministic labeled mock site. */
  demo: boolean;
}

/** Decrypted Webflow config, server-side only. */
export interface WebflowConfig {
  /** Webflow API v2 token (site-scoped or workspace token). */
  token: string;
  /** Default Webflow site id (optional — can be picked in UI). */
  siteId: string;
  /** True → serve the deterministic labeled mock site. */
  demo: boolean;
}

export type ContentKind = "page" | "post" | "collection" | "item";

/** One row in a content listing (page, post, collection, or CMS item). */
export interface ContentItem {
  id: string;
  kind: ContentKind;
  title: string;
  slug: string;
  status: string;
  /** Parent collection id, for Webflow items. */
  collectionId?: string;
  link?: string | null;
  updatedAt: string | null;
  mock?: boolean;
}

/** Full content for editing. `content` is HTML for WP, pretty-printed JSON fieldData for Webflow items. */
export interface ContentDetail extends ContentItem {
  content: string;
}

export interface SaveContentInput {
  /** Omit to create. */
  id?: string;
  title: string;
  slug?: string;
  content: string;
  status: "draft" | "publish";
  /** Webflow only: target collection id for new items. */
  collectionId?: string;
}

export interface PublishResult {
  ok: boolean;
  /** What was created/updated remotely. */
  remoteId?: string;
  link?: string | null;
  mock?: boolean;
}

/** Content-level connector: pages/posts/media (WP) or CMS + publish (Webflow). */
export interface ContentConnector {
  readonly kind: "wordpress" | "webflow";
  readonly name: string;
  readonly isLive: boolean;
  /** Connectivity check — returns a human-readable site/site-name line. */
  test(): Promise<{ ok: boolean; info: string }>;
  /** List pages+posts (WP) or collections (Webflow, kind "collection"). */
  listContent(kind: ContentKind): Promise<ContentItem[]>;
  getContent(kind: ContentKind, id: string, opts?: ContentOpts): Promise<ContentDetail>;
  saveContent(kind: ContentKind, input: SaveContentInput, opts?: ContentOpts): Promise<ContentDetail>;
  deleteContent(kind: ContentKind, id: string, opts?: ContentOpts): Promise<{ ok: boolean }>;
}

/** Optional per-call context. Webflow items live inside a collection. */
export interface ContentOpts {
  /** Webflow only: the CMS collection the item belongs to. */
  collectionId?: string;
}
