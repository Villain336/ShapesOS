// Marketr — POST /api/flywheel/reallocation/runs (trigger optimizer run)
//          GET  /api/flywheel/reallocation/runs (list) — via runs/route.ts GET
//
// One run: breaker evaluation → measurement-health pre-check → optimizer →
// persist curves/proposals → (mode b) deterministic policy evaluation →
// (mode b + autoExecute) checkout-verified execution. Every step is audited.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, badRequest, safetyError, readJson,
  getStore, reallocationTablesReady, tablesNotReady,
  sraSecret, revocationChecker,
} from "../_lib";
import { runOptimizer, type OptimizerChannel } from "@/lib/flywheel/reallocation/optimizer";
import { evaluateBreakers, tripToEvent, frozenScopes, type BreakerSignals } from "@/lib/flywheel/reallocation/breakers";
import { evaluatePolicy } from "@/lib/flywheel/reallocation/policy";
import { sraStatusAt, verifySraSignature } from "@/lib/flywheel/reallocation/sra";
import { executeModeBShift, createFixturePlatformAdapter } from "@/lib/flywheel/reallocation/checkout";
import { AuditLog } from "@/lib/flywheel/reallocation/audit";
import type { OptimizerTuning, ReallocationMode } from "@/lib/flywheel/reallocation/types";

export const dynamic = "force-dynamic";

const fixtureAdapter = createFixturePlatformAdapter();

async function notify(recipients: string[], subject: string, body: string) {
  console.log(`[f1-run notify] to=${recipients.join(",")} subject=${subject} body=${body.slice(0, 200)}`);
}

function asChannels(raw: unknown): OptimizerChannel[] | null {
  if (!Array.isArray(raw)) return null;
  for (const c of raw) {
    if (typeof c?.channel !== "string" || typeof c?.campaignRef !== "string") return null;
    if (!Number.isInteger(c?.currentDailyBudgetCents)) return null;
    if (!Array.isArray(c?.dataPoints) || typeof c?.health !== "object" || typeof c?.floor !== "object") return null;
  }
  return raw as OptimizerChannel[];
}

export async function GET() {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const store = getStore();
  return Response.json({ runs: await store.listRuns(gate.workspaceId, 50) });
}

