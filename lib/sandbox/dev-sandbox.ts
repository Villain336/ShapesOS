// ShapesOS — persistent per-project dev sandboxes (in-product browser "Dev
// preview" v1, server-only). Unlike run-scoped AgentRunSandbox rows, a
// ProjectDevSandbox SURVIVES agent runs: the provider pauses it at the
// running TTL (refreshed by activity - NOT a user-idle detector) and this
// service wakes it only via explicit resume. autoResume on inbound traffic
// is never enabled (owner constraint, 2026-10-25).
//
// Every read and write goes through withWorkspaceScope(): the table is
// FORCE RLS on app.workspace_id like every tenant table. project_id is
// unique - one dev sandbox per project.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getSandboxProvider } from "./index";
import { asPauseCapable, asPersistentProvider, type PauseCapable, type PersistentSandboxOptions } from "./persistence";
import type { Sandbox } from "./types";

/** Providers that can say "paused but resumable" vs "gone" (E2B). get()
 * alone can't - it returns null for both. */
interface StateAwareProvider {
  sandboxState(id: string): Promise<"running" | "paused" | "gone">;
  attachPaused(id: string, secret: string | null): Promise<(Sandbox & PauseCapable) | null>;
}
function asStateAware(p: unknown): StateAwareProvider | null {
  const o = p as Partial<StateAwareProvider> | null;
  return o && typeof o.sandboxState === "function" && typeof o.attachPaused === "function" ? (o as StateAwareProvider) : null;
}

export type DevSandboxStatus = "creating" | "running" | "paused" | "destroyed";

export interface DevSandboxRow {
  id: string;
  workspaceId: string;
  projectId: string;
  provider: string;
  sandboxId: string;
  status: string;
  /** "production" | "test" - which bounds this sandbox was created under. */
  mode: string;
  /** Monotonic: 1 at insert, +1 per revive-after-destroy. */
  createCount: number;
  ttlSeconds: number;
  exposedPorts: number[];
  secretEnc: string | null;
  createdAt: Date;
  lastResumedAt: Date | null;
  pausedAt: Date | null;
  destroyedAt: Date | null;
}

export async function getDevSandboxRow(workspaceId: string, projectId: string): Promise<DevSandboxRow | null> {
  return withWorkspaceScope(workspaceId, (tx) => tx.projectDevSandbox.findFirst({ where: { workspaceId, projectId } }));
}

/** Insert the project's sandbox row; null when one already exists (race lost). */
export async function insertDevSandboxRow(input: {
  workspaceId: string;
  projectId: string;
  provider: string;
  sandboxId: string;
  ttlSeconds: number;
  mode?: string;
  secretEnc?: string | null;
}): Promise<DevSandboxRow | null> {
  try {
    return await withWorkspaceScope(input.workspaceId, (tx) =>
      tx.projectDevSandbox.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          provider: input.provider,
          sandboxId: input.sandboxId,
          ttlSeconds: input.ttlSeconds,
          mode: input.mode ?? "production",
          secretEnc: input.secretEnc ?? null,
          status: "running",
          lastResumedAt: new Date(),
        },
      }),
    );
  } catch (err) {
    // Duck-typed: PrismaClientKnownRequestError is type-only at runtime.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
      // Unique project_id: a DESTROYED row still holds the key. Revive it in
      // place (conditional, so two restarts can't both win); a live conflict
      // is a real create race - the caller destroys its duplicate.
      const n = await withWorkspaceScope(input.workspaceId, (tx) =>
        tx.projectDevSandbox.updateMany({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, status: "destroyed" },
          data: {
            provider: input.provider,
            sandboxId: input.sandboxId,
            ttlSeconds: input.ttlSeconds,
            mode: input.mode ?? "production",
            secretEnc: input.secretEnc ?? null,
            status: "running",
            createdAt: new Date(),
            lastResumedAt: new Date(),
            pausedAt: null,
            destroyedAt: null,
            createCount: { increment: 1 },
          },
        }),
      );
      if (n.count > 0) return getDevSandboxRow(input.workspaceId, input.projectId);
      return null;
    }
    throw err;
  }
}

/** Conditional status transition - a sweeper and a user action can't race. */
async function transition(
  workspaceId: string,
  projectId: string,
  from: DevSandboxStatus[],
  to: DevSandboxStatus,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const n = await withWorkspaceScope(workspaceId, (tx) =>
    tx.projectDevSandbox.updateMany({ where: { workspaceId, projectId, status: { in: from } }, data: { status: to, ...extra } }),
  );
  return n.count > 0;
}

export const markDevSandboxPaused = (workspaceId: string, projectId: string) =>
  transition(workspaceId, projectId, ["running"], "paused", { pausedAt: new Date() });

