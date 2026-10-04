// Marketr — connector health checker (Phase B, track B3; spec W2.5, §7).
//
// Derived/cached health for every ConnectorConnection, refreshed by a
// checker job. The scheduler track invokes the exported runHealthChecks()
// on its own cron — this module owns NO timer loop.
//
// HONESTY RULES (see docs/security/THREAT-MODEL-connector-health.md):
//   1. The checker performs ZERO network probes to user-configured URLs
//      (no SSRF surface). Health is derived from credential/token lifecycle
//      state the server already holds: adapter live-wiring flag, connection
//      status, and OAuth token expiry — plus the existing silent-refresh
//      flow (lib/vault/refresh.ts), which talks only to provider token
//      endpoints, never to user-configured hosts.
//   2. Mock-only adapters (no live wiring) report `unknown` with an honest
//      label — NEVER fake green. (Phase 4b wired the last six: 0 of the 23
//      built-ins are mock-only and MOCK_ONLY_ADAPTER_KEYS in registry.ts is
//      empty, but the rule stays for any future adapter.)
//   5. Phase 4b: the MANUAL check (POST /api/connections/[id]/check) may
//      inject `liveCheck`, which asks the adapter for one cheap call to its
//      fixed provider endpoint (lib/connectors/m21/live/probe.ts). The
//      scheduled run never does; this module still makes no network call.
//   3. API-key adapters cannot be verified offline without a live call
//      (which would be a paid call or an SSRF probe), so they report
//      `unknown` until a real successful provider interaction is recorded
//      via recordSuccessfulSync().
//   4. Errors are a CLOSED SET of codes with plain-language fix hints.
//      Raw provider messages, decrypted payloads, and token-shaped strings
//      never reach the DB, the API, the audit log, or alert channels.

import { prisma } from "@/lib/prisma";
import { auditEvent } from "@/lib/auditlog";
import { emitAlert } from "@/lib/alerts/evaluate";
import {
  getConnectionAuthType,
  refreshConnection,
  type RefreshDeps,
} from "@/lib/vault/refresh";
import { getBuiltinMeta, MOCK_ONLY_ADAPTER_KEYS } from "@/lib/connectors/m21/registry";
import type { ConnectorHealthStatus } from "@prisma/client";

export type HealthStatus = ConnectorHealthStatus; // healthy|degraded|needs_reauth|error|unknown

/** Closed set of health error codes. Raw provider text NEVER leaves this module. */
export const HEALTH_ERROR_CODES = [
  "expired_token",
  "auth_rejected",
  "provider_unreachable",
  "config_missing",
  "revoked",
  "mock_adapter",
  "unverified",
  "unknown_error",
] as const;
export type HealthErrorCode = (typeof HEALTH_ERROR_CODES)[number];

/** Plain-language fix hints shown in the UI and alerts. No secrets, no raw errors. */
export const FIX_HINTS: Record<HealthErrorCode, string> = {
  expired_token:
    "The access token expired and could not be refreshed automatically. Reconnect the integration to continue.",
  auth_rejected:
    "The provider rejected the stored credentials. Reconnect the integration — you may need to re-authorize it.",
  provider_unreachable:
    "ShapesOS could not reach the provider during the check. Check your network and retry — nothing to fix in ShapesOS.",
  config_missing:
    "No credential is stored for this connection. Reconnect the integration to add one.",
  revoked:
    "This connection was revoked at the provider. Reconnect the integration to restore it.",
  mock_adapter:
    "Live health checks are not available for this connector yet — its live provider wiring has not been built. Nothing is wrong; this is expected.",
  unverified:
    "API-key connections cannot be verified without a live call, and the checker never makes one. It will show healthy after its first successful sync.",
  unknown_error:
    "The health check hit an unexpected problem. Retry the check; if it persists, reconnect the integration.",
};

