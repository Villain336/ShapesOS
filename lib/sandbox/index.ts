// ShapesOS — Phase 8: picking a sandbox provider and giving each run its
// sandbox (server-only).
//
//   getSandboxProvider()   the configured provider (SANDBOX_PROVIDER, default
//                          docker), or null when switched off / unknown
//   sandboxAvailability()  is it usable right now? (cached briefly) — the
//                          code tool group, the composer's Code chip and
//                          Settings → Providers all read this
//   sandboxForRun()        create or reattach the run's sandbox (takes the
//                          chat ToolContext): its own → its root run's (a
//                          delegated sub-agent shares it) → the newest live
//                          one on the same chat thread (an approved "yes"
//                          runs in a NEW run and must find the earlier
//                          clone) → else a new one owned by the root run
//   releaseRunSandbox()    destroy what a run owns — wired into
//                          finishAgentRun (thread-bound sandboxes are kept
//                          for the thread and end on their idle timeout) and
//                          requestAgentRunCancel (Stop always destroys)
//   liveSandboxForRun()    the live sandbox, without creating one (restore
//                          and preview routes)
//
// Nothing here runs on the host: when no provider is available the code
// tools say why and do nothing.

import type { Sandbox, SandboxProvider } from "./types";
import { sandboxConfig, type EnvLike } from "./config";
import { DockerSandboxProvider } from "./docker";
import { E2BSandboxProvider } from "./e2b";
import { DaytonaSandboxProvider } from "./daytona";
import { acceptsSecret, carriesSecret } from "./secrets";
import {
  candidateSandboxRows,
  getSandboxRow,
  insertSandboxRow,
  runLineage,
  type RunLineage,
  markSandboxDestroyed,
  replaceSandboxRow,
  touchSandboxRow,
  type SandboxRow,
} from "./store";

export type { Sandbox, SandboxProvider } from "./types";

export class SandboxUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`The code sandbox is not available: ${reason}`);
    this.name = "SandboxUnavailableError";
  }
}

let override: SandboxProvider | null | undefined;

/** Tests: force a provider (null = none); undefined restores the env choice. */
export function setSandboxProviderForTests(p: SandboxProvider | null | undefined): void {
  override = p;
  availabilityCache = null;
}

/** The configured provider, or null when sandboxes are off / misconfigured. */
export function getSandboxProvider(env: EnvLike = process.env): SandboxProvider | null {
  if (override !== undefined) return override;
  const cfg = sandboxConfig(env);
  switch (cfg.provider) {
    case "docker":
      return new DockerSandboxProvider({ config: cfg });
    case "e2b":
      return new E2BSandboxProvider({ config: cfg });
    case "daytona":
      return new DaytonaSandboxProvider({ config: cfg });
    default:
      return null;
  }
}

export type SandboxAvailability =
  | { ok: true; provider: SandboxProvider["name"] }
  | { ok: false; provider: SandboxProvider["name"] | null; reason: string };

let availabilityCache: { at: number; value: SandboxAvailability } | null = null;
const AVAILABILITY_TTL_MS = 30_000;

/** Is a sandbox provider configured and reachable? Cached for 30 s. */
export async function sandboxAvailability(opts: { fresh?: boolean } = {}): Promise<SandboxAvailability> {
  if (!opts.fresh && availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) return availabilityCache.value;
  const value = await computeAvailability();
  availabilityCache = { at: Date.now(), value };
  return value;
}

async function computeAvailability(): Promise<SandboxAvailability> {
  const cfg = sandboxConfig();
  const p = getSandboxProvider();
  if (!p) {
    return {
      ok: false,
      provider: null,
      reason: cfg.invalidProvider
        ? `SANDBOX_PROVIDER=${cfg.invalidProvider} is not a provider (use docker, e2b or daytona).`
        : "Sandboxes are switched off (SANDBOX_PROVIDER=off).",
    };
  }
  try {
    const a = await p.available();
    return a.ok ? { ok: true, provider: p.name } : { ok: false, provider: p.name, reason: a.reason };
  } catch (err) {
    return { ok: false, provider: p.name, reason: err instanceof Error ? err.message : "The provider check failed." };
  }
}

