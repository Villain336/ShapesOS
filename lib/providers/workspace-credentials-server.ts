// ShapesOS — Phase 15.1: server side of the workspace-held keys
// (Settings → Providers; /api/settings/keys). Validates, stores, tests and
// removes the credentials defined in ./workspace-credentials.ts.
//
// Security rules:
//   - a secret field is NEVER returned: list() returns only non-secret field
//     values (URLs, slugs, ids), who stored it and when;
//   - model keys are validated with one free provider call before saving;
//   - sidecar URLs are SSRF-checked (lib/safe-url.ts) before saving, and on
//     DEPLOYMENT_MODE=hosted must be https;
//   - nothing here logs a value.

import { deploymentMode } from "@/lib/billing/trial";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/safe-url";
import {
  loadWorkspaceCredentials,
  removeWorkspaceCredential,
  storeWorkspaceCredential,
  workspaceCredentialMeta,
} from "@/lib/vault/workspace-credential";
import { isModelKeyFamily, removeWorkspaceModelKey, storeWorkspaceModelKey, validateModelKey } from "@/lib/llm/workspace-keys";
import { WORKSPACE_CREDENTIALS, cleanCredentialValues, credentialDef, type WorkspaceCredentialDef } from "./workspace-credentials";

export interface CredentialView {
  id: string;
  kind: WorkspaceCredentialDef["kind"];
  label: string;
  help: string;
  connected: boolean;
  connectedAt: string | null;
  connectedBy: string | null;
  fields: Array<{ name: string; label: string; secret: boolean; type: "url" | "text"; required: boolean; placeholder?: string; value: string | null }>;
}

export class CredentialInputError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "CredentialInputError";
    this.code = code;
    this.status = status;
  }
}

/** Client-safe list: no secret ever leaves the server. */
export async function listWorkspaceCredentials(workspaceId: string): Promise<CredentialView[]> {
  const keys = WORKSPACE_CREDENTIALS.map((d) => d.connectorKey);
  const [meta, payloads] = await Promise.all([
    workspaceCredentialMeta(workspaceId, keys),
    loadWorkspaceCredentials(workspaceId, keys),
  ]);
  return WORKSPACE_CREDENTIALS.map((d) => {
    const m = meta[d.connectorKey];
    const p = payloads[d.connectorKey] ?? {};
    return {
      id: d.id,
      kind: d.kind,
      label: d.label,
      help: d.help,
      connected: Boolean(m),
      connectedAt: m?.connectedAt ?? null,
      connectedBy: m?.connectedBy ?? null,
      fields: d.fields.map((f) => ({
        name: f.name,
        label: f.label,
        secret: f.secret,
        type: f.type,
        required: f.required,
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
        // Secrets are write-only; non-secret settings are shown back.
        value: f.secret ? null : typeof p[f.name] === "string" ? (p[f.name] as string) : null,
      })),
    };
  });
}

type FetchLike = typeof fetch;

async function checkUrls(def: WorkspaceCredentialDef, payload: Record<string, string>, opts: { resolve?: (h: string) => Promise<string[]> }) {
  const hosted = deploymentMode() === "hosted";
  for (const f of def.fields) {
    if (f.type !== "url" || !payload[f.name]) continue;
    let safe: string;
    try {
      safe = await assertSafeUrl(payload[f.name], { resolve: opts.resolve });
    } catch (e) {
      throw new CredentialInputError("unsafe_url", `${f.label}: ${e instanceof UnsafeUrlError ? e.message : "not allowed."}`);
    }
    if (hosted && !safe.startsWith("https://")) {
      throw new CredentialInputError("https_required", `${f.label} must use https on hosted ShapesOS.`);
    }
    payload[f.name] = safe.replace(/\/+$/, "");
  }
}

/**
 * Validate and store a workspace credential. Model keys are checked with one
 * free provider call first (an invalid key is never saved).
 */
