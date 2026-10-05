// ShapesOS — Phase 15.1: sidecar tenancy (Postiz, Listmonk, Plane, Ghost,
// Documenso, GrowthBook, Umami, Chatwoot).
//
// Each sidecar reads ONE env URL + key for every workspace. One shared
// instance is not tenant-safe, so:
//   - a workspace may configure its OWN instance (URL + key, vault-stored:
//     lib/vault/workspace-credential.ts, Settings → Providers);
//   - DEPLOYMENT_MODE=hosted: the shared env instance is REFUSED unless the
//     workspace configured its own — the sidecar reads as "not configured"
//     and says "connect your own …";
//   - self-hosted: env is used exactly as before (a workspace override, when
//     present, wins).
//
// Mechanism: every sidecar module reads its config through sidecarEnv(key)
// instead of process.env. Route handlers run their sidecar calls inside
// withWorkspaceSidecars(workspaceId, fn), which loads that workspace's
// overrides into an AsyncLocalStorage scope. Outside any scope the decision
// is the same as a workspace WITHOUT an override — so on hosted an unwrapped
// caller can never reach the shared instance (fail closed).
//
// Publisher selection is NOT decided here (lib/social/provider.ts keeps
// choosing the publisher); this only gates the shared Postiz instance.

import { AsyncLocalStorage } from "node:async_hooks";
import { deploymentMode, type DeploymentMode } from "@/lib/billing/trial";
import {
  SIDECAR_KEYS,
  sidecarDef,
  sidecarEnvVars,
  type SidecarKey,
} from "@/lib/providers/workspace-credentials";

export type { SidecarKey };
export { SIDECAR_KEYS };

type EnvLike = Record<string, string | undefined>;

/** A workspace's own sidecar config, already mapped to env-var names. */
export type SidecarOverrides = Partial<Record<SidecarKey, Record<string, string>>>;

interface Scope {
  workspaceId: string;
  overrides: SidecarOverrides;
}

const als = new AsyncLocalStorage<Scope>();

export type SidecarDecision = "workspace" | "env" | "refused";

/**
 * Pure: where a sidecar's config comes from. A workspace override always
 * wins; otherwise hosted refuses the shared env instance and self-hosted
 * uses it.
 */
export function sidecarDecision(args: { mode: DeploymentMode; hasOverride: boolean }): SidecarDecision {
  if (args.hasOverride) return "workspace";
  return args.mode === "hosted" ? "refused" : "env";
}

/** The plain-language refusal a hosted workspace sees. */
export function sidecarRefusalMessage(key: SidecarKey): string {
  const label = sidecarDef(key).label;
  return `${label} isn't connected for this workspace. On hosted ShapesOS a shared ${label} isn't available — connect your own ${label} in Settings → Providers.`;
}

/** Map a stored payload (field names) onto the sidecar's env-var names. */
export function overrideToEnv(key: SidecarKey, payload: Record<string, unknown>): Record<string, string> {
  const def = sidecarDef(key);
  const out: Record<string, string> = { ...(def.fixedEnv ?? {}) };
  for (const f of def.fields) {
    const v = payload[f.name];
    if (f.env && typeof v === "string" && v.trim()) out[f.env] = v.trim();
  }
  return out;
}

/**
 * The env a sidecar module should read right now. `base` is process.env
 * (tests pass their own). Never mixes sources: a workspace override
 * replaces ALL of the sidecar's vars; a refusal blanks all of them.
 */
export function sidecarEnv(key: SidecarKey, base: EnvLike = process.env): EnvLike {
  const scope = als.getStore();
  const override = scope?.overrides[key];
  const decision = sidecarDecision({ mode: deploymentMode(base as NodeJS.ProcessEnv), hasOverride: Boolean(override) });
  if (decision === "env") return base;
  const out: EnvLike = { ...base };
  for (const v of sidecarEnvVars(key)) delete out[v];
  if (decision === "workspace" && override) Object.assign(out, override);
  return out;
}

/** Where `key` reads from in the current scope (for status UIs and errors). */
export function currentSidecarSource(key: SidecarKey, base: EnvLike = process.env): SidecarDecision {
  const scope = als.getStore();
  return sidecarDecision({ mode: deploymentMode(base as NodeJS.ProcessEnv), hasOverride: Boolean(scope?.overrides[key]) });
}

/** Run `fn` with explicit overrides (tests, and callers that loaded them). */
export function runWithSidecarOverrides<T>(workspaceId: string, overrides: SidecarOverrides, fn: () => T): T {
  return als.run({ workspaceId, overrides }, fn);
}

/** Load a workspace's own sidecar configs from the vault (server only). */
export async function loadSidecarOverrides(workspaceId: string): Promise<SidecarOverrides> {
  const { loadWorkspaceCredentials } = await import("@/lib/vault/workspace-credential");
  const keys = SIDECAR_KEYS.map((k) => sidecarDef(k).connectorKey);
  const payloads = await loadWorkspaceCredentials(workspaceId, keys);
  const out: SidecarOverrides = {};
  for (const k of SIDECAR_KEYS) {
    const p = payloads[sidecarDef(k).connectorKey];
    if (p) out[k] = overrideToEnv(k, p);
  }
  return out;
}

/**
 * Run `fn` with this workspace's sidecar overrides in scope. If the vault
 * cannot be read the scope is empty (hosted → refused, self-hosted → env) —
 * never another workspace's instance.
 */
export async function withWorkspaceSidecars<T>(workspaceId: string, fn: () => Promise<T> | T): Promise<T> {
  let overrides: SidecarOverrides = {};
  try {
    overrides = await loadSidecarOverrides(workspaceId);
  } catch (err) {
    console.warn(
      `[sidecars] could not load workspace ${workspaceId}'s sidecar settings (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return als.run({ workspaceId, overrides }, () => Promise.resolve(fn()));
}