function providerByName(name: string): SandboxProvider | null {
  const p = getSandboxProvider();
  if (p && p.name === name) return p;
  if (override !== undefined) return null;
  const cfg = sandboxConfig();
  // A row made under a different provider setting can still be reattached
  // (and destroyed) while that provider's credentials remain configured.
  if (name === "docker") return new DockerSandboxProvider({ config: cfg });
  if (name === "e2b") return new E2BSandboxProvider({ config: cfg });
  if (name === "daytona") return new DaytonaSandboxProvider({ config: cfg });
  return null;
}

async function decryptSecret(enc: string | null): Promise<string | null> {
  if (!enc) return null;
  try {
    const { secrets } = await import("@/lib/secrets");
    return secrets().decrypt(enc);
  } catch {
    return null;
  }
}

async function encryptSecret(s: Sandbox): Promise<string | null> {
  if (!carriesSecret(s)) return null;
  const plain = s.persistSecret();
  if (!plain) return null;
  const { secrets } = await import("@/lib/secrets");
  return secrets().encrypt(plain);
}

async function attach(row: SandboxRow): Promise<Sandbox | null> {
  const p = providerByName(row.provider);
  if (!p) return null;
  try {
    if (acceptsSecret(p)) return await p.getWithSecret(row.sandboxId, await decryptSecret(row.secretEnc));
    return await p.get(row.sandboxId);
  } catch {
    return null;
  }
}

async function note(workspaceId: string, runId: string, summary: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { appendAgentRunEvent } = await import("@/lib/agents/runs/service");
    await appendAgentRunEvent(workspaceId, runId, { type: "note", summary, payload });
  } catch {
    // The timeline is best effort; the sandbox itself is not.
  }
}

export interface LiveSandbox {
  sandbox: Sandbox;
  /** The run whose row owns the sandbox (root run, or an earlier run of the chat thread). */
  ownerRunId: string;
  row: SandboxRow;
}

/**
 * Who a sandbox request is for. Accepts the chat ToolContext as-is (extra
 * fields ignored). The run's root and chat thread are read from the
 * database — never trusted from the caller.
 */
export interface SandboxRunRef {
  workspaceId: string;
  runId?: string | null;
  /** Accepted for the ToolContext shape; the database's value is used. */
  threadId?: string | null;
  /** Accepted for the ToolContext shape; the database's value is used. */
  parentRunId?: string | null;
}

/**
 * The run's live sandbox, without creating one: its own, else its root
 * run's (delegated sub-agents share it), else the newest live one on the
 * same chat thread. Rows whose sandbox has gone (idle timeout) are closed.
 */
export async function liveSandboxForRun(input: SandboxRunRef): Promise<LiveSandbox | null> {
  if (!input.workspaceId || !input.runId) return null;
  const lineage = await runLineage(input.workspaceId, input.runId);
  if (!lineage) return null;
  for (const row of await candidateSandboxRows(input.workspaceId, lineage)) {
    const sb = await attach(row);
    if (sb) return { sandbox: sb, ownerRunId: row.runId, row };
    await markSandboxDestroyed(input.workspaceId, row.runId);
  }
  return null;
}

const inflight = new Map<string, Promise<Sandbox>>();

/**
 * Create or reattach the sandbox for an agent run. Takes the chat
 * ToolContext shape ({ workspaceId, runId, threadId?, parentRunId?, … }).
 * Reuse order: the run's own sandbox → its root run's → the newest live one
 * on its chat thread; otherwise a new one, owned by the ROOT run. Throws
 * SandboxUnavailableError (with the reason) when no provider can serve.
 */
