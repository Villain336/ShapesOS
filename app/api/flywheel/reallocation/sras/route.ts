// Marketr — POST /api/flywheel/reallocation/sras (create envelope — explicit opt-in)
//          GET  /api/flywheel/reallocation/sras (list)
//
// Creating an SRA is a deliberate act: owner/admin only, conservative
// defaults, mandatory ≤30d expiry, plain-language consequences returned.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, badRequest, safetyError, readJson, requireOwner,
  getStore, reallocationTablesReady, tablesNotReady, requireSraSecret,
} from "../_lib";
import { createSraEnvelope, sraConsequences, SraViolationError } from "@/lib/flywheel/reallocation/sra";
import { AuditLog } from "@/lib/flywheel/reallocation/audit";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const store = getStore();
  const sras = await store.listSras(gate.workspaceId);
  return Response.json({ sras: sras.map((s) => ({ ...s, consequences: sraConsequences(s) })) });
}

export async function POST(req: NextRequest) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  const owner = requireOwner(gate);
  if (owner) return owner;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const secretOr = requireSraSecret();
  if (secretOr instanceof Response) return secretOr;
  const body = await readJson(req);

  try {
    const store = getStore();
    const envelope = createSraEnvelope(
      {
        workspaceId: gate.workspaceId,
        name: body.name as string,
        channels: body.channels as string[],
        perShiftCapCents: body.perShiftCapCents as number | undefined,
        dailyAggregateCapCents: body.dailyAggregateCapCents as number | undefined,
        weeklyAggregateCapCents: body.weeklyAggregateCapCents as number | undefined,
        perChannelBandPct: body.perChannelBandPct as number | undefined,
        explorationFloorPct: body.explorationFloorPct as number | undefined,
        cooldownHours: body.cooldownHours as number | undefined,
        validFrom: body.validFrom as string | undefined,
        validUntil: body.validUntil as string,
        signerIds: body.signerIds as string[],
        createdBy: gate.userId,
        poolDailyBudgetCents: body.poolDailyBudgetCents as number | undefined,
      },
      secretOr,
    );
    const saved = await store.createSra(envelope);
    const audit = new AuditLog(store.audit);
    await audit.append(gate.workspaceId, "sra_created", gate.userId, {
      sraId: saved.id,
      name: saved.name,
      channels: saved.channels,
      perShiftCapCents: saved.perShiftCapCents,
      dailyAggregateCapCents: saved.dailyAggregateCapCents,
      weeklyAggregateCapCents: saved.weeklyAggregateCapCents,
      perChannelBandPct: saved.perChannelBandPct,
      validUntil: saved.validUntil,
      signerIds: saved.signerIds,
    });
    return Response.json({ sra: saved, consequences: sraConsequences(saved) }, { status: 201 });
  } catch (err) {
    if (err instanceof SraViolationError) return badRequest(err.message);
    return safetyError(err);
  }
}