/** Token-shaped material is scrubbed before ANY classification or logging. */
const SECRET_PATTERNS: RegExp[] = [
  /access_token\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /refresh_token\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /api[_-]?key\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /client_secret\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /bearer\s+[A-Za-z0-9\-._~+/=]+/gi,
];

/** Classify an unknown failure into the closed code set. Never throws. */
export function sanitizeHealthError(err: unknown): HealthErrorCode {
  let msg: string;
  try {
    msg = err instanceof Error ? err.message : String(err);
  } catch {
    return "unknown_error";
  }
  let scrubbed = msg.slice(0, 500);
  for (const re of SECRET_PATTERNS) scrubbed = scrubbed.replace(re, "[redacted]");
  const m = scrubbed.toLowerCase();
  if (/(expired|expiring|expires)/.test(m)) return "expired_token";
  if (/(invalid_grant|invalid_token|unauthorized|401|403|forbidden|revoked|bad credentials)/.test(m))
    return "auth_rejected";
  if (/(enotfound|econnrefused|etimedout|timed out|network|fetch failed|unreachable|dns|eai_again)/.test(m))
    return "provider_unreachable";
  if (/(no credential|missing credential|not configured|not found)/.test(m)) return "config_missing";
  return "unknown_error";
}

export interface HealthCheckResult {
  connectionId: string;
  workspaceId: string;
  connectorKey: string;
  status: HealthStatus;
  lastCheckAt: Date;
  lastSuccessAt: Date | null;
  errorCode: HealthErrorCode | null;
  fixHint: string | null;
  quotaUsed: number | null;
  quotaLimit: number | null;
  /** False for mock-only adapters and custom MCP servers (no live check exists). */
  liveCheck: boolean;
  /** Honest human label for `unknown` states. */
  label: string | null;
}

/** Read quota from non-sensitive connection meta when the adapter reports it. */
function readQuota(meta: unknown): { used: number | null; limit: number | null } {
  const out = { used: null as number | null, limit: null as number | null };
  if (!meta || typeof meta !== "object") return out;
  const q = (meta as Record<string, unknown>).quota;
  if (!q || typeof q !== "object") return out;
  const used = (q as Record<string, unknown>).used;
  const limit = (q as Record<string, unknown>).limit;
  if (typeof used === "number" && Number.isFinite(used)) out.used = used;
  if (typeof limit === "number" && Number.isFinite(limit)) out.limit = limit;
  return out;
}

/** Outcome of an adapter liveness call (closed code only). */
export interface LiveCheckOutcome {
  ok: boolean;
  errorCode?: string;
}

export interface CheckDeps extends RefreshDeps {
  /**
   * Manual checks only: one cheap live call through the adapter. null means
   * the connector has no live check (the lifecycle verdict stands).
   */
  liveCheck?: (connectionId: string) => Promise<LiveCheckOutcome | null>;
}

/** Map an adapter liveness failure onto the health verdict. */
export function liveCheckVerdict(errorCode: string | undefined): { status: HealthStatus; code: HealthErrorCode } {
  switch (errorCode) {
    case "auth_rejected":
    case "forbidden":
      return { status: "needs_reauth", code: "auth_rejected" };
    case "not_connected":
    case "config_missing":
      return { status: "error", code: "config_missing" };
    case "rate_limited":
    case "provider_unreachable":
    case "provider_error":
      return { status: "degraded", code: "provider_unreachable" };
    default:
      return { status: "error", code: "unknown_error" };
  }
}

/**
 * Evaluate one connection and upsert its ConnectorHealth row.
 * Never throws on a per-connection failure — the row records `unknown` and
 * the scheduler moves on (the run summary counts it).
 */
