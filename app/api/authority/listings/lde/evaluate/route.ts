// Marketr — POST /api/authority/listings/lde/evaluate (editor)
//
// Tier 2 prototype: flag-gated sandbox probe + sync-accuracy validation
// recording. The flag is the gate; promotion to default requires a passing
// validation record — never a bare flag flip.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import {
  probeLdeSandbox, validateSyncAccuracy, recordAccuracyResult,
  ldePromotionAllowed, ldeFlagEnabled, LDE_COST_PER_CALL_USD, LDE_PUBLISHER_COUNT,
  type SyncAccuracyResult,
} from "@/lib/authority/listings/lde";
import { ldeEvaluateSchema } from "@/app/api/authority/listings/_schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  if (!ldeFlagEnabled()) {
    return Response.json({
      error: "The Local Data Exchange prototype is behind a feature flag — enable MARKETR_LDE_PROTOTYPE=1 (Settings → Authority → Listings).",
      flagged: true,
    }, { status: 422 });
  }
  let raw: unknown;
  try { raw = await req.json(); } catch { return badRequest("Invalid JSON"); }
  const parsed = ldeEvaluateSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const probe = await probeLdeSandbox({ fake: true });
    const accuracy = validateSyncAccuracy(parsed.data.checks.map((c) => ({
      directory: c.directory, expected: c.expected, observed: c.observed, match: c.match,
    })));

    const store = createPrismaListingStore();
    const existing = await store.channels.get(gate.workspaceId, "lde");
    const history = ((existing?.configJson?.ldeAccuracyHistory ?? []) as SyncAccuracyResult[]).filter((h) => typeof h === "object");
    const nextHistory = recordAccuracyResult(history, accuracy);
    await store.channels.upsert({
      workspaceId: gate.workspaceId, channel: "lde", tier: "aggregator",
      config: {
        ...(existing?.configJson ?? {}),
        ldeProbe: probe,
        ldeAccuracyHistory: nextHistory,
        prototype: true,
        costPerCallUsd: LDE_COST_PER_CALL_USD,
        publisherCount: LDE_PUBLISHER_COUNT,
      },
    });

    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "lde_evaluated",
      entityType: "listing_channel", entityId: "lde",
      detail: { publishers: probe.publishers, latencyMs: probe.latencyMs, checks: accuracy.checks.length, passed: accuracy.passed, promotionAllowed: ldePromotionAllowed(nextHistory) },
    }).catch(() => undefined);

    return Response.json({
      flagged: true, sandbox: true,
      probe,
      accuracy,
      promotionAllowed: ldePromotionAllowed(nextHistory),
      note: "Prototype only. Promotion to default requires a real passing sync-accuracy run — never a bare flag flip.",
    });
  } catch (err) {
    return safetyError(err);
  }
}
