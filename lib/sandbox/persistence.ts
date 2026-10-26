// ShapesOS — sandbox persistence capability (pause / resume / auto-pause).
//
// NEW exports only (lib/sandbox/types.ts is shared by parallel workstreams
// and must not change): the pluggable providers stay on the base Sandbox
// contract; lifecycle control is an OPTIONAL capability detected with
// asPauseCapable(). Providers that cannot pause (Docker today) simply do
// not implement it and callers fall back to destroy-on-idle.
//
// Cost semantics (docs-backed, NOT a contractual SLA - E2B docs
// https://docs.e2b.dev/billing + /sandbox/persistence, fetched 2026-10-25):
// billing runs per-second ONLY while a sandbox is running; a paused sandbox
// bills nothing and is kept indefinitely with no automatic deletion.
//
// Owner constraint (2026-10-25, bounded $1 dev-test grant): autoResume on
// arbitrary inbound traffic is NEVER enabled - a paused sandbox wakes only
// through an explicit resume() call from ShapesOS, so spend cannot be
// triggered by outside traffic.

import type { Sandbox, SandboxCreateOptions } from "./types";

/** Lifecycle knobs for a sandbox meant to survive between work sessions. */
export interface PersistentSandboxOptions {
  /**
   * Provider-side auto-pause on idle timeout (E2B `autoPause`): at the
   * timeout the sandbox PAUSES with state preserved instead of being
   * killed. Billing stops at the pause. Full memory snapshot
   * (E2B `autoPauseMemory` default) so resume is warm, never a cold boot.
   */
  autoPause: boolean;
  /**
   * Provider running TTL in seconds (E2B `timeout`): the sandbox pauses
   * when this expires. It is a RUNNING-time TTL refreshed by activity
   * (commands / connect calls), NOT a user-idle detector - a busy sandbox
   * never hits it and a heartbeat could extend it indefinitely. An
   * absolute spend ceiling (created-at-based hard stop) must be enforced
   * separately by the app; this is only the fallback bound for a sandbox
   * that goes quiet.
   */
  timeoutSeconds: number;
}

export interface PauseCapable {
  /**
   * Suspend the sandbox, preserving filesystem + memory. Idempotent in
   * effect: pausing an already-paused sandbox is a no-op success.
   */
  pause(): Promise<void>;
  /**
   * Wake a paused sandbox (E2B POST /v2/sandboxes/{id}/connect - resumes if
   * paused, extends TTL only; never shortens it). timeoutSeconds sets the
   * next idle-pause deadline, defaulting to the provider's own default.
   */
  resume(opts?: { timeoutSeconds?: number }): Promise<void>;
}

/** Narrow a base Sandbox to the optional persistence capability. */
export function asPauseCapable(sb: Sandbox): (Sandbox & PauseCapable) | null {
  const maybe = sb as Sandbox & Partial<PauseCapable>;
  return typeof maybe.pause === "function" && typeof maybe.resume === "function"
    ? (maybe as Sandbox & PauseCapable)
    : null;
}

/** A provider that can create persistent (pausable) sandboxes. */
export interface PersistentSandboxProvider {
  createPersistent(
    opts: SandboxCreateOptions,
    persist: PersistentSandboxOptions,
  ): Promise<Sandbox & PauseCapable>;
}

/** Narrow a provider to the optional persistent-create capability. */
export function asPersistentProvider(p: unknown): PersistentSandboxProvider | null {
  const maybe = p as Partial<PersistentSandboxProvider>;
  return typeof maybe?.createPersistent === "function" ? (maybe as PersistentSandboxProvider) : null;
}