export async function saveWorkspaceCredential(
  args: { workspaceId: string; userId: string; id: string; values: Record<string, unknown> },
  deps: { fetchImpl?: FetchLike; resolve?: (h: string) => Promise<string[]> } = {},
): Promise<{ id: string }> {
  const def = credentialDef(args.id);
  if (!def) throw new CredentialInputError("unknown_credential", "Unknown key type.", 404);
  const cleaned = cleanCredentialValues(def, args.values);
  if (!cleaned.ok) throw new CredentialInputError("invalid", cleaned.error);
  const payload = cleaned.payload;

  if (def.kind === "model") {
    const family = def.id.slice("model:".length);
    if (!isModelKeyFamily(family)) throw new CredentialInputError("unknown_credential", "Unknown model provider.", 404);
    const check = await validateModelKey(family, payload.apiKey, deps.fetchImpl);
    if (!check.ok) {
      throw new CredentialInputError(
        check.reason === "invalid" ? "invalid_key" : check.reason,
        check.message,
        check.reason === "invalid" ? 422 : check.reason === "rate_limited" ? 429 : 502,
      );
    }
    await storeWorkspaceModelKey(args.userId, args.workspaceId, family, payload.apiKey);
    return { id: def.id };
  }

  if (def.kind === "sidecar") await checkUrls(def, payload, deps);
  if (def.kind === "outreach") {
    const ids = payload.relayCampaignIds.split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length === 0) throw new CredentialInputError("invalid", "Add at least one relay campaign ID.");
    payload.relayCampaignIds = ids.join(",");
  }
  await storeWorkspaceCredential(args.userId, args.workspaceId, def.connectorKey, `${def.label} (your own)`, payload);
  return { id: def.id };
}

export async function deleteWorkspaceCredential(workspaceId: string, id: string): Promise<number> {
  const def = credentialDef(id);
  if (!def) throw new CredentialInputError("unknown_credential", "Unknown key type.", 404);
  if (def.kind === "model") {
    const family = def.id.slice("model:".length);
    if (isModelKeyFamily(family)) return removeWorkspaceModelKey(workspaceId, family);
  }
  return removeWorkspaceCredential(workspaceId, def.connectorKey);
}

export type TestResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Re-check a stored credential: a model key with one free provider call; a
 * sidecar URL with the SSRF check and one request to its address. The
 * secret never leaves the server.
 */
export async function testWorkspaceCredential(
  workspaceId: string,
  id: string,
  deps: { fetchImpl?: FetchLike; resolve?: (h: string) => Promise<string[]> } = {},
): Promise<TestResult> {
  const def = credentialDef(id);
  if (!def) throw new CredentialInputError("unknown_credential", "Unknown key type.", 404);
  const stored = (await loadWorkspaceCredentials(workspaceId, [def.connectorKey]))[def.connectorKey];
  if (!stored) return { ok: false, message: `No ${def.label} key is saved for this workspace.` };
  if (def.kind === "model") {
    const family = def.id.slice("model:".length);
    if (!isModelKeyFamily(family) || typeof stored.apiKey !== "string") return { ok: false, message: "The saved key is unreadable — add it again." };
    const check = await validateModelKey(family, stored.apiKey, deps.fetchImpl);
    return check.ok ? { ok: true, message: `${def.label} accepted your key.` } : { ok: false, message: check.message };
  }
  if (def.kind === "sidecar") {
    const urlField = def.fields.find((f) => f.type === "url");
    const raw = urlField ? stored[urlField.name] : null;
    if (typeof raw !== "string") return { ok: false, message: "No URL is saved." };
    let safe: string;
    try {
      safe = await assertSafeUrl(raw, { resolve: deps.resolve });
    } catch (e) {
      return { ok: false, message: e instanceof UnsafeUrlError ? e.message : "The URL is not allowed." };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await (deps.fetchImpl ?? fetch)(safe, { method: "GET", redirect: "manual", signal: ctrl.signal }).finally(() => clearTimeout(t));
      await res.body?.cancel().catch(() => undefined);
      return res.status < 500
        ? { ok: true, message: `${def.label} answered (HTTP ${res.status}).` }
        : { ok: false, message: `${def.label} answered HTTP ${res.status}.` };
    } catch {
      return { ok: false, message: `Could not reach ${def.label} at that URL.` };
    }
  }
  return { ok: true, message: `${def.label} settings are saved. They are checked the next time a sequence sends.` };
}
