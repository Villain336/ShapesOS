// Marketr — Phase 12 "Reconsider trio": Plane project-management sidecar client.
//
// BYO-key pattern (same as lib/integrations/listmonk.ts):
//   PLANE_BASE_URL, PLANE_API_KEY, PLANE_WORKSPACE_SLUG live on the host
//   environment, are read server-side only, and never reach the browser.
//   No credentials → loud honest error, never fake issues.
//
// SIDECAR CONTRACT: Plane is AGPL-3.0 (survey: single clean grant). It is a
// separate process — talked to ONLY over HTTP (X-API-Key public API v1).
// Never copy, fork, or import Plane code into Marketr. API use across the
// process boundary keeps the AGPL network-copyleft inside the Plane sidecar.
// See docs/phase12/integration-survey.md §Tier 1.
//
// API shape (verified 2026-09-27 against Plane docs + community findings):
//   GET /api/v1/workspaces/{slug}/projects/                              → list
//   GET /api/v1/workspaces/{slug}/projects/{project_id}/issues/          → list
//   (cursor-paginated envelope: { results, next_cursor, next_page_results })
// Auth: X-API-Key header. Note: some upstream endpoints (pages, *-lite
// variants) are missing on self-hosted Community Edition — this client only
// uses the documented, widely-confirmed projects/issues paths.

import { currentSidecarSource, sidecarEnv, sidecarRefusalMessage } from "./sidecar-tenancy";
export const PLANE_TIMEOUT_MS = 15_000;
export const PLANE_MAX_PER_PAGE = 100;

/** Honest unconfigured-credentials message. Names the env vars; never their values. */
export const PLANE_NOT_CONFIGURED_MESSAGE =
  "Plane isn't connected. Set PLANE_BASE_URL, PLANE_API_KEY and PLANE_WORKSPACE_SLUG in Settings → Providers, then try again.";

export interface PlaneConfig {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
}

export function getPlaneConfig(): PlaneConfig {
  // Phase 15.1: the workspace's own Plane, else env — refused on hosted.
  const env = sidecarEnv("plane");
  return {
    baseUrl: (env.PLANE_BASE_URL ?? "").replace(/\/+$/, "").trim(),
    apiKey: (env.PLANE_API_KEY ?? "").trim(),
    workspaceSlug: (env.PLANE_WORKSPACE_SLUG ?? "").trim(),
  };
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function planeStatus() {
  const { baseUrl, apiKey, workspaceSlug } = getPlaneConfig();
  const configured = baseUrl.length > 0 && apiKey.length > 0 && workspaceSlug.length > 0;
  return { name: "plane", isLive: configured, configured, workspaceSlug };
}

function notConfigured(): never {
  throw new PlaneConfigError(
    currentSidecarSource("plane") === "refused" ? sidecarRefusalMessage("plane") : PLANE_NOT_CONFIGURED_MESSAGE,
  );
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** 400-class local failure (missing credentials, bad input). Routes map it to JSON. */
export class PlaneConfigError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PlaneConfigError";
  }
}

/** A Plane HTTP response that was not 2xx. Never carries credentials. */
export class PlaneApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PlaneApiError";
    this.status = status;
  }
}

// ── Trimmed shapes (client-safe: no key material, no vendor internals) ──────

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
}

export interface PlaneIssue {
  id: string;
  name: string;
  /** Human-friendly sequence number inside the project, when present. */
  sequenceId: number | null;
  state: string | null;
  /** completed | cancelled | started | unstarted | backlog */
  stateGroup: string | null;
  priority: string | null;
  labels: string[];
  url: string | null;
  updatedAt: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function mapProject(raw: unknown): PlaneProject {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: str(r.id) ?? "",
    name: str(r.name) ?? "Untitled project",
    identifier: str(r.identifier) ?? "",
  };
}

export function mapIssue(raw: unknown, baseUrl: string, workspaceSlug: string, projectIdentifier: string): PlaneIssue {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const seq = typeof r.sequence_id === "number" ? r.sequence_id : null;
  const url =
    seq !== null && projectIdentifier
      ? `${baseUrl}/${workspaceSlug}/projects/${projectIdentifier}/issues/${seq}`
      : null;
  return {
    id: str(r.id) ?? "",
    name: str(r.name) ?? "Untitled issue",
    sequenceId: seq,
    state: str((r.state_detail as Record<string, unknown> | undefined)?.name ?? r.state) ?? null,
    stateGroup: str((r.state_detail as Record<string, unknown> | undefined)?.group ?? r.state_group) ?? null,
    priority: str(r.priority) ?? null,
    labels: Array.isArray(r.label_details)
      ? r.label_details.map((l) => str((l as Record<string, unknown>)?.name)).filter((x): x is string => !!x)
      : [],
    url,
    updatedAt: str(r.updated_at) ?? null,
  };
}