export async function POST(req: NextRequest) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const body = await readJson(req);
  const now = new Date();

  const mode = body.mode as ReallocationMode;
  if (mode !== "a" && mode !== "b") return badRequest("mode must be 'a' or 'b'");
  const channels = asChannels(body.channels);
  if (!channels || channels.length === 0) return badRequest("channels[] with lagged data points is required");

  try {
    const store = getStore();
    const audit = new AuditLog(store.audit);

    // Mode (b) prerequisites: explicit opt-in SRA, active, signed.
    let sra: Awaited<ReturnType<typeof store.getSra>> = null;
    let secret: string | undefined;
    if (mode === "b") {
      if (typeof body.sraId !== "string" || !body.sraId) {
        return badRequest("mode 'b' requires sraId — mode (b) is explicit opt-in and defaults to disabled");
      }
      secret = sraSecret();
      if (!secret) {
        return Response.json({ error: "SRA_SIGNING_SECRET not configured — mode (b) disabled (fail-closed)." }, { status: 503 });
      }
      sra = await store.getSra(body.sraId, gate.workspaceId);
      if (!sra) return badRequest("SRA not found in workspace");
      if (sraStatusAt(sra, now) !== "active") {
        return Response.json({ error: `SRA status is ${sraStatusAt(sra, now)} — timeout means no` }, { status: 422 });
      }
      if (!verifySraSignature(sra, secret)) {
        return Response.json({ error: "SRA signature does not verify — timeout means no" }, { status: 422 });
      }
    }

    // 1. Breakers first: frozen scopes are excluded from the optimizer input.
    const signals = (body.breakerSignals as BreakerSignals[] | undefined) ?? [];
    const trips = signals.flatMap((s) => evaluateBreakers(s, now));
    for (const trip of trips) {
      const { id: _dropEventId, ...eventData } = tripToEvent(trip, gate.workspaceId, now);
      const event = await store.appendBreakerEvent(eventData);
      await audit.append(gate.workspaceId, "breaker_fired", "breaker-watchdog", {
        breakerId: event.id, type: trip.breakerType, scope: trip.scope, reason: trip.reason,
      }, undefined, now);
    }
    const existingEvents = await store.listBreakerEvents(gate.workspaceId, 200);
    const frozen = frozenScopes(existingEvents, now);
    const globallyFrozen = frozen.includes("global");
    const liveChannels = globallyFrozen ? [] : channels.filter((c) => !frozen.includes(c.channel));

    // 2. Optimizer (measurement-health pre-check inside may freeze the run).
    const tuning = { ...(body.tuning as Partial<OptimizerTuning> | undefined) } as Partial<OptimizerTuning>;
    const result = runOptimizer({
      workspaceId: gate.workspaceId,
      mode,
      sraId: (body.sraId as string | undefined) ?? undefined,
      channels: liveChannels,
      tuning,
      now,
    });

    // 3. Persist curves + proposals.
    for (const curve of result.curves) {
      const { id: _dropCurveId, ...curveData } = curve;
      await store.saveCurve(curveData);
    }
    const savedProposals = [];
    for (const p of result.proposals) {
      const { id: _dropProposalId, ...proposalData } = p;
      const saved = await store.createProposal(proposalData);
      savedProposals.push(saved);
      await audit.append(gate.workspaceId, "proposal_created", "optimizer", {
        proposalId: saved.id, mode, amountCents: saved.amountCents,
        sourceChannel: saved.sourceChannel, destChannel: saved.destChannel,
        marginalRoasDelta: saved.marginalRoasDelta,
      }, undefined, now);
    }

    // 4. Mode (b): deterministic policy evaluation per proposal.
    const decisions = [];
    let executedCount = 0;
    if (mode === "b" && sra && secret) {
      const { check } = await revocationChecker(store, gate.workspaceId);
      const baselines = (body.baselines ?? {}) as Record<string, number>;
      const lastMoves = (body.lastMoves ?? {}) as Record<string, string>;
      const exploration = new Set(liveChannels.filter((c) => c.isExploration).map((c) => c.channel));
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const weekStart = new Date(+now - 7 * 86_400_000);

      for (const proposal of savedProposals) {
        const dailyShifts = await store.executedShiftsSince(sra.id, gate.workspaceId, dayStart.toISOString());
        const weeklyShifts = await store.executedShiftsSince(sra.id, gate.workspaceId, weekStart.toISOString());
        const srcBaseline = baselines[proposal.sourceChannel] ?? 0;
        const dstBaseline = baselines[proposal.destChannel] ?? 0;
        const verdict = evaluatePolicy({
          proposal,
          sra,
          consumedDailyCents: dailyShifts.reduce((s, p) => s + Math.abs(p.amountCents), 0),
          consumedWeeklyCents: weeklyShifts.reduce((s, p) => s + Math.abs(p.amountCents), 0),
          channelBaselinesCents: new Map(Object.entries(baselines)),
          projectedBudgetsCents: new Map([
            [proposal.sourceChannel, srcBaseline - proposal.amountCents],
            [proposal.destChannel, dstBaseline + proposal.amountCents],
          ]),
          lastMoveAt: new Map(Object.entries(lastMoves)),
          isRevoked: check,
          signatureValid: verifySraSignature(sra, secret),
          explorationChannels: exploration,
          now,
        });
        const decision = await store.appendPolicyDecision(verdict.decision);
        decisions.push(decision);
        await audit.append(gate.workspaceId, "policy_decision", "policy-engine", {
          proposalId: proposal.id, decision: verdict.decision.decision, reasons: verdict.reasons,
        }, undefined, now);
        const nextStatus = verdict.allow ? "policy_approved" : "policy_denied";
        await store.updateProposal(proposal.id, gate.workspaceId, { status: nextStatus });
        proposal.status = nextStatus;

        // 5. Optional inline execution — still through checkout re-verification.
        if (verdict.allow && body.autoExecute === true) {
          const execResult = await executeModeBShift(proposal.id, gate.workspaceId, gate.userId, {
            store,
            adapter: fixtureAdapter,
            notify,
            sraSecret: secret,
            isRevoked: check,
            channelBaselinesCents: new Map(Object.entries(baselines)),
            lastMoveAt: new Map(Object.entries(lastMoves)),
            explorationChannels: exploration,
            now,
          });
          if (execResult.executed) {
            executedCount++;
            proposal.status = "executed";
          }
        }
      }
    }

    const run = await store.createRun({
      workspaceId: gate.workspaceId,
      runAt: now.toISOString(),
      mode,
      proposalsCount: savedProposals.length,
      executedCount,
      deniedCount: decisions.filter((d) => d.decision === "deny").length,
      frozen: result.frozen || globallyFrozen,
      dataHealthSnapshot: {
        ...result.healthSnapshot,
        breakerTrips: trips,
        frozenScopes: frozen,
        excludedChannels: channels.filter((c) => !liveChannels.includes(c)).map((c) => c.channel),
      },
    });
    await audit.append(gate.workspaceId, "run_completed", "optimizer", {
      runId: run.id, mode, proposals: savedProposals.length, executed: executedCount,
      denied: run.deniedCount, frozen: run.frozen,
    }, undefined, now);

    return Response.json({ run, proposals: savedProposals, policyDecisions: decisions, breakerTrips: trips }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
