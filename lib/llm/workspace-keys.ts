// ShapesOS — Phase 15.1: per-workspace model keys (BYOK for Anthropic / OpenAI).
//
// A workspace may bring its own Anthropic and/or OpenAI key. The key lives in
// the EXISTING vault (lib/vault/workspace-credential.ts → connector_connections
// + connector_credentials, encrypted with secrets()), one connection per
// family per workspace (connectorKey "byok-anthropic" / "byok-openai"). Rules:
//   - validated with ONE cheap call before it is stored (GET /v1/models on
//     the provider — free, no tokens); an invalid key is never saved;
//   - NEVER returned to any client and never logged: status() returns only
//     booleans, who added it and when (no prefix, no last four);
//   - the router uses it in place of the platform key for that family
//     (lib/llm/router.ts resolveWorkload({ workspaceKeys })) and the usage
//     row is keySource "workspace" at 0 credits (lib/llm/usage.ts);
//   - zero-retention / block-list rules apply to BYOK exactly as to platform
//     keys — the key changes who pays, never which models are routable.
// Server-only (imports the database).

import {
  loadWorkspaceCredentials,
  removeWorkspaceCredential,
  storeWorkspaceCredential,
  workspaceCredentialMeta,
} from "@/lib/vault/workspace-credential";
import { OPENAI_OFFICIAL_BASE_URL, type LlmFamily, type WorkspaceModelKeys } from "./router";

export const MODEL_KEY_FAMILIES: readonly LlmFamily[] = ["anthropic", "openai"];

/** Vault connector key per family. */
export const MODEL_KEY_CONNECTOR: Readonly<Record<LlmFamily, string>> = {
  anthropic: "byok-anthropic",
  openai: "byok-openai",
};

export const MODEL_KEY_LABEL: Readonly<Record<LlmFamily, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export function isModelKeyFamily(v: unknown): v is LlmFamily {
  return v === "anthropic" || v === "openai";
}

// ── validation (one cheap call) ─────────────────────────────────────────────

export type KeyValidation =
  | { ok: true }
  | { ok: false; reason: "invalid" | "rate_limited" | "unreachable"; message: string };

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const OPENAI_MODELS_URL = `${OPENAI_OFFICIAL_BASE_URL}/models`;
const VALIDATE_TIMEOUT_MS = 15_000;

/**
 * Validate a model key with one free call (GET /v1/models). 2xx → valid;
 * 401/403 → invalid; 429 → rate limited (not saved; try again); anything
 * else, or no answer → unreachable (not saved: an unverified key is never
 * reported as valid). The key is sent only to the provider's own host.
 */
export async function validateModelKey(
  family: LlmFamily,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: "invalid", message: "The key is empty." };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  let status: number;
  try {
    const res =
      family === "anthropic"
        ? await fetchImpl(ANTHROPIC_MODELS_URL, {
            method: "GET",
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
            signal: ctrl.signal,
          })
        : await fetchImpl(OPENAI_MODELS_URL, {
            method: "GET",
            headers: { authorization: `Bearer ${key}` },
            signal: ctrl.signal,
          });
    status = res.status;
    // Drain without reading key-bearing content into any log.
    await res.body?.cancel().catch(() => undefined);
  } catch {
    return { ok: false, reason: "unreachable", message: `Could not reach ${MODEL_KEY_LABEL[family]} to check the key. Nothing was saved.` };
  } finally {
    clearTimeout(timer);
  }
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) {
    return { ok: false, reason: "invalid", message: `${MODEL_KEY_LABEL[family]} rejected the key. Nothing was saved.` };
  }
  if (status === 429) {
    return { ok: false, reason: "rate_limited", message: `${MODEL_KEY_LABEL[family]} is rate limiting the check. Try again in a minute.` };
  }
  return { ok: false, reason: "unreachable", message: `${MODEL_KEY_LABEL[family]} answered HTTP ${status} to the check. Nothing was saved.` };
}

// ── store / remove / status ─────────────────────────────────────────────────

/** Short in-process cache so each model call does not hit the vault. */
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; keys: WorkspaceModelKeys }>();

function invalidate(workspaceId: string): void {
  cache.delete(workspaceId);
}

/** Test seam. */
export function __clearWorkspaceModelKeyCache(): void {
  cache.clear();
}

/** Store a workspace's model key (already validated by the caller). Exactly
 *  one key per family per workspace (lib/vault/workspace-credential.ts). */
export async function storeWorkspaceModelKey(
  userId: string,
  workspaceId: string,
  family: LlmFamily,
  apiKey: string,
): Promise<{ connectionId: string }> {
  const key = apiKey.trim();
  if (!key) throw new Error("API key must not be empty");
  const out = await storeWorkspaceCredential(userId, workspaceId, MODEL_KEY_CONNECTOR[family], `${MODEL_KEY_LABEL[family]} (your key)`, {
    apiKey: key,
    family,
  });
  invalidate(workspaceId);
  return out;
}

/** Remove a workspace's model key for a family. Returns how many were removed. */
export async function removeWorkspaceModelKey(workspaceId: string, family: LlmFamily): Promise<number> {
  const n = await removeWorkspaceCredential(workspaceId, MODEL_KEY_CONNECTOR[family]);
  invalidate(workspaceId);
  return n;
}

export interface ModelKeyStatus {
  family: LlmFamily;
  label: string;
  connected: boolean;
  /** ISO time the key was stored; null when none. */
  addedAt: string | null;
  /** User id of the admin who stored it; null when none. */
  addedBy: string | null;
}

/** Client-safe status: booleans, who and when — never key material. */
export async function workspaceModelKeyStatus(workspaceId: string): Promise<ModelKeyStatus[]> {
  const meta = await workspaceCredentialMeta(workspaceId, Object.values(MODEL_KEY_CONNECTOR));
  return MODEL_KEY_FAMILIES.map((family) => {
    const m = meta[MODEL_KEY_CONNECTOR[family]];
    return {
      family,
      label: MODEL_KEY_LABEL[family],
      connected: Boolean(m),
      addedAt: m?.connectedAt ?? null,
      addedBy: m?.connectedBy ?? null,
    };
  });
}

/**
 * The workspace's own model keys, decrypted (SERVER ONLY — pass straight to
 * the router; never serialise, never log). Missing / inactive / unreadable
 * credentials are simply absent (the platform key is used).
 */
export async function loadWorkspaceModelKeys(workspaceId: string, now: number = Date.now()): Promise<WorkspaceModelKeys> {
  const hit = cache.get(workspaceId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.keys;
  const payloads = await loadWorkspaceCredentials(workspaceId, Object.values(MODEL_KEY_CONNECTOR));
  const keys: WorkspaceModelKeys = {};
  for (const family of MODEL_KEY_FAMILIES) {
    const k = payloads[MODEL_KEY_CONNECTOR[family]]?.apiKey;
    if (typeof k === "string" && k.trim()) keys[family] = k.trim();
  }
  cache.set(workspaceId, { at: now, keys });
  return keys;
}
