// Marketr — GET /api/flywheel/dsp/adapters
// List the four DSP plug-in adapters with seat status (viewer+).
// Every adapter defaults to seatStatus "none" — fail closed out of the box.

import { dspGuard } from "@/app/api/flywheel/dsp/_lib";
import { dspAdapterStore, dspAuditStore, ensureAdapters } from "@/app/api/flywheel/dsp/stores";
import { DSP_LABELS } from "@/lib/flywheel/dsp";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await dspGuard("viewer");
  if (gate instanceof Response) return gate;
  const adapters = await ensureAdapters(gate.workspaceId);
  return Response.json({
    zeroCustody:
      "DSP contracts and billing sit with the agency/client entity — never Marketr. " +
      "Marketr orchestrates, approves, kill-switches, and accounts.",
    adapters: adapters.map((a) => ({
      id: a.id,
      dsp: a.dsp,
      label: DSP_LABELS[a.dsp],
      seatStatus: a.seatStatus,
      // configRef is intentionally NOT returned — vault refs stay server-side.
      connectedAt: a.connectedAt,
      connectedBy: a.connectedBy,
    })),
    audit: (await dspAuditStore().list(gate.workspaceId, 20)).map((e) => ({
      action: e.action, actor: e.actor, ts: e.ts, subjectType: e.subjectType, detail: e.detail,
    })),
  });
}
