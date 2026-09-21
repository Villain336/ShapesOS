// Marketr — hosting connection resolution (milestone 9).
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
import type {
  CloudflareConfig,
  DeployFile,
  DeployTarget,
  DeployTargetKind,
  VercelConfig,
} from "./types";

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

export function hostingConnectorFor(conn: HostingConnection): DeployTarget {
  const cfg = decryptHostingConfig(conn) as {
    token?: string;
    projectId?: string;
    teamId?: string;
    accountId?: string;
    projectName?: string;
    demo?: boolean;
  };
  const demo = cfg.demo === true;
  if (conn.target === "vercel") {
    const vcfg: VercelConfig = {
      token: String(cfg.token ?? ""),
      projectId: String(cfg.projectId ?? ""),
      teamId: String(cfg.teamId ?? ""),
      demo,
    };
    return demo ? new MockVercelDeployTarget(vcfg) : new VercelDeployTarget(vcfg);
  }
  const ccfg: CloudflareConfig = {
    token: String(cfg.token ?? ""),
    accountId: String(cfg.accountId ?? ""),
    projectName: String(cfg.projectName ?? ""),
    demo,
  };
  return demo
    ? new MockCloudflarePagesDeployTarget(ccfg)
    : new CloudflarePagesDeployTarget(ccfg);
}

export function hostingKindLabel(target: DeployTargetKind | string): string {
  return target === "vercel" ? "Vercel" : "Cloudflare Pages";
}

/** Masked token hint for the UI (never the raw token). */
export function maskedTokenHint(configEnc: string): string {
  const cfg = decryptHostingConfig({ configEnc });
  const token = String(cfg.token ?? "");
  if (!token) return "no token set";
  return token.length <= 8 ? "••••" : `••••${token.slice(-4)}`;
}

export type { DeployFile };
