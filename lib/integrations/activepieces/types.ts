// Marketr — Activepieces automation backbone: public types (Phase 12, Worker 3).
//
// Activepieces community edition (MIT) runs as an optional sidecar engine
// (docker/integrations/activepieces.yml). Marketr talks to it over the
// platform REST API (`{engine}/v1/...`) with a Bearer API key. Nothing here
// touches packages/ee (commercial) — the client only consumes MIT-community
// surface: flows, flow-runs, and webhook triggers.
//
// Honesty rule: every function degrades cleanly when the engine is not
// configured (ACTIVEPIECES_URL / ACTIVEPIECES_API_KEY unset). Callers must
// surface the `configured: false` state instead of fabricating results.

/** Non-terminal run states — the run is still executing or waiting. */
export const NON_TERMINAL_RUN_STATUSES = ["QUEUED", "RUNNING", "PAUSED"] as const;

/**
 * Full FlowRunStatus set (Activepieces 2026: 3 non-terminal + 8 terminal
 * listed in the public docs; kept open-ended so future statuses parse).
 */
export type ActivepiecesRunStatus = string;

/** True when the run is still executing/waiting. */
export function isTerminalRunStatus(status: string): boolean {
  return !(NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** True when the run finished successfully. */
export function isSuccessfulRunStatus(status: string): boolean {
  return status === "SUCCEEDED";
}

/** Minimal flow view from `GET /v1/flows`. */
export interface ActivepiecesFlow {
  id: string;
  displayName: string;
  /** ENABLED | DISABLED */
  status: string;
  /** Piece name of the trigger, e.g. "@activepieces/piece-webhook". */
  triggerPiece: string | null;
  /** Trigger name within the piece, e.g. "catch_webhook". Null when unknown. */
  triggerName: string | null;
  /** True when the flow has a published (LOCKED) version and is ENABLED. */
  published: boolean;
  /** True when the trigger can be fired via a webhook POST. */
  triggerableViaWebhook: boolean;
  /** The webhook URL to POST to when triggerableViaWebhook. */
  webhookUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Minimal flow-run view from `GET /v1/flow-runs`. */
export interface ActivepiecesFlowRun {
  id: string;
  flowId: string;
  projectId: string | null;
  status: string;
  terminal: boolean;
  succeeded: boolean;
  startTime: string | null;
  finishTime: string | null;
  /** Server-reported failure info, when present. */
  failure: { stepName: string | null; errorMessage: string | null } | null;
}

/** Result of triggering a flow. */
export interface TriggerFlowResult {
  /** True when the engine accepted the trigger. */
  accepted: boolean;
  /** Run id when the engine returned one (webhook triggers often don't). */
  runId: string | null;
  /** Flow id that was triggered. */
  flowId: string;
  /** Raw trigger response body (shape differs by engine version). */
  response: unknown;
}

/** Engine reachability + credential state. */
export interface ActivepiecesEngineStatus {
  /** True only when BOTH url and apiKey are configured. */
  configured: boolean;
  /** Normalized engine base URL (no trailing slash), null when unconfigured. */
  url: string | null;
  /** True when the apiKey looks non-empty (never logs or returns the key). */
  hasApiKey: boolean;
}

/** One marketing-curated piece for the agent/catalog UI. */
export interface CuratedPiece {
  /** npm package name, e.g. "@activepieces/piece-webhook". */
  packageName: string;
  /** Piece name, e.g. "@activepieces/piece-webhook". */
  name: string;
  displayName: string;
  version: string;
  description: string | null;
  /** Trigger names this piece exposes (may be empty). */
  triggers: string[];
  /** Action names this piece exposes (may be empty). */
  actions: string[];
  /** Why this piece matters for marketing. */
  marketingUse: string;
  /** docs link (activepieces.com/pieces/…). Null when unknown. */
  docsUrl: string | null;
}

/** A curated marketing automation playbook entry (piece combination recipe). */
export interface AutomationRecipe {
  id: string;
  title: string;
  description: string;
  pieces: string[];
  triggerPiece: string;
}

/** Error thrown when the engine is not configured. Never fabricates runs. */
export class ActivepiecesNotConfiguredError extends Error {
  constructor() {
    super(
      "Activepieces is not connected: set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY " +
        "on the host (Settings → Providers shows how). No flow was triggered.",
    );
    this.name = "ActivepiecesNotConfiguredError";
  }
}

/** Error thrown when the engine returns an error response. */
export class ActivepiecesApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = "ActivepiecesApiError";
  }
}
