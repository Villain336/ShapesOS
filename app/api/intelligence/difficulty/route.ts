// Marketr — Phase 10 M5: difficulty estimate API.
//
// GET  /api/intelligence/difficulty          (viewer+)
//   → { estimates, gate, modelVersion } — latest versioned artifacts for the
//     workspace plus the current eval-bar gate state.
// POST /api/intelligence/difficulty          (editor+)
//   body { keywords: string[], locale?, ownDomain? }
//   → batch estimates (capped at the service MAX_BATCH of 20). Every estimate
//     is marked experimental until the eval bar passes (gate.ts) — the UI
//     shows the modeled value ALONGSIDE the vendor value, never in place
//     of it.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { intelligenceGuard, readJson, badRequest } from "../_lib";
import { listEstimates } from "@/lib/intelligence/difficulty/store";
import { gateStatus } from "@/lib/intelligence/difficulty/gate";
import {
  estimateKeywords,
  MODEL_VERSION,
} from "@/lib/intelligence/difficulty/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer")))
    return forbidden();

  const estimates = await listEstimates(workspace.id, { limit: 100 });
  return Response.json({
    estimates,
    gate: gateStatus(),
    modelVersion: MODEL_VERSION,
  });
}

export async function POST(req: Request) {
  const guard = await intelligenceGuard("editor");
  if (guard instanceof Response) return guard;

  const body = await readJson(req);
  const keywords = (
    Array.isArray(body.keywords) ? body.keywords : []
  )
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keywords.length === 0) return badRequest("keywords[] is required.");

  const locale =
    typeof body.locale === "string" && body.locale.trim()
      ? body.locale.trim()
      : "en-US";
  const ownDomain =
    typeof body.ownDomain === "string" && body.ownDomain.trim()
      ? body.ownDomain.trim()
      : undefined;

  const { results, modelVersion } = await estimateKeywords(
    guard.workspaceId,
    keywords,
    locale,
    ownDomain ? { ownDomain } : {},
  );

  return Response.json({
    modelVersion,
    results: results.map(({ keyword, outcome }) =>
      outcome.ok
        ? {
            keyword,
            ok: true as const,
            estimate: outcome.output.estimate,
            uncertainty: outcome.output.uncertainty,
            uncertaintyBand: outcome.output.uncertaintyBand,
            components: outcome.output.components,
            inputsProvenance: outcome.output.inputsProvenance,
            experimental: outcome.experimental,
          }
        : { keyword, ok: false as const, reason: outcome.reason },
    ),
  });
}
