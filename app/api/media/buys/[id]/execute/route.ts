// Marketr — POST /api/media/buys/:id/execute
//
// :id is the APPROVAL id. Runs the full S3 pre-flight, then dispatches the
// executor. HALT semantics: any failed check → status stays "approved",
// approver + requester notified with the exact diff. Owner-only.
//
// Fake/test mode default: no real spend. Real provider execution is a
// B-track concern; the hooks below are the seam it plugs into.
// Circuit breaker: 3 failed executions on a channel → the channel's pool is
// frozen and the owner is alerted (S4).

import type { NextRequest } from "next/server";
import { mediaGuard, safetyError, requireMediaOwner } from "../../../_lib";
import { mediaStores, safetyTablesReady, logMediaAudit } from "@/lib/media/db";
import {
  executeBuy,
  defaultTestHooks,
  type ExecutorHooks,
} from "@/lib/media/executor";
import { ExecutionCircuitBreaker, logMediaEvent } from "@/lib/media/killswitch";
import { freezePool } from "@/lib/media/pools";

export const dynamic = "force-dynamic";

// Process-lifetime circuit breaker. PRODUCTION NOTE: persist failure counts
// (DB/KV) so a restart doesn't reset the breaker mid-incident.
const circuitBreaker = new ExecutionCircuitBreaker(3);

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }

  const { id: approvalId } = await params;
  const { approvals, pools, buys, audit } = mediaStores();

  try {
    const approval = await approvals.get(approvalId, gate.workspaceId);
    if (!approval) return Response.json({ error: "Approval not found" }, { status: 404 });

    const hooks: ExecutorHooks = defaultTestHooks({
      // Fake/test mode: the creative source of truth echoes the approved
      // hashes. The REAL path (B-tracks) recomputes from the creative store —
      // any drift there is a hard HALT.
      rehashCreatives: async (ids) => {
        const out: Record<string, string> = {};
        for (const cid of ids) {
          const idx = approval.binding.creativeIds.indexOf(cid);
          out[cid] = idx >= 0 ? approval.binding.creativeHashes[idx] : "unknown-creative";
        }
        return out;
      },
      getPoolState: async (poolId) => {
        const p = await pools.get(poolId, gate.workspaceId);
        return p ? { remainingCents: p.remainingCents, allowlist: p.platformAllowlist, status: p.status } : null;
      },
      writePlatformGuardrails: async (buy) => {
        console.log(`[media-executor] writePlatformGuardrails (fake): ${buy.platform} buy ${buy.approvalId}`);
      },
      registerWithSweeper: async (buy) => {
        console.log(`[media-executor] registerWithSweeper (fake): ${buy.approvalId} on ${buy.platform}`);
      },
      notify: async (recipients, subject, body) => {
        console.log(`[media-executor notify] to=${recipients.join(",")} subject=${subject} body=${body.slice(0, 300)}`);
      },
    });

    const result = await executeBuy(approvalId, gate.workspaceId, gate.userId, {
      approvalStore: approvals,
      poolStore: pools,
      hooks,
      buyStore: {
        create: async (buy) => {
          await buys.create({
            approvalId: buy.approvalId,
            workspaceId: buy.workspaceId,
            poolId: buy.poolId,
            platform: buy.platform,
            clientAdAccountId: buy.clientAdAccountId,
            platformCampaignRef: buy.platformCampaignRef,
          });
        },
      },
    });

    if (result.executed) {
      circuitBreaker.recordSuccess(approval.binding.platform);
      await logMediaAudit(audit, {
        workspaceId: gate.workspaceId, actor: gate.userId,
        action: "buy_executed", subjectType: "approval", subjectId: approvalId,
        detail: { platform: approval.binding.platform, maxSpendCents: approval.maxSpendCents, poolId: approval.poolId },
      }).catch((e) => console.error("[media-audit] buy_executed write failed:", e));
      return Response.json({ executed: true, buy: result.buy, preflight: result.preflight });
    }
    // HALT (fail-closed): record the failure for the circuit breaker.
    const { frozen } = circuitBreaker.recordFailure(approval.binding.platform);
    let poolFrozen = false;
    if (frozen && approval.poolId) {
      await freezePool(pools, approval.poolId, gate.workspaceId, "system", "circuit breaker: 3 failed executions");
      await logMediaEvent(approvals, approvalId, gate.workspaceId, "system", "circuit_breaker_tripped", {
        platform: approval.binding.platform,
        failures: 3,
      });
      poolFrozen = true;
    }
    await logMediaAudit(audit, {
      workspaceId: gate.workspaceId, actor: gate.userId,
      action: "buy_execution_halted", subjectType: "approval", subjectId: approvalId,
      detail: { haltReason: result.preflight.haltReason, circuitBreakerFrozen: poolFrozen },
    }).catch((e) => console.error("[media-audit] buy_execution_halted write failed:", e));
    return Response.json(
      { executed: false, haltReason: result.preflight.haltReason, diff: result.preflight.diff, checks: result.preflight.checks, circuitBreakerFrozen: poolFrozen },
      { status: 422 },
    );
  } catch (err) {
    return safetyError(err);
  }
}
