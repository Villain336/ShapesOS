// ShapesOS — Phase 9 (sites): which sites a run checked out into its sandbox.
//
// Kept on AgentRun.agentState.sites — the server's record (like the ship
// state): site_publish_draft reads the site id and directory from here, never
// from anything inside the sandbox, so nothing an agent does in there can
// point a draft at another site. Looked up the same way as the ship state
// (own run → parent run → newest run of the chat thread; lib/ship/state.ts).

import { findRunState, mergeRunState, type ShipLookup } from "@/lib/ship/state";

export interface SiteCheckout {
  siteId: string;
  siteName: string;
  projectId: string;
  /** Absolute directory inside the sandbox. */
  dir: string;
  /** Fingerprint of the working copy that was checked out (lib/sites/files.ts). */
  baseFingerprint: string;
  fileCount: number;
  /** A git baseline commit exists in dir (diffs are taken against it). */
  baseline: boolean;
  checkoutRunId: string;
  checkedOutAt: string;
  previewPort?: number;
  previewUrl?: string;
}

export interface SiteRunState {
  checkouts: Record<string, SiteCheckout>;
  /** The site checked out most recently (the default for site_publish_draft). */
  last?: string;
}

export function readSiteRunState(agentState: unknown): SiteRunState | null {
  const s = (agentState as { sites?: unknown } | null)?.sites as Partial<SiteRunState> | undefined;
  if (!s || typeof s !== "object" || !s.checkouts || typeof s.checkouts !== "object") return null;
  const checkouts: Record<string, SiteCheckout> = {};
  for (const [id, c] of Object.entries(s.checkouts)) {
    if (c && typeof c === "object" && typeof c.siteId === "string" && c.siteId === id && typeof c.dir === "string" && typeof c.baseFingerprint === "string") {
      checkouts[id] = c;
    }
  }
  if (!Object.keys(checkouts).length) return null;
  return { checkouts, last: typeof s.last === "string" && checkouts[s.last] ? s.last : undefined };
}

export function loadSiteRunState(q: ShipLookup): Promise<SiteRunState | null> {
  return findRunState(q, readSiteRunState);
}

export function saveSiteRunState(workspaceId: string, runId: string, state: SiteRunState): Promise<void> {
  return mergeRunState(workspaceId, runId, "sites", state);
}
