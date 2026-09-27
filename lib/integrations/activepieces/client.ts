// Marketr — Activepieces engine REST client (Phase 12, Worker 3).
//
// Server-only. Speaks the community engine's platform API:
//   GET  {base}/v1/flows                       Bearer  — list flows
//   GET  {base}/v1/flows/{id}                   Bearer  — one flow (+version graph)
//   POST {base}/v1/webhooks/{flowId}             — trigger a webhook flow
//   GET  {base}/v1/flow-runs?flowId={id}        Bearer  — list runs (newest first)
//   GET  {base}/v1/flow-runs/{runId}            Bearer  — one run
//
// (Older engines serve these under /api/v1 — override with
// ACTIVEPIECES_API_PREFIX.) Webhook triggering needs no key — the engine
// treats the flowId path as the secret; Marketr still requires its own
// editor+ role check at the API-route layer.

import {
  activepiecesApiPrefix,
  readActivepiecesConfig,
} from "./config";
import {
  ActivepiecesApiError,
  ActivepiecesNotConfiguredError,
  isSuccessfulRunStatus,
  isTerminalRunStatus,
  type ActivepiecesEngineStatus,
  type ActivepiecesFlow,
  type ActivepiecesFlowRun,
  type TriggerFlowResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Build request headers; throws ActivepiecesNotConfiguredError when unset. */
function authHeaders(): { base: string; headers: Record<string, string> } {
  const { url, apiKey } = readActivepiecesConfig();
  if (!url || !apiKey) throw new ActivepiecesNotConfiguredError();
  return {
    base: url,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  endpoint: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = { _raw: text.slice(0, 500) };
    }
    if (!r.ok) {
      const msg =
        body && typeof body === "object" && "message" in body && typeof (body as Record<string, unknown>).message === "string"
          ? String((body as Record<string, unknown>).message)
          : `Activepieces engine answered ${r.status}`;
      throw new ActivepiecesApiError(r.status, endpoint, msg);
    }
    return body;
  } catch (e) {
    if (e instanceof ActivepiecesApiError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new ActivepiecesApiError(0, endpoint, `Could not reach the Activepieces engine: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Unwrap the platform pagination envelope: { data } or a bare array/object. */
function unwrapData(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.data)) return b.data;
  }
  return [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Extract the trigger step from a flow-version graph (defensive across versions). */
function extractTrigger(raw: unknown): { pieceName: string | null; triggerName: string | null } {
  const out = { pieceName: null as string | null, triggerName: null as string | null };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  // List views embed the trigger graph under several keys across versions.
  const candidates = [r.trigger, (r.version as Record<string, unknown> | undefined)?.trigger, (r.publishedVersion as Record<string, unknown> | undefined)?.trigger];
  for (const cand of candidates) {
    if (!cand || typeof cand !== "object") continue;
    const t = cand as Record<string, unknown>;
    const settings = (t.settings ?? {}) as Record<string, unknown>;
    const pieceName = str(settings.pieceName) ?? str(t.pieceName);
    const triggerName = str(settings.triggerName) ?? str(t.triggerName);
    if (pieceName || triggerName) {
      out.pieceName = pieceName;
      out.triggerName = triggerName;
      return out;
    }
  }
  return out;
}

const WEBHOOK_TRIGGER_NAMES = new Set(["catch_webhook"]);

function webhookUrlFor(base: string, flowId: string): string {
  return `${base}/v1/webhooks/${flowId}`;
}

/** Map a raw flow row to ActivepiecesFlow. */
function toFlow(base: string, raw: unknown): ActivepiecesFlow {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = str(r.id) ?? "";
  const { pieceName, triggerName } = extractTrigger(raw);
  const status = str(r.status) ?? "UNKNOWN";
  const published = str(r.publishedVersionId) !== null || status === "ENABLED";
  const triggerableViaWebhook =
    !!pieceName && (WEBHOOK_TRIGGER_NAMES.has(triggerName ?? "") || pieceName.includes("piece-webhook"));
  return {
    id,
    displayName: str(r.displayName) ?? id,
    status,
    triggerPiece: pieceName,
    triggerName,
    published,
    triggerableViaWebhook: triggerableViaWebhook && published,
    webhookUrl: triggerableViaWebhook && published ? webhookUrlFor(base, id) : null,
    createdAt: str(r.createdAt),
    updatedAt: str(r.updatedAt),
  };
}

function toFlowRun(raw: unknown): ActivepiecesFlowRun {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = str(r.status) ?? "UNKNOWN";
  const failedStep =
    r.failedStep && typeof r.failedStep === "object"
      ? (r.failedStep as Record<string, unknown>)
      : null;
  return {
    id: str(r.id) ?? "",
    flowId: str(r.flowId) ?? "",
    projectId: str(r.projectId),
    status,
    terminal: isTerminalRunStatus(status),
    succeeded: isSuccessfulRunStatus(status),
    startTime: str(r.startTime),
    finishTime: str(r.finishTime),
    failure:
      failedStep !== null
        ? {
            stepName: str(failedStep.name),
            errorMessage: str(failedStep.errorMessage),
          }
        : null,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ListFlowsOptions {
  /** Page size, default 50, max 100. */
  limit?: number;
  /** Cursor from a previous page (nextCursor). */
  cursor?: string;
}

export interface FlowPage {
  flows: ActivepiecesFlow[];
  nextCursor: string | null;
  configured: boolean;
}

/** List flows on the engine (Bearer). Degrades to `configured: false` when unset. */
export async function listFlows(opts: ListFlowsOptions = {}): Promise<FlowPage> {
  let auth: { base: string; headers: Record<string, string> };
  try {
    auth = authHeaders();
  } catch {
    return { flows: [], nextCursor: null, configured: false };
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));
  const qs = new URLSearchParams({ limit: String(limit) });
  if (opts.cursor) qs.set("cursor", opts.cursor);
  const endpoint = `GET ${activepiecesApiPrefix()}/flows`;
  const body = await fetchJson(`${auth.base}${activepiecesApiPrefix()}/flows?${qs}`, { headers: auth.headers }, endpoint);
  const rows = unwrapData(body);
  const nextCursor =
    body && typeof body === "object"
      ? (str((body as Record<string, unknown>).nextCursor) ?? str((body as Record<string, unknown>).next))
      : null;
  return { flows: rows.map((r) => toFlow(auth.base, r)), nextCursor, configured: true };
}

/** Fetch one flow by id (Bearer). Used to resolve trigger details before firing. */
export async function getFlow(flowId: string): Promise<ActivepiecesFlow> {
  const auth = authHeaders();
  const endpoint = `GET ${activepiecesApiPrefix()}/flows/${flowId}`;
  const body = await fetchJson(
    `${auth.base}${activepiecesApiPrefix()}/flows/${encodeURIComponent(flowId)}`,
    { headers: auth.headers },
    endpoint,
  );
  const raw = body && typeof body === "object" && "data" in body ? (body as Record<string, unknown>).data : body;
  return toFlow(auth.base, raw);
}

/** Status of the trigger pre-flight (for honest UI/error text). */
export interface TriggerPreflight {
  ok: boolean;
  reason: string | null;
  flow: ActivepiecesFlow | null;
}

/**
 * Pre-flight: is this flow actually triggerable from Marketr?
 * Only published + enabled webhook-trigger flows can be fired externally —
 * schedule/piece triggers must run inside the engine. Never fabricates.
 */
export async function preflightTrigger(flowId: string): Promise<TriggerPreflight> {
  let flow: ActivepiecesFlow;
  try {
    flow = await getFlow(flowId);
  } catch (e) {
    if (e instanceof ActivepiecesNotConfiguredError) throw e;
    return { ok: false, reason: e instanceof Error ? e.message : "flow not found", flow: null };
  }
  if (!flow.triggerableViaWebhook || !flow.webhookUrl) {
    const what = flow.triggerName ?? flow.triggerPiece ?? "unknown";
    return {
      ok: false,
      reason:
        `Flow "${flow.displayName}" cannot be triggered externally: its trigger is "${what}", ` +
        "not a webhook. Publish the flow with a “Catch Webhook” trigger to make it runnable from Marketr.",
      flow,
    };
  }
  if (flow.status !== "ENABLED") {
    return { ok: false, reason: `Flow "${flow.displayName}" is ${flow.status} — enable it in Activepieces first.`, flow };
  }
  return { ok: true, reason: null, flow };
}

/**
 * Trigger a flow run by POSTing the payload to its webhook URL.
 * Throws when not configured or when the flow isn't webhook-triggerable.
 * The webhook path itself needs no key — the flowId IS the secret — but the
 * caller (API route) must still enforce the editor+ role.
 */
export async function triggerFlow(
  flowId: string,
  payload: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TriggerFlowResult> {
  const pre = await preflightTrigger(flowId);
  if (!pre.ok || !pre.flow?.webhookUrl) {
    throw new Error(pre.reason ?? "Flow is not triggerable.");
  }
  const endpoint = `POST /v1/webhooks/${flowId}`;
  const body = await fetchJson(
    pre.flow.webhookUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
    endpoint,
    timeoutMs,
  );
  // Engine versions differ: accept runId from several shapes; usually absent.
  let runId: string | null = null;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    runId = str(b.runId) ?? str(b.flowRunId) ?? str(b.id) ?? null;
  }
  return { accepted: true, runId, flowId, response: body };
}

/** Newest run for a flow (list filtered by flowId, sorted newest-first defensively). */
export async function latestFlowRun(flowId: string): Promise<ActivepiecesFlowRun | null> {
  const auth = authHeaders();
  const endpoint = `GET ${activepiecesApiPrefix()}/flow-runs`;
  const qs = new URLSearchParams({ flowId, limit: "5" });
  const body = await fetchJson(`${auth.base}${activepiecesApiPrefix()}/flow-runs?${qs}`, { headers: auth.headers }, endpoint);
  const rows = unwrapData(body).map(toFlowRun);
  rows.sort((a, b) => String(b.startTime ?? "").localeCompare(String(a.startTime ?? "")));
  return rows[0] ?? null;
}

/** Fetch one run by id (Bearer). */
export async function getFlowRun(runId: string): Promise<ActivepiecesFlowRun> {
  const auth = authHeaders();
  const endpoint = `GET ${activepiecesApiPrefix()}/flow-runs/${runId}`;
  const body = await fetchJson(
    `${auth.base}${activepiecesApiPrefix()}/flow-runs/${encodeURIComponent(runId)}`,
    { headers: auth.headers },
    endpoint,
  );
  const raw = body && typeof body === "object" && "data" in body ? (body as Record<string, unknown>).data : body;
  const run = toFlowRun(raw);
  if (!run.id) throw new ActivepiecesApiError(404, endpoint, `Run ${runId} not found.`);
  return run;
}

export interface PollOptions {
  /** Milliseconds between polls, default 3000. */
  intervalMs?: number;
  /** Give up after this long, default 120000. */
  timeoutMs?: number;
  /** Called with each polled status (UI progress). */
  onTick?: (run: ActivepiecesFlowRun) => void;
}

/**
 * Poll a run until it reaches a terminal state (or the timeout elapses).
 * Webhook triggers often don't return a run id — callers should prefer
 * latestFlowRun(flowId) then poll that id.
 */
export async function pollFlowRun(runId: string, opts: PollOptions = {}): Promise<ActivepiecesFlowRun> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const started = Date.now();
  let run = await getFlowRun(runId);
  opts.onTick?.(run);
  while (!run.terminal) {
    if (Date.now() - started > timeoutMs) return run;
    await new Promise((r) => setTimeout(r, intervalMs));
    run = await getFlowRun(runId);
    opts.onTick?.(run);
  }
  return run;
}

/** Engine status passthrough (re-exported for convenience). */
export type { ActivepiecesEngineStatus };