export const markDevSandboxRunning = (workspaceId: string, projectId: string) =>
  transition(workspaceId, projectId, ["paused", "creating"], "running", { lastResumedAt: new Date(), pausedAt: null });

export const markDevSandboxDestroyed = (workspaceId: string, projectId: string) =>
  transition(workspaceId, projectId, ["creating", "running", "paused"], "destroyed", { destroyedAt: new Date() });

export const touchDevSandboxPorts = (workspaceId: string, projectId: string, ports: number[]) =>
  withWorkspaceScope(workspaceId, (tx) =>
    tx.projectDevSandbox.updateMany({ where: { workspaceId, projectId }, data: { exposedPorts: ports } }),
  );

/** Every live dev sandbox in the workspace (sweeper + browser surface). */
export async function listLiveDevSandboxes(workspaceId: string): Promise<DevSandboxRow[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.projectDevSandbox.findMany({ where: { workspaceId, status: { in: ["creating", "running", "paused"] } } }),
  );
}

/** Default lifecycle knobs for the preview: quiet for 15 minutes -> pause. */
export const DEV_SANDBOX_DEFAULT_TTL_SECONDS = 900;

export type EnsureResult =
  | { ok: true; sandbox: Sandbox & PauseCapable; row: DevSandboxRow; woke: "created" | "resumed" | "already-running" }
  | { ok: false; reason: string };

/**
 * Get the project's dev sandbox RUNNING: resume a paused one (explicit
 * wake - the only path, never traffic-driven), create when missing or
 * destroyed. Returns the reason plainly when the provider can't pause
 * (Docker) or isn't available - never fakes a sandbox.
 */
export async function ensureDevSandbox(
  workspaceId: string,
  projectId: string,
  opts: { bounds?: DevSandboxBounds } = {},
): Promise<EnsureResult> {
  const bounds = opts.bounds ?? PRODUCTION_BOUNDS;
  const provider = getSandboxProvider();
  const persistent = provider ? asPersistentProvider(provider) : null;
  if (!provider || !persistent) {
    const name = provider?.name ?? "unconfigured";
    return { ok: false, reason: `The ${name} sandbox provider can't pause sandboxes; dev previews need a persistent provider (E2B).` };
  }
  const avail = await provider.available();
  if (!avail.ok) return { ok: false, reason: avail.reason };

  // Concurrency bound: counted BEFORE any provider call, workspace-wide.
  const liveRows = await listLiveDevSandboxes(workspaceId);
  const row = liveRows.find((r) => r.projectId === projectId) ?? null;
  if (!row && liveRows.length >= bounds.maxConcurrentPerWorkspace) {
    return { ok: false, reason: `This workspace already has ${liveRows.length} live dev preview(s) (limit ${bounds.maxConcurrentPerWorkspace}). Pause or let one expire first.` };
  }
  // Aggregate test bound: total creates across rows (destroyed included),
  // so a destroy/recreate loop can't restart the meter.
  if (!row && bounds.mode === "test" && (await countTestDevSandboxes(workspaceId)) >= TEST_MAX_CREATES_PER_WORKSPACE) {
    return { ok: false, reason: `The authorized test allows ${TEST_MAX_CREATES_PER_WORKSPACE} dev sandbox(es) in total for this workspace; that bound is reached.` };
  }
  if (row && row.status === "running") {
    const live = await provider.get(row.sandboxId);
    if (live) {
      const sb = asPauseCapable(live);
      if (sb) return { ok: true, sandbox: sb, row, woke: "already-running" };
    }
    // Row lied (provider lost it): fall through to recreate.
    await markDevSandboxDestroyed(workspaceId, projectId);
  }
  if (row && row.status === "paused") {
    // get() returns null for a PAUSED sandbox (paused can't serve), so the
    // resume path must go through state-aware attach when the provider has
    // it - otherwise a paused row would be wrongly destroyed and recreated.
    const aware = asStateAware(provider);
    let sb: (Sandbox & PauseCapable) | null = null;
    let resumable = false;
    if (aware) {
      const state = await aware.sandboxState(row.sandboxId);
      resumable = state !== "gone";
      if (state === "paused") {
        const paused = await aware.attachPaused(row.sandboxId, row.secretEnc);
        sb = paused ? asPauseCapable(paused) : null;
      } else if (state === "running") {
        const live = await provider.get(row.sandboxId);
        sb = live ? asPauseCapable(live) : null;
      }
    } else {
      const live = await provider.get(row.sandboxId);
      sb = live ? asPauseCapable(live) : null;
      resumable = sb !== null;
    }
    if (sb) {
      await sb.resume({ timeoutSeconds: row.ttlSeconds });
      await markDevSandboxRunning(workspaceId, projectId);
      return { ok: true, sandbox: sb, row: { ...row, status: "running" }, woke: "resumed" };
    }
    if (!resumable) await markDevSandboxDestroyed(workspaceId, projectId);
    // state "gone" with no handle falls through to recreate below.
  }

  const persist: PersistentSandboxOptions = { autoPause: true, timeoutSeconds: bounds.ttlSeconds };
  // runId is required by the shared create contract; dev sandboxes are
  // project-scoped, so the run slot carries a stable non-run marker.
  const created = await persistent.createPersistent({ workspaceId, runId: `dev:${projectId}` }, persist);
  const inserted = await insertDevSandboxRow({
    workspaceId,
    projectId,
    provider: provider.name,
    sandboxId: created.id,
    ttlSeconds: persist.timeoutSeconds,
    mode: bounds.mode,
    secretEnc: "persistSecret" in created && typeof created.persistSecret === "function" ? created.persistSecret() : null,
  });
  if (!inserted) {
    // Lost a concurrent create race: destroy the duplicate, use the winner.
    await created.destroy().catch(() => undefined);
    const winner = await getDevSandboxRow(workspaceId, projectId);
    if (winner) {
      const live = await provider.get(winner.sandboxId);
      const sb = live ? asPauseCapable(live) : null;
      if (sb) return { ok: true, sandbox: sb, row: winner, woke: "already-running" };
    }
    return { ok: false, reason: "Another session was starting this preview; try again." };
  }
  return { ok: true, sandbox: created, row: inserted, woke: "created" };
}