/** Issues that still need work: everything not completed/cancelled. */
export function isOpenIssue(i: PlaneIssue): boolean {
  const g = (i.stateGroup ?? "").toLowerCase();
  return g !== "completed" && g !== "cancelled";
}

export function openIssues(issues: PlaneIssue[]): PlaneIssue[] {
  return issues.filter(isOpenIssue);
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

async function planeGet<T>(
  cfg: PlaneConfig,
  path: string,
  query: Record<string, string> = {},
  fetchImpl: FetchImpl = fetch,
): Promise<T> {
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.workspaceSlug) notConfigured();
  const qs = new URLSearchParams(query);
  const url = `${cfg.baseUrl}/api/v1/workspaces/${encodeURIComponent(cfg.workspaceSlug)}${path}${qs.size ? `?${qs}` : ""}`;
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PLANE_TIMEOUT_MS);
    try {
      res = await fetchImpl(url, { headers: { "X-API-Key": cfg.apiKey }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new PlaneApiError(0, "Could not reach the Plane instance. Check PLANE_BASE_URL in Settings → Providers.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new PlaneApiError(
      res.status,
      `Plane rejected the API key (HTTP ${res.status}). Check PLANE_API_KEY in Settings → Providers.`,
    );
  }
  if (res.status === 404) {
    throw new PlaneApiError(404, "Plane returned 404 — check PLANE_WORKSPACE_SLUG and the project ID.");
  }
  if (!res.ok) {
    throw new PlaneApiError(res.status, `Plane request failed with HTTP ${res.status}.`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new PlaneApiError(res.status, "Plane returned an unreadable response.");
  }
}

/** Unwrap Plane's cursor envelope ({ results }) or a bare array. */
function resultsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const r = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  return Array.isArray(r.results) ? r.results : [];
}

/** Fetch ALL pages of a cursor-paginated list endpoint (guard: max 10 pages). */
async function planeGetAll(
  cfg: PlaneConfig,
  path: string,
  fetchImpl: FetchImpl,
): Promise<unknown[]> {
  const all: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const payload = await planeGet<unknown>(cfg, path, { per_page: String(PLANE_MAX_PER_PAGE), ...(cursor ? { cursor } : {}) }, fetchImpl);
    const batch = resultsOf(payload);
    all.push(...batch);
    const r = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
    const next = typeof r.next_cursor === "string" ? r.next_cursor : null;
    const more = r.next_page_results === true;
    if (!more || !next || batch.length === 0) break;
    cursor = next;
  }
  return all;
}

/** List Plane projects in the configured workspace. */
export async function listPlaneProjects(fetchImpl: FetchImpl = fetch): Promise<PlaneProject[]> {
  const cfg = getPlaneConfig();
  const raw = await planeGetAll(cfg, "/projects/", fetchImpl);
  return raw.map(mapProject).filter((p) => p.id);
}

/**
 * List issues in one Plane project (all pages). Pass the project's id
 * (UUID); its `identifier` (PROJ key) is resolved internally for deep links.
 */
export async function listPlaneIssues(projectId: string, fetchImpl: FetchImpl = fetch): Promise<PlaneIssue[]> {
  const cfg = getPlaneConfig();
  const id = (projectId ?? "").trim();
  if (!id) throw new PlaneConfigError("A Plane project ID is required.");
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new PlaneConfigError("That Plane project ID doesn't look valid.");
  const raw = await planeGetAll(cfg, `/projects/${encodeURIComponent(id)}/issues/`, fetchImpl);
  // Resolve the project's PROJ identifier for deep links (best-effort).
  let identifier = "";
  try {
    const proj = await planeGet<{ identifier?: unknown }>(cfg, `/projects/${encodeURIComponent(id)}/`, {}, fetchImpl);
    identifier = typeof proj.identifier === "string" ? proj.identifier : "";
  } catch {
    // Deep links degrade to null; the list still works.
  }
  return raw.map((r) => mapIssue(r, cfg.baseUrl, cfg.workspaceSlug, identifier)).filter((i) => i.id);
}
