// Marketr — hosting deploy targets (milestone 9).
//
// A deploy target (Vercel, Cloudflare Pages, Netlify) takes a static working copy and
// publishes it to a live URL. Each target implements this interface; tokens
// are AES-256-GCM encrypted at rest (lib/sitefiles/crypto.ts) and decrypted
// server-side only. `demo` targets serve the deterministic labeled mocks.

export type DeployTargetKind = "vercel" | "cloudflare-pages" | "netlify";

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

/** Decrypted Netlify config, server-side only (Phase 9). */
export interface NetlifyConfig {
  /** Personal access token (https://app.netlify.com/user/applications). */
  token: string;
  /** Existing Netlify site id to deploy into (optional — created on first deploy). */
  siteId: string;
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
  /**
   * Phase 9: the provider-side project the deploy went to (Vercel project
   * id, Cloudflare Pages project name, Netlify site id). Stored on the
   * Deployment row so the next deploy and a rollback hit the same place.
   */
  project?: string;
}

/** Phase 9: where a rollback / next deploy goes (from the Deployment row). */
export interface DeployPlace {
  /** Provider project (see DeployResult.project). */
  project?: string | null;
  /** The Site's name — the project name derived on first deploy. */
  projectName?: string;
}

export interface DeploymentSummary {
  id: string;
  url: string | null;
  status: "queued" | "building" | "ready" | "error";
  mock?: boolean;
}

/** Hosting deploy target: Vercel, Cloudflare Pages or Netlify. */
export interface DeployTarget {
  readonly kind: DeployTargetKind;
  readonly name: string;
  readonly isLive: boolean;
  /** Connectivity check — returns a human-readable account/team line. */
  test(): Promise<{ ok: boolean; info: string }>;
  /** Deploy static files → live URL. */
  deploy(files: DeployFile[], opts?: { projectName?: string; project?: string | null }): Promise<DeployResult>;
  /** Recent deployments for the connected account/project. */
  listDeployments(opts?: { projectName?: string; limit?: number }): Promise<DeploymentSummary[]>;
  /** Poll a deployment until it is ready/error. */
  getDeploymentStatus(deploymentId: string): Promise<DeploymentSummary>;
  /**
   * Phase 9: make an earlier deployment live again (Vercel instant
   * rollback, Cloudflare Pages rollback, Netlify restore deploy). Changes a
   * live site — callers run it only behind an approved Tier-2 approval
   * (lib/deploy/rollback.ts).
   */
  rollback(deploymentId: string, place: DeployPlace): Promise<DeploymentSummary>;
}

// Vercel: QUEUED / INITIALIZING / BUILDING / READY / ERROR / CANCELED.
// Cloudflare Pages stage status: idle / active / success / failure / canceled.
// Netlify deploy state: new / uploading / uploaded / preparing / prepared /
// processing / building / enqueued / ready / error.
const READY_STATES = new Set(["READY", "SUCCESS"]);
const ERROR_STATES = new Set(["ERROR", "FAILED", "FAILURE", "CANCELED", "CANCELLED"]);
const BUILDING_STATES = new Set([
  "BUILDING",
  "INITIALIZING",
  "ACTIVE",
  "UPLOADING",
  "UPLOADED",
  "PREPARING",
  "PREPARED",
  "PROCESSING",
  "ENQUEUED",
]);

export function normalizeStatus(raw: unknown): DeployResult["status"] {
  const s = String(raw ?? "").toUpperCase();
  if (READY_STATES.has(s)) return "ready";
  if (ERROR_STATES.has(s)) return "error";
  if (BUILDING_STATES.has(s)) return "building";
  return "queued";
}