/** Pause the project's running dev sandbox (billing stops at the pause). */
export async function pauseDevSandbox(workspaceId: string, projectId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await getDevSandboxRow(workspaceId, projectId);
  if (!row || row.status !== "running") return { ok: true }; // nothing to pause
  const provider = getSandboxProvider();
  const live = provider ? await provider.get(row.sandboxId) : null;
  const sb = live ? asPauseCapable(live) : null;
  if (!sb) {
    await markDevSandboxDestroyed(workspaceId, projectId);
    return { ok: false, reason: "The provider no longer has this sandbox; marked destroyed." };
  }
  await sb.pause();
  await markDevSandboxPaused(workspaceId, projectId);
  return { ok: true };
}

/**
 * PRODUCTION backstop on one dev sandbox's total existence, create to
 * destroy. The running TTL pauses when quiet but refreshes on activity, so
 * this ceiling (never refreshed, computed from createdAt) is the app-side
 * last resort - the provider-side backstop is the TTL itself (the sandbox
 * stops even if this reconciler never runs). This is a safety cap, NOT a
 * budget: ongoing production spend is owner-approved separately and this
 * number is not derived from any approval. It is also NOT the bound for an
 * authorized spend test - that is TEST_BOUNDS below, deliberately separate.
 */
export const DEV_SANDBOX_ABSOLUTE_CEILING_MS = 8 * 60 * 60 * 1000;

export interface DevSandboxBounds {
  /** Stamped on the row so reconcile applies this ceiling, not a looser one. */
  mode: "production" | "test";
  /** Max live dev sandboxes across the whole workspace. */
  maxConcurrentPerWorkspace: number;
  /** Created-at kill for sandboxes created under these bounds. */
  absoluteCeilingMs: number;
  /** Running TTL requested at create (provider-side backstop). */
  ttlSeconds: number;
}

/** Production bounds: the generic safety cap above. */
export const PRODUCTION_BOUNDS: DevSandboxBounds = {
  mode: "production",
  maxConcurrentPerWorkspace: 3,
  absoluteCeilingMs: DEV_SANDBOX_ABSOLUTE_CEILING_MS,
  ttlSeconds: DEV_SANDBOX_DEFAULT_TTL_SECONDS,
};

/**
 * Bounds for a bounded, owner-authorized spend TEST: one sandbox
 * workspace-wide, 20-minute created-at kill, 5-minute running TTL. At the
 * grounded default E2B rate (~$0.17/running-hour, docs quote 2026-10-25)
 * the worst case is ~$0.06 of runtime - deliberately far under the
 * discussed $1 test spend. A test run ALSO needs spendEnabledForTests();
 * nothing here starts a sandbox on its own.
 */
export const TEST_BOUNDS: DevSandboxBounds = {
  mode: "test",
  maxConcurrentPerWorkspace: 1,
  absoluteCeilingMs: 20 * 60 * 1000,
  ttlSeconds: 300,
};

