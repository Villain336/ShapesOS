// ShapesOS — Phase 8: provider access material a sandbox needs to be
// reattached from ANOTHER process (the worker creates the sandbox, the web
// app serves its preview). Stored on agent_run_sandboxes.secret_enc as a
// secrets() envelope; never sent to a client, never logged.

import type { Sandbox, SandboxProvider } from "./types";

/** A sandbox that has something worth persisting (e.g. E2B's traffic token). */
export interface SecretCarrier {
  persistSecret(): string | null;
}

/** A provider that can reattach with that persisted secret. */
export interface SecretAwareProvider {
  getWithSecret(id: string, secret: string | null): Promise<Sandbox | null>;
}

export function carriesSecret(s: Sandbox): s is Sandbox & SecretCarrier {
  return typeof (s as Partial<SecretCarrier>).persistSecret === "function";
}

export function acceptsSecret(p: SandboxProvider): p is SandboxProvider & SecretAwareProvider {
  return typeof (p as Partial<SecretAwareProvider>).getWithSecret === "function";
}
