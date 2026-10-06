// Marketr — Site source resolution (milestone 7).
//
// A Site is the unit the builder creates and the IDE edits. The IDE always
// operates on a LOCAL WORKING COPY (siteWorkingDir):
//   - file-source sites: the working copy IS the site.
//   - github/sftp sites: `sync` pulls remote → working copy, `deploy` pushes
//     working copy → remote (one GitHub commit, or per-file SFTP writes).
//
// Secrets (GitHub tokens) live in Site.configEnc (AES-256-GCM, same crypto as
// milestone 6) and are decrypted server-side only — never sent to the client.

import type { Site, SiteConnection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { accessibleWorkspaceWhere } from "@/lib/authz";
import { secrets } from "@/lib/secrets";
import { getSiteFileProvider } from "@/lib/sitefiles";
import type { SiteFileProvider } from "@/lib/sitefiles/types";
import { GitHubSiteFileProvider } from "./github";
import { MockGitHubConnector } from "./mock-github";
import { siteWorkingCopy, type WorkingCopyProvider } from "./local";
import { WordPressConnector } from "./wordpress";
import type { SafeFetchOptions } from "./safe-fetch";
import { MockWordPressConnector } from "./mock-wordpress";
import { WebflowConnector } from "./webflow";
import { MockWebflowConnector } from "./mock-webflow";
import { fakeOrRefuse } from "@/lib/env/secrets";
import type {
  ContentConnector,
  GitHubConfig,
  GitHubConnector,
  WebflowConfig,
  WordPressConfig,
} from "./types";

export interface GitHubSiteConfig extends GitHubConfig {}

/** Parse + decrypt a site's config blob. */
export function decryptSiteConfig(site: { configEnc: string }): Record<string, unknown> {
  if (!site.configEnc) return {};
  try {
    return JSON.parse(secrets().decrypt(site.configEnc)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function encryptSiteConfig(config: Record<string, unknown>): string {
  return secrets().encrypt(JSON.stringify(config));
}

/** Load a site only if it belongs to a project in a workspace the user can access. */
export async function ownedSite(userId: string, projectId: unknown, siteId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  if (typeof siteId !== "string" || !siteId) return null;
  return prisma.site.findFirst({
    where: { id: siteId, projectId, project: { workspace: accessibleWorkspaceWhere(userId) } },
    include: { sftpConnection: true },
  });
}

export type OwnedSite = NonNullable<Awaited<ReturnType<typeof ownedSite>>>;

/**
 * The provider the IDE edits: always the site's working copy — a local
 * directory on a single box, the shared blob store when MARKETR_STORAGE=s3
 * (deploy PR: every replica edits the same copy).
 */
export async function getSiteIdeProvider(site: OwnedSite): Promise<WorkingCopyProvider> {
  const provider = siteWorkingCopy(site.id);
  await provider.ensureRoot();
  return provider;
}

/** Build the remote connector for github/sftp sites. Null for file sites. */
export async function getSiteRemote(
  site: OwnedSite,
): Promise<{ kind: "github"; connector: GitHubConnector } | { kind: "sftp"; provider: SiteFileProvider; connection: SiteConnection } | null> {
  if (site.sourceType === "github") {
    const cfg = decryptSiteConfig(site) as Partial<GitHubConfig>;
    const full: GitHubConfig = {
      token: String(cfg.token ?? ""),
      owner: String(cfg.owner ?? ""),
      repo: String(cfg.repo ?? ""),
      branch: String(cfg.branch ?? "main"),
      demo: cfg.demo === true,
    };
    // Phase 11 (conncore): demo (mock) connections are refused in production.
    const connector: GitHubConnector = full.demo
      ? fakeOrRefuse("demo GitHub", () => new MockGitHubConnector())
      : new GitHubSiteFileProvider(full);
    return { kind: "github", connector };
  }
  if (site.sourceType === "sftp") {
    if (!site.sftpConnection) throw new Error("Site has no linked SFTP connection");
    const provider = getSiteFileProvider({
      id: site.sftpConnection.id,
      label: site.sftpConnection.label,
      host: site.sftpConnection.host,
      port: site.sftpConnection.port,
      username: site.sftpConnection.username,
      authType: site.sftpConnection.authType,
      secretEnc: site.sftpConnection.secretEnc,
      demo: site.sftpConnection.demo,
    });
    return { kind: "sftp", provider, connection: site.sftpConnection };
  }
  return null;
}

/** Is this site's data mocked (demo)? Drives the honest UI banners. */
export function siteIsMock(site: OwnedSite): boolean {
  if (site.sourceType === "github") {
    const cfg = decryptSiteConfig(site) as Partial<GitHubConfig>;
    return cfg.demo === true;
  }
  if (site.sourceType === "sftp") return site.sftpConnection?.demo === true;
  if (site.sourceType === "wordpress") {
    const cfg = decryptSiteConfig(site) as Partial<WordPressConfig>;
    return cfg.demo === true;
  }
  if (site.sourceType === "webflow") {
    const cfg = decryptSiteConfig(site) as Partial<WebflowConfig>;
    return cfg.demo === true;
  }
  return false; // file sites are real local files
}

/** Build the content connector for wordpress/webflow sites (live or mock). */
export async function getContentConnector(
  site: OwnedSite,
  wpDeps?: SafeFetchOptions,
): Promise<ContentConnector> {
  const cfg = decryptSiteConfig(site) as Record<string, unknown>;
  if (site.sourceType === "wordpress") {
    const full: WordPressConfig = {
      baseUrl: String(cfg.baseUrl ?? ""),
      username: String(cfg.username ?? ""),
      appPassword: String(cfg.appPassword ?? ""),
      demo: cfg.demo === true,
    };
    // Day-1 hardening (M6): live WordPress connectors go through the
    // validated factory — a stored baseUrl pointing at an internal address
    // is rejected here instead of being fetched. (Every request is also
    // re-validated per-request + per-redirect-hop inside safeFetch.)
    return full.demo
      ? fakeOrRefuse("demo WordPress", () => new MockWordPressConnector(full))
      : await WordPressConnector.create(full, wpDeps);
  }
  if (site.sourceType === "webflow") {
    const full: WebflowConfig = {
      token: String(cfg.token ?? ""),
      siteId: String(cfg.siteId ?? ""),
      demo: cfg.demo === true,
    };
    return full.demo ? fakeOrRefuse("demo Webflow", () => new MockWebflowConnector(full)) : new WebflowConnector(full);
  }
  throw new Error(`Site ${site.id} is not a content source (${site.sourceType})`);
}

/** Public-safe site summary — no secrets, ever. */
export function publicSite(site: OwnedSite) {
  const cfg = decryptSiteConfig(site) as Partial<GitHubConfig> &
    Partial<WordPressConfig> &
    Partial<WebflowConfig>;
  return {
    id: site.id,
    projectId: site.projectId,
    name: site.name,
    sourceType: site.sourceType,
    isMock: siteIsMock(site),
    isLive: !siteIsMock(site),
    github:
      site.sourceType === "github"
        ? {
            owner: String(cfg.owner ?? ""),
            repo: String(cfg.repo ?? ""),
            branch: String(cfg.branch ?? "main"),
            demo: cfg.demo === true,
          }
        : null,
    wordpress:
      site.sourceType === "wordpress"
        ? {
            baseUrl: String(cfg.baseUrl ?? ""),
            username: String(cfg.username ?? ""),
            demo: cfg.demo === true,
          }
        : null,
    webflow:
      site.sourceType === "webflow"
        ? {
            siteId: String(cfg.siteId ?? ""),
            demo: cfg.demo === true,
          }
        : null,
    sftpConnection: site.sftpConnection
      ? { id: site.sftpConnection.id, label: site.sftpConnection.label, demo: site.sftpConnection.demo }
      : null,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}

/** Append to the audit log for site-scoped IDE actions. */
export async function logSiteChange(args: {
  projectId: string;
  siteId: string;
  filePath: string;
  actor: "user" | "ai";
  action: "save" | "ai_proposal" | "ai_applied";
  summary: string;
  approvedBy?: string | null;
}) {
  await prisma.fileChangeLog.create({
    data: {
      projectId: args.projectId,
      siteId: args.siteId,
      connectionId: null,
      filePath: args.filePath,
      actor: args.actor,
      action: args.action,
      summary: args.summary.slice(0, 280),
      approvedBy: args.approvedBy ?? null,
    },
  });
}

/** Recursively collect every file path from a provider (for sync/deploy). */
export async function collectAllFiles(
  provider: SiteFileProvider,
  dir = "/",
  out: string[] = [],
): Promise<string[]> {
  const entries = await provider.listDir(dir);
  for (const e of entries) {
    if (e.type === "dir") await collectAllFiles(provider, e.path, out);
    else out.push(e.path);
  }
  return out;
}
