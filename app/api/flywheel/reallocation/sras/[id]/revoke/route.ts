// Marketr — POST /api/flywheel/reallocation/sras/:id/revoke (instant)
//
// A single signed revoke flips the envelope to denied. Checkout-time
// re-verification makes revocation effective even mid-flight.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, safetyError, readJson, requireOwner,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../../../_lib";
import { revokeSra } from "@/lib/flywheel/reallocation/sra";
import { AuditLog } from "@/lib/flywheel/reallocation/audit";

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
    const sra = await store.getSra(id, gate.workspaceId);
    if (!sra) return Response.json({ error: "SRA not found in workspace" }, { status: 404 });
    const revoked = revokeSra(sra, gate.userId);
    const saved = await store.updateSra(id, gate.workspaceId, {
      status: "revoked",
      revokedAt: revoked.revokedAt,
      revokedBy: gate.userId,
    });
    const audit = new AuditLog(store.audit);
    await audit.append(gate.workspaceId, "sra_revoked", gate.userId, {
      sraId: id,
      revocationId: sra.revocationId,
      reason: (body.reason as string | undefined) ?? null,
    });
    return Response.json({ sra: saved });
  } catch (err) {
    return safetyError(err);
  }
}
