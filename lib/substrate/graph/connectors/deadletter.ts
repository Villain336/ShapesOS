// Marketr — Phase 8 G1: webhook dead-letter queue.
//
// Repeated ingest failures are never silent (spec B3): the dead letter is
// recorded as an append-only fact (fact_type "ingest_dead_letter") so it is
// auditable and replayable, and the sync job's error_count/backoff grows.
// The raw payload is NEVER persisted — only its fingerprint and shape —
// because webhook bodies can carry PII and must never sit in logs (§9.9).

import { appendFact } from "../facts";
import { payloadFingerprint } from "./hmac";
import { withWorkspaceScope } from "../rls";

export interface DeadLetterInput {
  workspaceId: string;
  connectorId: string;
  platform: string;
  reason: string;
  rawBody: string;
  attempt: number;
}

export async function deadLetter(input: DeadLetterInput): Promise<void> {
  const shape = summarizeShape(input.rawBody);
  await appendFact({
    workspaceId: input.workspaceId,
    source: `webhook:${input.platform}`,
    sourceRecordId: `dead-letter:${payloadFingerprint(input.rawBody)}`,
    entityRef: `content:dead-letter:${payloadFingerprint(input.rawBody)}`,
    factType: "ingest_dead_letter",
    payload: {
      displayName: `Dead letter (${input.platform})`,
      core: { platform: input.platform, reason: input.reason, attempt: input.attempt },
      properties: {
        fingerprint: payloadFingerprint(input.rawBody),
        shape,
        connectorId: input.connectorId,
      },
    },
    actor: "system:webhook",
  });
  await withWorkspaceScope(input.workspaceId, (tx) =>
    tx.graphSyncJob.updateMany({
      where: { workspaceId: input.workspaceId, connectorId: input.connectorId },
      data: { errorCount: { increment: 1 } },
    }),
  );
}

/** Shape summary without values: {"contact": ["email", "name"]}. */
function summarizeShape(rawBody: string): unknown {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return shapeOf(parsed, 0);
  } catch {
    return { unparseable: true, bytes: rawBody.length };
  }
}

function shapeOf(v: unknown, depth: number): unknown {
  if (depth > 2) return "…";
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0], depth + 1)];
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).slice(0, 40)) {
      out[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return typeof v;
}