export async function checkConnection(
  connectionId: string,
  deps: CheckDeps = {},
): Promise<HealthCheckResult | null> {
  const now = new Date();
  try {
    const connection = await prisma.connectorConnection.findUnique({
      where: { id: connectionId },
      include: { credential: { select: { expiresAt: true } }, health: true },
    });
    if (!connection) return null;

    const { workspaceId, connectorKey } = connection;
    const prev = connection.health;
    const quota = readQuota(connection.meta);

    const finish = async (
      status: HealthStatus,
      errorCode: HealthErrorCode | null,
      opts: { lastSuccessAt?: Date | null; liveCheck?: boolean; label?: string | null } = {},
    ): Promise<HealthCheckResult> => {
      const lastSuccessAt =
        opts.lastSuccessAt !== undefined ? opts.lastSuccessAt : (prev?.lastSuccessAt ?? null);
      // A status change resets the alert episode (see THREAT-MODEL §3).
      const statusChanged = !prev || prev.status !== status;
      const row = await prisma.connectorHealth.upsert({
        where: { connectionId },
        create: {
          connectionId,
          workspaceId,
          status,
          lastCheckAt: now,
          lastSuccessAt,
          lastError: errorCode,
          quotaUsed: quota.used,
          quotaLimit: quota.limit,
          consecutiveErrors: status === "error" || status === "needs_reauth" ? 1 : 0,
        },
        update: {
          workspaceId,
          status,
          lastCheckAt: now,
          lastSuccessAt,
          lastError: errorCode,
          quotaUsed: quota.used,
          quotaLimit: quota.limit,
          consecutiveErrors: statusChanged ? (status === "error" || status === "needs_reauth" ? 1 : 0) : undefined,
          lastAlertAt: statusChanged ? null : undefined,
        },
      });
      const result: HealthCheckResult = {
        connectionId,
        workspaceId,
        connectorKey,
        status,
        lastCheckAt: now,
        lastSuccessAt,
        errorCode,
        fixHint: errorCode ? FIX_HINTS[errorCode] : null,
        quotaUsed: quota.used,
        quotaLimit: quota.limit,
        liveCheck: opts.liveCheck ?? true,
        label: opts.label ?? null,
      };
      await maybeAlert(result, row.lastAlertAt, row.consecutiveErrors);
      return result;
    };

    // Rule 2: mock-only adapters are NEVER green.
    if (MOCK_ONLY_ADAPTER_KEYS.has(connectorKey)) {
      return finish("unknown", "mock_adapter", {
        liveCheck: false,
        label: "Live check unavailable — mock adapter (no live provider wiring yet).",
      });
    }

    const authType = await getConnectionAuthType(connectorKey);
    if (authType === "none") {
      // Custom MCP servers / unknown keys: no lifecycle signal to evaluate.
      return finish("unknown", null, {
        liveCheck: false,
        label: "Custom connector — health is not evaluated automatically.",
      });
    }

    if (connection.status === "revoked") {
      return finish("error", "revoked");
    }
    if (connection.status === "needs_reauth") {
      return finish("needs_reauth", "auth_rejected");
    }

    if (!connection.credential) {
      return finish("needs_reauth", "config_missing");
    }

    if (authType === "oauth2") {
      const expiresAt = connection.credential.expiresAt;
      const expired = expiresAt != null && expiresAt.getTime() <= now.getTime();
      if (expired) {
        // Expired: attempt the existing silent-refresh flow once.
        const refreshed = await refreshConnection(connectionId, deps);
        if (refreshed !== "refreshed") return finish("needs_reauth", "expired_token");
      }
      if (deps.liveCheck) {
        const outcome = await deps.liveCheck(connectionId);
        if (outcome?.ok) return finish("healthy", null, { lastSuccessAt: now });
        if (outcome) {
          const v = liveCheckVerdict(outcome.errorCode);
          return finish(v.status, v.code);
        }
      }
      if (expired) return finish("healthy", null, { lastSuccessAt: now });
      // Token lifecycle is clean — the scheduled run makes no provider call.
      return finish("healthy", null, { lastSuccessAt: prev?.lastSuccessAt ?? connection.lastRefreshAt });
    }

    // api_key: no offline verification exists (probing would be a live,
    // possibly-paid call to a user-configured URL — never done here).
    if (prev?.lastSuccessAt) {
      return finish("healthy", null);
    }
    return finish("unknown", "unverified", {
      label: "Not yet verified — no successful sync has been recorded for this API-key connection.",
    });
  } catch (err) {
    // The checker must never leak internals: classify, persist the code, move on.
    const code = sanitizeHealthError(err);
    const connection = await prisma.connectorConnection
      .findUnique({ where: { id: connectionId }, select: { workspaceId: true, connectorKey: true, health: true } })
      .catch(() => null);
    if (!connection) return null;
    const prev = connection.health;
    const statusChanged = !prev || prev.status !== "unknown";
    const row = await prisma.connectorHealth
      .upsert({
        where: { connectionId },
        create: {
          connectionId,
          workspaceId: connection.workspaceId,
          status: "unknown",
          lastCheckAt: now,
          lastError: code,
          consecutiveErrors: 0,
        },
        update: {
          status: "unknown",
          lastCheckAt: now,
          lastError: code,
          lastAlertAt: statusChanged ? null : undefined,
        },
      })
      .catch(() => null);
    const result: HealthCheckResult = {
      connectionId,
      workspaceId: connection.workspaceId,
      connectorKey: connection.connectorKey,
      status: "unknown",
      lastCheckAt: now,
      lastSuccessAt: prev?.lastSuccessAt ?? null,
      errorCode: code,
      fixHint: FIX_HINTS[code],
      quotaUsed: null,
      quotaLimit: null,
      liveCheck: true,
      label: "The health check itself failed; retry the check.",
    };
    if (row) await maybeAlert(result, row.lastAlertAt, row.consecutiveErrors).catch(() => {});
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* Alerting: checker-side cooldown with escalation (THREAT-MODEL §3).    */
/*                                                                      */
/* - needs_reauth: alert ONCE per episode (until the status changes).    */
/* - error: escalating backoff 15m → 1h → 6h → 24h (cap).               */
/* Delivery goes through the existing alert hub (emitAlert) with a      */
/* per-connection+status dedupKey, so workspace rule cooldowns,        */
/* digests, and quiet hours apply on top. The checker never sends raw   */
/* email/webhook itself.                                                */
/* ------------------------------------------------------------------ */

const ERROR_ALERT_BASE_MIN = 15;
const ERROR_ALERT_MAX_MIN = 24 * 60;

/** Escalating cooldown for repeated error alerts: 15m → 30m → 1h … → 24h cap. */
export function alertCooldownMinutes(consecutiveErrors: number): number {
  return Math.min(ERROR_ALERT_BASE_MIN * 2 ** Math.max(0, consecutiveErrors - 1), ERROR_ALERT_MAX_MIN);
}

/**
 * Pure alert-gating decision (exported for the adversarial battery).
 * needs_reauth fires ONCE per episode; error fires on the escalating cooldown.
 */
export function shouldFireHealthAlert(
  status: HealthStatus,
  lastAlertAt: Date | null,
  consecutiveErrors: number,
  now: Date = new Date(),
): boolean {
  if (status !== "needs_reauth" && status !== "error") return false;
  if (status === "needs_reauth") return lastAlertAt == null;
  if (!lastAlertAt) return true;
  return now.getTime() - lastAlertAt.getTime() >= alertCooldownMinutes(consecutiveErrors) * 60_000;
}

async function maybeAlert(
  result: HealthCheckResult,
  lastAlertAt: Date | null,
  consecutiveErrors: number,
): Promise<void> {
  if (result.status !== "needs_reauth" && result.status !== "error") return;
  // needs_reauth: once per episode. error: escalating cooldown.
  if (!shouldFireHealthAlert(result.status, lastAlertAt, consecutiveErrors)) return;

  let displayName = result.connectorKey;
  try {
    displayName = getBuiltinMeta(result.connectorKey).displayName;
  } catch {
    /* keep key */
  }

  const title =
    result.status === "needs_reauth"
      ? `Connector needs re-authentication: ${displayName}`
      : `Connector error: ${displayName}`;
  const body =
    result.status === "needs_reauth"
      ? `${displayName} needs to be reconnected. ${result.fixHint ?? ""}`.trim()
      : `${displayName} reported an error (${result.errorCode}). ${result.fixHint ?? ""}`.trim();

  await prisma.connectorHealth
    .update({
      where: { connectionId: result.connectionId },
      data: {
        lastAlertAt: new Date(),
        consecutiveErrors: { increment: 1 },
      },
    })
    .catch(() => {});

  // Existing notification-settings infrastructure: alert hub rules decide
  // channels/digests/quiet hours. Never rejects (hub swallows per-rule errors).
  await emitAlert({
    workspaceId: result.workspaceId,
    trigger: "connector_error",
    severity: result.status === "needs_reauth" ? "warn" : "critical",
    title,
    body,
    dedupKey: `connector_error:${result.connectionId}:${result.status}`,
    link: "/dashboard/settings/connectors?tab=health",
  }).catch(() => {});

  await auditEvent({
    projectId: null,
    workspaceId: result.workspaceId,
    action: "connector_health_alert",
    summary: `Connector health alert: ${result.connectorKey} → ${result.status}`,
    actor: "ai",
  });
}

/* ------------------------------------------------------------------ */
/* Scheduler integration point.                                         */
/*                                                                      */
/* The scheduler track invokes runHealthChecks() on its own cron. This  */
/* module owns no timers. It never throws: per-connection failures are  */
/* recorded as `unknown` rows and counted in the summary.               */
/* ------------------------------------------------------------------ */

export interface HealthRunSummary {
  checked: number;
  unknown: number;
  byStatus: Record<HealthStatus, number>;
  /** Connection ids that could not be evaluated (row missing, not an error). */
  skipped: string[];
}

export async function runHealthChecks(
  opts: { workspaceId?: string; fetchImpl?: CheckDeps["fetchImpl"] } = {},
): Promise<HealthRunSummary> {
  const summary: HealthRunSummary = {
    checked: 0,
    unknown: 0,
    byStatus: { healthy: 0, degraded: 0, needs_reauth: 0, error: 0, unknown: 0 },
    skipped: [],
  };
  const connections = await prisma.connectorConnection.findMany({
    where: opts.workspaceId ? { workspaceId: opts.workspaceId } : undefined,
    select: { id: true },
    orderBy: { connectedAt: "asc" },
  });
  for (const c of connections) {
    const result = await checkConnection(c.id, { fetchImpl: opts.fetchImpl }).catch(() => null);
    if (!result) {
      summary.skipped.push(c.id);
      continue;
    }
    summary.checked += 1;
    summary.byStatus[result.status] += 1;
    if (result.status === "unknown") summary.unknown += 1;
  }
  return summary;
}

/**
 * Record a real, successful provider interaction (OAuth callback, manual
 * refresh, skill-run tool call). Lets api_key connections graduate from
 * `unknown` to `healthy` honestly — only after evidence.
 */
export async function recordSuccessfulSync(connectionId: string): Promise<void> {
  const connection = await prisma.connectorConnection
    .findUnique({ where: { id: connectionId }, select: { workspaceId: true } })
    .catch(() => null);
  if (!connection) return;
  await prisma.connectorHealth
    .upsert({
      where: { connectionId },
      create: {
        connectionId,
        workspaceId: connection.workspaceId,
        status: "unknown",
        lastCheckAt: new Date(0),
        lastSuccessAt: new Date(),
      },
      update: { lastSuccessAt: new Date() },
    })
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* connector_error event payload for the scheduler track's event bus.   */
/* The scheduler's "connector error" event trigger consumes this shape. */
/* ------------------------------------------------------------------ */

export interface ConnectorErrorEvent {
  type: "connector_error";
  workspaceId: string;
  connectionId: string;
  connectorKey: string;
  status: "needs_reauth" | "error";
  errorCode: HealthErrorCode;
  consecutiveErrors: number;
  occurredAt: string; // ISO timestamp
  fixHint: string;
}

export function toConnectorErrorEvent(result: HealthCheckResult, consecutiveErrors: number): ConnectorErrorEvent | null {
  if (result.status !== "needs_reauth" && result.status !== "error") return null;
  return {
    type: "connector_error",
    workspaceId: result.workspaceId,
    connectionId: result.connectionId,
    connectorKey: result.connectorKey,
    status: result.status,
    errorCode: result.errorCode ?? "unknown_error",
    consecutiveErrors,
    occurredAt: result.lastCheckAt.toISOString(),
    fixHint: result.fixHint ?? FIX_HINTS.unknown_error,
  };
}

/* ------------------------------------------------------------------ */
/* API projection — explicit allow-list. Never a Prisma passthrough:    */
/* credential material cannot cross into a response by accident.        */
/* ------------------------------------------------------------------ */

export interface HealthPayload {
  connectionId: string;
  connectorKey: string;
  displayName: string;
  /** Non-sensitive display label from connection meta (account email, label). */
  connectionLabel: string | null;
  authType: "oauth2" | "api_key" | "none";
  connectionStatus: string;
  status: HealthStatus;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  errorCode: HealthErrorCode | null;
  fixHint: string | null;
  quota: { used: number | null; limit: number | null } | null;
  liveCheck: boolean;
  label: string | null;
}

export function serializeHealth(
  connection: {
    id: string;
    connectorKey: string;
    status: string;
    meta: unknown;
  },
  health: {
    status: HealthStatus;
    lastCheckAt: Date;
    lastSuccessAt: Date | null;
    lastError: string | null;
    quotaUsed: number | null;
    quotaLimit: number | null;
    /** Honest human label for `unknown` states (from the checker). */
    honestLabel?: string | null;
  } | null,
): HealthPayload {
  let displayName = connection.connectorKey;
  let authType: HealthPayload["authType"] = "none";
  try {
    const meta = getBuiltinMeta(connection.connectorKey);
    displayName = meta.displayName;
    authType = meta.authType === "oauth2" ? "oauth2" : meta.authType === "api_key" ? "api_key" : "none";
  } catch {
    /* custom connector: keep key */
  }
  const quota =
    health && (health.quotaUsed != null || health.quotaLimit != null)
      ? { used: health.quotaUsed, limit: health.quotaLimit }
      : readQuota(connection.meta).used != null || readQuota(connection.meta).limit != null
        ? { used: readQuota(connection.meta).used, limit: readQuota(connection.meta).limit }
        : null;
  const errorCode =
    health?.lastError && (HEALTH_ERROR_CODES as readonly string[]).includes(health.lastError)
      ? (health.lastError as HealthErrorCode)
      : null;
  const metaObj = (connection.meta ?? {}) as Record<string, unknown>;
  const connectionLabel =
    typeof metaObj.label === "string" && metaObj.label
      ? metaObj.label
      : typeof metaObj.email === "string" && metaObj.email
        ? metaObj.email
        : typeof metaObj.account === "string" && metaObj.account
          ? metaObj.account
          : null;
  return {
    connectionId: connection.id,
    connectorKey: connection.connectorKey,
    displayName,
    connectionLabel,
    authType,
    connectionStatus: connection.status,
    status: health?.status ?? "unknown",
    lastCheckAt: health?.lastCheckAt.toISOString() ?? null,
    lastSuccessAt: health?.lastSuccessAt?.toISOString() ?? null,
    errorCode,
    fixHint: errorCode ? FIX_HINTS[errorCode] : null,
    quota,
    liveCheck: !MOCK_ONLY_ADAPTER_KEYS.has(connection.connectorKey),
    label:
      health?.honestLabel ??
      (!health && MOCK_ONLY_ADAPTER_KEYS.has(connection.connectorKey)
        ? "Live check unavailable — mock adapter (no live provider wiring yet)."
        : null),
  };
}
