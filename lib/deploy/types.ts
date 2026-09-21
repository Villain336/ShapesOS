// Marketr — hosting deploy targets (milestone 9).
//
// A deploy target (Vercel, Cloudflare Pages) takes a static working copy and
// publishes it to a live URL. Each target implements this interface; tokens
// are AES-256-GCM encrypted at rest (lib/sitefiles/crypto.ts) and decrypted
// server-side only. `demo` targets serve the deterministic labeled mocks.

export type DeployTargetKind = "vercel" | "cloudflare-pages";

/** Decrypted Vercel config, server-side only. */
export interface VercelConfig {
  /** Vercel personal access token (https://vercel.com/account/tokens). */
  token: string;
  /** Existing Vercel project id/name to deploy into (optional — Vercel auto-creates otherwise). */
  projectId: string;
  /** Vercel team id (optional). */
  teamId: string;
  /** True → serve the deterministic labeled mock. */
  demo: boolean;
}

/** Decrypted Cloudflare config, server-side only. */
export interface CloudflareConfig {
  /** API token with Pages permissions. */
  token: string;
  /** Cloudflare account id. */
  accountId: string;
  /** Existing Pages project name to deploy into (optional — created on first deploy). */
  projectName: string;
  /** True → serve the deterministic labeled mock. */
  demo: boolean;
}

/** One static file to deploy. `path` is a clean relative path (e.g. "index.html"). */
export interface DeployFile {
  path: string;
  content: string;
}

export interface DeployResult {
  /** Provider deployment id (real) or mock-dep-… (mock). */
  deploymentId: string;
  /** Public URL (real *.vercel.app / *.pages.dev, mock-labeled in mock mode). */
  url: string;
  /** Normalized status. */
  status: "queued" | "building" | "ready" | "error";
  mock?: boolean;
}

export interface DeploymentSummary {
  id: string;
  url: string | null;
  status: "queued" | "building" | "ready" | "error";
  mock?: boolean;
}

/** Hosting deploy target: Vercel or Cloudflare Pages. */
export interface DeployTarget {
  readonly kind: DeployTargetKind;
  readonly name: string;
  readonly isLive: boolean;
  /** Connectivity check — returns a human-readable account/team line. */
  test(): Promise<{ ok: boolean; info: string }>;
  /** Deploy static files → live URL. */
  deploy(files: DeployFile[], opts?: { projectName?: string }): Promise<DeployResult>;
  /** Recent deployments for the connected account/project. */
  listDeployments(opts?: { projectName?: string; limit?: number }): Promise<DeploymentSummary[]>;
  /** Poll a deployment until it is ready/error. */
  getDeploymentStatus(deploymentId: string): Promise<DeploymentSummary>;
}

export function normalizeStatus(raw: unknown): DeployResult["status"] {
  const s = String(raw ?? "").toUpperCase();
  if (s === "READY") return "ready";
  if (s === "ERROR" || s === "FAILED" || s === "CANCELED") return "error";
  if (s === "BUILDING" || s === "INITIALIZING") return "building";
  return "queued";
}