/**
 * Spend gate for create/resume - deliberately NOT the feature flag.
 * The flag (SHAPES_DEV_PREVIEW) opens the surface (status reads, the tab
 * UI, pause). Starting or waking a sandbox spends money, so POST requires
 * one of these, both OFF by default:
 *   SHAPES_DEV_PREVIEW_SPEND=1  owner-approved production spend (unset now);
 *   SHAPES_DEV_PREVIEW_TEST=1   a bounded, owner-authorized test window.
 * Pause (DELETE) and status (GET) never require this gate.
 */
export function boundsForMode(mode: string): DevSandboxBounds {
  return mode === "test" ? TEST_BOUNDS : PRODUCTION_BOUNDS;
}

export function devSandboxSpendAllowed(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): { allowed: boolean; bounds: DevSandboxBounds | null; mode: string; reason?: string } {
  if (env.SHAPES_DEV_PREVIEW_TEST === "1") {
    const until = Date.parse(env.SHAPES_DEV_PREVIEW_TEST_UNTIL ?? "");
    if (!Number.isFinite(until)) return { allowed: false, bounds: null, mode: "off", reason: "Test mode needs SHAPES_DEV_PREVIEW_TEST_UNTIL (the immutable window deadline)." };
    if (now.getTime() >= until) return { allowed: false, bounds: null, mode: "off", reason: "The authorized test window has ended." };
    return { allowed: true, bounds: TEST_BOUNDS, mode: "test" };
  }
  if (env.SHAPES_DEV_PREVIEW_SPEND === "1") return { allowed: true, bounds: PRODUCTION_BOUNDS, mode: "production" };
  return { allowed: false, bounds: null, mode: "off" };
}

/**
 * Hard cap on TOTAL test-mode sandboxes one workspace may ever create -
 * across rows, including destroyed ones, so destroy/recreate loops can't
 * multiply spend. Worst case at the grounded default rate: 3 x 20 min x
 * ~$0.17/hr ~= $0.17 of runtime, far under the discussed $1 test spend.
 */
export const TEST_MAX_CREATES_PER_WORKSPACE = 3;

/** Total test-mode CREATIONS in the workspace (sums the monotonic
 * per-row createCount, so revive-in-place loops count too). */
export async function countTestDevSandboxes(workspaceId: string): Promise<number> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.projectDevSandbox.findMany({ where: { workspaceId, mode: "test" }, select: { createCount: true } }),
  );
  return rows.reduce((n, r) => n + r.createCount, 0);
}

export interface ReconcileResult {
  markedPaused: number;
  ceilingDestroyed: number;
}

/**
 * Reconcile rows with provider truth (call from a periodic job or on
 * workspace load - never on inbound traffic to a sandbox, which must not
 * wake anything):
 *  - provider no longer has a "running"/"paused" row's sandbox (it
 *    auto-paused at TTL and later expired, or was killed) -> destroyed;
 *  - provider reports the sandbox paused (auto-pause fired) -> paused;
 *  - past the absolute created-at ceiling -> destroyed AND the provider
 *    sandbox destroyed, so spend stops even if activity kept the TTL alive.
 */
export async function reconcileDevSandboxes(workspaceId: string): Promise<ReconcileResult> {
  const provider = getSandboxProvider();
  if (!provider) return { markedPaused: 0, ceilingDestroyed: 0 };
  const rows = await listLiveDevSandboxes(workspaceId);
  let markedPaused = 0;
  let ceilingDestroyed = 0;
  for (const row of rows) {
    // The ceiling is the one the row was CREATED under - a test-bounded
    // sandbox never inherits the looser production cap.
    if (Date.now() - row.createdAt.getTime() > boundsForMode(row.mode).absoluteCeilingMs) {
      const live = await provider.get(row.sandboxId).catch(() => null);
      await live?.destroy().catch(() => undefined);
      await markDevSandboxDestroyed(workspaceId, row.projectId);
      ceilingDestroyed++;
      continue;
    }
    if (row.status !== "running") continue;
    const aware = asStateAware(provider);
    if (aware) {
      const state = await aware.sandboxState(row.sandboxId).catch(() => "gone" as const);
      if (state === "gone") {
        // Provider lost it entirely: the row must not promise a resumable sandbox.
        await markDevSandboxDestroyed(workspaceId, row.projectId);
      } else if (state === "paused") {
        // The provider's auto-pause fired at the running TTL - the normal,
        // expected quiet path. Billing stopped at the pause; flip the row.
        await markDevSandboxPaused(workspaceId, row.projectId);
        markedPaused++;
      }
      continue;
    }
    const live = await provider.get(row.sandboxId).catch(() => null);
    if (!live) await markDevSandboxDestroyed(workspaceId, row.projectId);
  }
  return { markedPaused, ceilingDestroyed };
}
