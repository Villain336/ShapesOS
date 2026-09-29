// Marketr mobile — typed client for the Phase 14 autopilot gate + missions.
//
// Route contracts (the gate is the law; this client never reimplements it):
//   GET  /api/autopilot/queue?projectId=&status=
//        → { items: GateItem[] }                        (milestone 18)
//   GET  /api/autopilot/items/[id]?projectId=
//        → { item: GateItem, projectId, workspaceId }    (Phase 16 slice 3)
//   POST /api/autopilot/items/[id]/approve  { projectId }              → { ok: true }
//   POST /api/autopilot/items/[id]/reject   { projectId }              → { ok: true }
//   POST /api/autopilot/items/[id]/edit     { projectId, title?, draftMarkdown? }
//        → { ok: true }   (edit-then-requeue-pending — item stays pending)
//   GET  /api/missions  → { missions: MissionLite[] }
//
// All routes authenticate with the web app's session cookie (see
// src/auth/session.ts). RBAC is server-enforced (viewer+ to read, editor+ to
// decide) — the client surfaces 401/403 as GateApiError.

export type GateItemKind = "decay_refresh" | "programmatic_page" | "keyword_brief";

export interface GateItem {
  id: string;
  kind: GateItemKind;
  title: string;
  draftMarkdown: string | null;
  status: string;
  reviewNote: string | null;
  createdAt: string;
  rule: { id: string; name: string };
}

export interface MissionLite {
  id: string;
  template: string;
  goal: string;
  status: string;
  progress: number;
  updatedAt: string;
}

export type GateDecision = "approve" | "reject";

export class GateApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Route URL builders — the gate contract, in one place. */
export const gateUrls = {
  queue: (baseUrl: string, projectId: string, status?: string) => {
    const q = new URLSearchParams({ projectId });
    if (status) q.set("status", status);
    return `${baseUrl}/api/autopilot/queue?${q.toString()}`;
  },
  item: (baseUrl: string, itemId: string, projectId: string) =>
    `${baseUrl}/api/autopilot/items/${encodeURIComponent(itemId)}?projectId=${encodeURIComponent(projectId)}`,
  approve: (baseUrl: string, itemId: string) =>
    `${baseUrl}/api/autopilot/items/${encodeURIComponent(itemId)}/approve`,
  reject: (baseUrl: string, itemId: string) =>
    `${baseUrl}/api/autopilot/items/${encodeURIComponent(itemId)}/reject`,
  edit: (baseUrl: string, itemId: string) =>
    `${baseUrl}/api/autopilot/items/${encodeURIComponent(itemId)}/edit`,
  missions: (baseUrl: string) => `${baseUrl}/api/missions`,
};

export interface GateClientOptions {
  baseUrl: string;
  authHeaders: () => Record<string, string>;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // fall through
  }
  return `request failed (${res.status})`;
}

async function getJson<T>(url: string, opts: GateClientOptions): Promise<T> {
  const res = await fetch(url, { headers: { ...opts.authHeaders(), accept: "application/json" } });
  if (!res.ok) throw new GateApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

async function postJson(url: string, opts: GateClientOptions, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...opts.authHeaders(), "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GateApiError(res.status, await readError(res));
  const json = (await res.json()) as { ok?: boolean; error?: string };
  if (json.ok !== true) throw new GateApiError(res.status, json.error ?? "gate did not acknowledge");
}

/** Approval queue for a project (default: pending items, newest first). */
export async function fetchApprovalQueue(
  opts: GateClientOptions,
  projectId: string,
  status = "pending",
): Promise<GateItem[]> {
  const { items } = await getJson<{ items: GateItem[] }>(gateUrls.queue(opts.baseUrl, projectId, status), opts);
  return items ?? [];
}

/** One gate item, live from the gate — the approval card never renders agent-invented content. */
export async function fetchGateItem(
  opts: GateClientOptions,
  itemId: string,
  projectId: string,
): Promise<GateItem> {
  const { item } = await getJson<{ item: GateItem }>(gateUrls.item(opts.baseUrl, itemId, projectId), opts);
  if (!item) throw new GateApiError(404, "gate item not found");
  return item;
}

/** Approve or deny through the gate's own service functions (audit written server-side). */
export async function decideGateItem(
  opts: GateClientOptions,
  itemId: string,
  projectId: string,
  decision: GateDecision,
): Promise<void> {
  const url =
    decision === "approve"
      ? gateUrls.approve(opts.baseUrl, itemId)
      : gateUrls.reject(opts.baseUrl, itemId);
  await postJson(url, opts, { projectId });
}

/** Edit title/draft — update-then-requeue-pending; the item still needs approval. */
export async function editGateItem(
  opts: GateClientOptions,
  itemId: string,
  projectId: string,
  edit: { title?: string; draftMarkdown?: string },
): Promise<void> {
  await postJson(gateUrls.edit(opts.baseUrl, itemId), opts, { projectId, ...edit });
}

/** Dense mission list for the mission-progress widget fallback. */
export async function fetchMissions(opts: GateClientOptions): Promise<MissionLite[]> {
  const { missions } = await getJson<{ missions: MissionLite[] }>(gateUrls.missions(opts.baseUrl), opts);
  return missions ?? [];
}
