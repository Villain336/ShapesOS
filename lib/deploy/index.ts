// Marketr — hosting connection resolution (milestone 9; Phase 9 adds Netlify
// and one place that picks the provider class: buildDeployTarget).
//
// HostingConnections live per project (token AES-256-GCM encrypted, same
// crypto as milestones 6–8) and are decrypted server-side only — never sent
// to the client. Deployments are persisted per Site so the UI can show
// status + timestamp without calling the provider each time.

import type { HostingConnection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { accessibleWorkspaceWhere } from "@/lib/authz";
import { secrets } from "@/lib/secrets";
import { VercelDeployTarget } from "./vercel";
import { CloudflarePagesDeployTarget } from "./cloudflare";
import { MockVercelDeployTarget } from "./mock-vercel";
import { MockCloudflarePagesDeployTarget } from "./mock-cloudflare";
import { NetlifyDeployTarget } from "./netlify";
import { MockNetlifyDeployTarget } from "./mock-netlify";
import type {
  CloudflareConfig,
  DeployFile,
  DeployTarget,
  DeployTargetKind,
  NetlifyConfig,
  VercelConfig,
} from "./types";

/** Every hosting provider, in the order the UI lists them (Phase 9: + Netlify). */
export const DEPLOY_TARGET_KINDS: readonly DeployTargetKind[] = ["vercel", "cloudflare-pages", "netlify"];

const KIND_LABEL: Record<DeployTargetKind, string> = {
  vercel: "Vercel",
  "cloudflare-pages": "Cloudflare Pages",
  netlify: "Netlify",
};

/** The API slug for a stored target (Prisma enum name or slug). */
export function deployTargetSlug(target: string): DeployTargetKind {
  if (target === "vercel") return "vercel";
  if (target === "netlify") return "netlify";
  if (target === "cloudflare_pages" || target === "cloudflare-pages") return "cloudflare-pages";
  throw new Error(`Unknown deploy target "${target}".`);
}

/** The Prisma enum value for an API slug (throws for an unknown one). */
export function deployTargetEnum(slug: string): "vercel" | "cloudflare_pages" | "netlify" {
  const k = deployTargetSlug(slug);
  return k === "cloudflare-pages" ? "cloudflare_pages" : k;
}

/**
 * Build the deploy target for a decrypted config blob (live, or the labeled
 * mock when demo is set). The one place the provider classes are chosen —
 * connection create/test routes and stored connections all go through it.
 */
export function buildDeployTarget(kind: DeployTargetKind, raw: Record<string, unknown>): DeployTarget {
  const demo = raw.demo === true;
  const s = (k: string) => String(raw[k] ?? "").trim();
  if (kind === "vercel") {
    const vcfg: VercelConfig = { token: s("token"), projectId: s("projectId"), teamId: s("teamId"), demo };
    return demo ? new MockVercelDeployTarget(vcfg) : new VercelDeployTarget(vcfg);
  }
  if (kind === "netlify") {
    const ncfg: NetlifyConfig = { token: s("token"), siteId: s("siteId"), demo };
    return demo ? new MockNetlifyDeployTarget(ncfg) : new NetlifyDeployTarget(ncfg);
  }
  const ccfg: CloudflareConfig = { token: s("token"), accountId: s("accountId"), projectName: s("projectName"), demo };
  return demo ? new MockCloudflarePagesDeployTarget(ccfg) : new CloudflarePagesDeployTarget(ccfg);
}

/** Parse + decrypt a hosting connection's config blob. */
export function decryptHostingConfig(conn: { configEnc: string }): Record<string, unknown> {
  if (!conn.configEnc) return {};
  try {
    return JSON.parse(secrets().decrypt(conn.configEnc)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function encryptHostingConfig(config: Record<string, unknown>): string {
  return secrets().encrypt(JSON.stringify(config));
}

/** Load a hosting connection only if it belongs to a workspace the user can access. */
export async function ownedHostingConnection(userId: string, projectId: unknown, connId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  if (typeof connId !== "string" || !connId) return null;
  return prisma.hostingConnection.findFirst({
    where: { id: connId, projectId, project: { workspace: accessibleWorkspaceWhere(userId) } },
  });
}

export function hostingConnectorFor(conn: Pick<HostingConnection, "target" | "configEnc">): DeployTarget {
  return buildDeployTarget(deployTargetSlug(conn.target), decryptHostingConfig(conn));
}

export function hostingKindLabel(target: DeployTargetKind | string): string {
  try {
    return KIND_LABEL[deployTargetSlug(target)];
  } catch {
    return target;
  }
}

/** Masked token hint for the UI (never the raw token). */
export function maskedTokenHint(configEnc: string): string {
  const cfg = decryptHostingConfig({ configEnc });
  const token = String(cfg.token ?? "");
  if (!token) return "no token set";
  return token.length <= 8 ? "••••" : `••••${token.slice(-4)}`;
}

export type { DeployFile };
