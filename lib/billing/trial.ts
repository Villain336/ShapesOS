// ShapesOS — deployment mode + the hosted trial plan (Phase 3, workstream I).
//
//   DEPLOYMENT_MODE=self_hosted (default)  new workspaces get `self_hosted`:
//                                          BYO provider keys, metering records
//                                          usage but never blocks.
//   DEPLOYMENT_MODE=hosted                 a user's first workspace gets the
//                                          `trial` plan for TRIAL_DAYS with a
//                                          small included pool behind a hard
//                                          cap (billed-plan behaviour). Any
//                                          further workspace, or a workspace
//                                          whose paid subscription lapses,
//                                          is an already-ended trial.
//
// Past trialEndsAt a trial workspace is read-only for metered actions:
// meter() refuses every charge > 0 with an upgrade prompt pointing at the
// existing billing flow (/dashboard/billing). Free actions still pass.
// Pure helpers only — no database access — so they unit-test directly.

import type { Plan } from "@prisma/client";

export type DeploymentMode = "hosted" | "self_hosted";

export function deploymentMode(env: NodeJS.ProcessEnv = process.env): DeploymentMode {
  return (env.DEPLOYMENT_MODE ?? "").trim().toLowerCase() === "hosted" ? "hosted" : "self_hosted";
}

/** Trial length. */
export const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;

/** Where the upgrade prompt sends people (the existing Stripe plans page). */
export const UPGRADE_PATH = "/dashboard/billing";

export function trialEndsAtFrom(now: Date): Date {
  return new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
}

/**
 * The plan (and trial end) for a workspace being created now.
 * `hadTrial`: the user already started a hosted trial before (lifecycle
 * audit trail) — one free trial per person, not per workspace, so creating
 * more workspaces can't mint more free credits.
 */
export function initialPlanFor(opts: {
  mode: DeploymentMode;
  hadTrial: boolean;
  now: Date;
}): { plan: Plan; trialEndsAt: Date | null } {
  if (opts.mode === "self_hosted") return { plan: "self_hosted", trialEndsAt: null };
  return { plan: "trial", trialEndsAt: opts.hadTrial ? opts.now : trialEndsAtFrom(opts.now) };
}

/**
 * The plan a workspace falls back to when its paid subscription ends.
 * Self-hosted deployments return to BYO keys; on a hosted deployment that
 * would mean unlimited unbilled usage, so it becomes an ended trial instead.
 */
export function lapsedPlanFor(mode: DeploymentMode): Plan {
  return mode === "hosted" ? "trial" : "self_hosted";
}

export interface TrialState {
  plan: Plan | string;
  trialEndsAt: Date | null;
}

/**
 * True when the workspace is on the trial plan and the trial is over.
 * A trial with no end date fails closed (treated as ended).
 */
export function isTrialExpired(ws: TrialState, now: Date = new Date()): boolean {
  if (ws.plan !== "trial") return false;
  if (!ws.trialEndsAt) return true;
  return ws.trialEndsAt.getTime() <= now.getTime();
}

/** Whole days left in a running trial (rounded up); 0 once it ended; null when not on trial. */
export function trialDaysLeft(ws: TrialState, now: Date = new Date()): number | null {
  if (ws.plan !== "trial") return null;
  if (isTrialExpired(ws, now)) return 0;
  return Math.ceil((ws.trialEndsAt!.getTime() - now.getTime()) / DAY_MS);
}

/** The refusal meter() returns once the trial is over. */
export function trialExpiredMessage(trialEndsAt: Date | null): string {
  const when = trialEndsAt
    ? ` on ${trialEndsAt.toISOString().slice(0, 10)}`
    : "";
  return (
    `Your ShapesOS trial ended${when}. This workspace is read-only for credit-using actions ` +
    `until you choose a plan in Billing (${UPGRADE_PATH}).`
  );
}