export function sandboxForRun(input: SandboxRunRef): Promise<Sandbox> {
  if (!input.workspaceId || !input.runId) return Promise.reject(new SandboxUnavailableError("code tools only run inside an agent run."));
  const ref = { workspaceId: input.workspaceId, runId: input.runId };
  return runLineage(ref.workspaceId, ref.runId).then((lineage) => {
    if (!lineage) throw new SandboxUnavailableError("the run was not found in this workspace.");
    // One creation at a time per thread (or per root run without a thread).
    const key = `${ref.workspaceId}:${lineage.threadId ? `t:${lineage.threadId}` : `r:${lineage.rootRunId}`}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = resolveSandbox(ref.workspaceId, lineage).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  });
}

async function resolveSandbox(workspaceId: string, lineage: RunLineage): Promise<Sandbox> {
  const live = await liveSandboxForRun({ workspaceId, runId: lineage.runId });
  if (live) {
    await touchSandboxRow(workspaceId, live.ownerRunId).catch(() => undefined);
    return live.sandbox;
  }
  const avail = await sandboxAvailability();
  if (!avail.ok) throw new SandboxUnavailableError(avail.reason);
  const provider = getSandboxProvider();
  if (!provider) throw new SandboxUnavailableError("no sandbox provider is configured.");
  // Phase 15.2: a paid sandbox (E2B / Daytona) is not started for a capped
  // workspace — its minutes are charged in credits when it ends.
  const { isPaidSandboxProvider } = await import("./metering");
  if (isPaidSandboxProvider(provider.name)) {
    const { checkCap } = await import("@/lib/metering/service");
    const cap = await checkCap(workspaceId);
    if (!cap.allowed) {
      throw new SandboxUnavailableError(
        `the workspace's credit cap is reached (${cap.used.toLocaleString()} of ${cap.capCredits.toLocaleString()} credits used) — raise the cap or add credits in Settings → Usage.`,
      );
    }
  }
  const owner = lineage.rootRunId;
  const sb = await provider.create({ workspaceId, runId: owner });
  const secretEnc = await encryptSecret(sb).catch(() => null);
  const prior = await getSandboxRow(workspaceId, owner);
  const saved = prior
    ? await replaceSandboxRow(workspaceId, owner, { provider: sb.provider, sandboxId: sb.id, secretEnc })
    : (await insertSandboxRow({ workspaceId, runId: owner, provider: sb.provider, sandboxId: sb.id, secretEnc })) !== null;
  if (!saved) {
    // Another process won the race: use its sandbox, drop ours.
    await sb.destroy().catch(() => undefined);
    const again = await liveSandboxForRun({ workspaceId, runId: lineage.runId });
    if (again) return again.sandbox;
    throw new SandboxUnavailableError("another worker is starting this run's sandbox — try again.");
  }
  await note(workspaceId, lineage.runId, prior ? "Started a new code sandbox (the last one idled out)" : "Started a code sandbox", {
    kind: "sandbox.created",
    provider: sb.provider,
    sandboxId: sb.id,
    ownerRunId: owner,
  });
  return sb;
}

/**
 * Destroy the sandbox this run OWNS (never one it borrowed). Idempotent;
 * never throws. A sandbox bound to a chat thread outlives the run that made
 * it — the next turn on the thread (an approved push, a follow-up) reuses
 * it — so a normal run end leaves it to its idle timeout; Stop (`force`)
 * destroys it.
 */
export async function releaseRunSandbox(
  workspaceId: string,
  runId: string,
  reason = "run finished",
  opts: { force?: boolean } = {},
): Promise<boolean> {
  try {
    const row = await getSandboxRow(workspaceId, runId);
    if (!row || row.status !== "active") return false;
    if (!opts.force) {
      const lineage = await runLineage(workspaceId, runId);
      if (lineage?.threadId) {
        await note(workspaceId, runId, "Code sandbox kept for this chat thread (ends when idle)", {
          kind: "sandbox.kept",
          sandboxId: row.sandboxId,
          threadId: lineage.threadId,
        });
        return false;
      }
    }
    const sb = await attach(row);
    if (sb) await sb.destroy().catch(() => undefined);
    const changed = await markSandboxDestroyed(workspaceId, runId);
    if (changed) await note(workspaceId, runId, `Code sandbox destroyed (${reason})`, { kind: "sandbox.destroyed", sandboxId: row.sandboxId, reason });
    return changed;
  } catch {
    return false;
  }
}
