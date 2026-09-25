// Marketr — POST /api/flywheel/dsp/adapters/:id/connect
// Connect the agency's own seat to a DSP adapter (BYO seat; editor+).
// Zero-custody: requires a vault config_ref — raw credentials are refused.
// Body: { configRef: "vault://..." }

import { dspGuard, badRequest, dspError, readJson } from "@/app/api/flywheel/dsp/_lib";
import { dspAdapterStore, dspAuditStore, ensureAdapters } from "@/app/api/flywheel/dsp/stores";
import { assertDspKind, DSP_LABELS } from "@/lib/flywheel/dsp";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await dspGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const { id } = await ctx.params;
    assertDspKind(id);
    await ensureAdapters(gate.workspaceId);
    const body = await readJson(req);
    const configRef = body.configRef;
    if (typeof configRef !== "string" || !configRef.trim()) {
      return badRequest('configRef is required: your seat\'s vault reference, e.g. "vault://dsp/ttd".');
    }
    const record = await dspAdapterStore().connect(gate.workspaceId, id, configRef.trim(), gate.userId);
    await dspAuditStore().log({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "adapter_connected",
      subjectType: "adapter",
      subjectId: record.id,
      // configRef value is never written to the audit log — vault refs stay server-side.
      detail: { dsp: record.dsp, label: DSP_LABELS[record.dsp], seatStatus: record.seatStatus },
    });
    return Response.json({
      adapter: { id: record.id, dsp: record.dsp, label: DSP_LABELS[record.dsp], seatStatus: record.seatStatus },
      zeroCustody: "Seat connected with a vault reference only. Marketr never receives raw seat credentials.",
    });
  } catch (err) {
    return dspError(err);
  }
}
