// Marketr — POST /api/flywheel/reallocation/proposals/:id/execute
//
// Executes an authorized move with checkout-time re-verification:
// - mode (a): the Phase 5 approval is re-verified (status, binding hash,
//   approver receipts, expiry) before the shift.
// - mode (b): the SRA is re-read fresh and re-verified (status, signature,
//   live revocation, recomputed caps, full policy re-evaluation).
// Owner/admin only. Fixture adapter by default — real platform adapters are
// honest not-configured in v1.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, badRequest, safetyError, readJson, requireOwner,
  getStore, reallocationTablesReady, tablesNotReady,
  sraSecret, revocationChecker,
} from "../../../_lib";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import {
  createFixturePlatformAdapter,
  executeModeAMove,
  executeModeBShift,
} from "@/lib/flywheel/reallocation/checkout";
import { verifySraSignature } from "@/lib/flywheel/reallocation/sra";

// Process-global fixture adapter (test mode default). Real platform spend
// APIs do not exist in v1 — the real adapter throws honest not-configured.
const fixtureAdapter = createFixturePlatformAdapter();

async function notify(recipients: string[], subject: string, body: string) {
  console.log(`[f1-executor notify] to=${recipients.join(",")} subject=${subject} body=${body.slice(0, 200)}`);
}

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  const owner = requireOwner(gate);
  if (owner) return owner;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  const body = await readJson(req);

  try {
    const store = getStore();
    const proposal = await store.getProposal(id, gate.workspaceId);
    if (!proposal) return Response.json({ error: "Proposal not found in workspace" }, { status: 404 });

    if (proposal.mode === "a") {
      if (!(await safetyTablesReady())) {
        return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
      }
      if (!proposal.humanApprovalId) return badRequest("Proposal has no materialized approval — approve it first");
      const { approvals } = mediaStores();
      const result = await executeModeAMove(
        proposal.humanApprovalId, proposal.id, gate.workspaceId, gate.userId,
        { store, approvalStore: approvals, adapter: fixtureAdapter, notify },
      );
      if (!result.executed) return Response.json({ executed: false, haltReason: result.haltReason }, { status: 422 });
      return Response.json({ executed: true, proposal: await store.getProposal(id, gate.workspaceId), adapter: fixtureAdapter.name });
    }

    // mode (b)
    const secret = sraSecret();
    if (!secret) {
      return Response.json({ error: "SRA_SIGNING_SECRET not configured — mode (b) disabled (fail-closed)." }, { status: 503 });
    }
    const baselines = (body.baselines ?? {}) as Record<string, number>;
    const lastMoves = (body.lastMoves ?? {}) as Record<string, string>;
    const exploration = new Set<string>((body.explorationChannels as string[] | undefined) ?? []);
    const { check } = await revocationChecker(store, gate.workspaceId);
    const result = await executeModeBShift(proposal.id, gate.workspaceId, gate.userId, {
      store,
      adapter: fixtureAdapter,
      notify,
      sraSecret: secret,
      isRevoked: check,
      channelBaselinesCents: new Map(Object.entries(baselines)),
      lastMoveAt: new Map(Object.entries(lastMoves)),
      explorationChannels: exploration,
    });
    if (!result.executed) return Response.json({ executed: false, haltReason: result.haltReason }, { status: 422 });
    return Response.json({ executed: true, proposal: await store.getProposal(id, gate.workspaceId), adapter: fixtureAdapter.name });
  } catch (err) {
    return safetyError(err);
  }
}

// Re-exported for the runs route (autoExecute).
export { fixtureAdapter, verifySraSignature };
