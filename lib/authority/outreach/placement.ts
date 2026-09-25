// Marketr — Phase 6 O1 outreach engine: placement verification fixtures.
//
// Weekly backlink check per placed link: placed-backlink detected, lost-link,
// nofollow-flip, and anchor-change alerts (the BuzzStream pattern, built
// in-house). Fixtures are deterministic per sequence id so batteries and the
// UI have a stable surface; a real crawler adapter would slot in behind
// verifyPlacement.

import { authorityAudit } from "@/lib/authority/db";
import type { SequenceStore } from "./sequences";
import type { ProspectStore } from "./prospects";

export type PlacementOutcome = "placed" | "lost" | "nofollow_flip" | "anchor_change" | "not_found";

export interface PlacementCheck {
  sequenceId: string;
  prospectId: string;
  url: string;
  outcome: PlacementOutcome;
  detail: string;
  checkedAt: Date;
  alert: boolean;
}

/** Deterministic fixture outcome per sequence id. */
export function fixturePlacementOutcome(sequenceId: string): PlacementOutcome {
  let h = 0;
  for (let i = 0; i < sequenceId.length; i += 1) h = (h * 31 + sequenceId.charCodeAt(i)) >>> 0;
  const outcomes: PlacementOutcome[] = ["placed", "placed", "placed", "nofollow_flip", "anchor_change", "lost", "not_found"];
  return outcomes[h % outcomes.length];
}

export interface PlacementDeps {
  sequences: SequenceStore;
  prospects: ProspectStore;
}

/** Verify a single sequence's placement; records a placement_verified event. */
export async function verifyPlacement(
  deps: PlacementDeps,
  opts: { workspaceId: string; sequenceId: string; actor: string },
): Promise<PlacementCheck> {
  const seq = await deps.sequences.get(opts.sequenceId, opts.workspaceId);
  if (!seq) throw new Error("Sequence not found in workspace.");
  const prospect = await deps.prospects.get(seq.prospectId, opts.workspaceId);
  if (!prospect) throw new Error("Prospect not found in workspace.");

  const outcome = fixturePlacementOutcome(seq.id);
  const checkedAt = new Date();
  const alert = outcome === "lost" || outcome === "nofollow_flip" || outcome === "anchor_change";
  const detail =
    outcome === "placed" ? `Backlink detected on ${prospect.domain}.`
    : outcome === "lost" ? `Previously placed link on ${prospect.domain} no longer resolves.`
    : outcome === "nofollow_flip" ? `Link on ${prospect.domain} flipped to nofollow.`
    : outcome === "anchor_change" ? `Anchor text changed on ${prospect.domain}.`
    : `No backlink found on ${prospect.domain} yet.`;

  await deps.sequences.recordEvent(seq.id, opts.workspaceId, "placement_verified", {
    outcome, alert, url: prospect.url, checkedAt: checkedAt.toISOString(),
  });
  if (outcome === "placed" && prospect.status !== "placed") {
    await deps.prospects.update(prospect.id, opts.workspaceId, { status: "placed" });
  }
  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId, actor: opts.actor, action: "placement_verified",
    entityType: "outreach_sequence", entityId: seq.id,
    detail: { outcome, alert, prospectId: prospect.id },
  });

  return { sequenceId: seq.id, prospectId: prospect.id, url: prospect.url, outcome, detail, checkedAt, alert };
}

/**
 * Weekly sweep: verify every sequence whose prospect was contacted/replied/
 * placed and which hasn't been verified in the last 7 days. Returns checks
 * with alerts first.
 */
export async function runWeeklyPlacementVerification(
  deps: PlacementDeps,
  opts: { workspaceId: string; actor: string },
): Promise<PlacementCheck[]> {
  const sequences = await deps.sequences.list(opts.workspaceId);
  const eligible: string[] = [];
  for (const seq of sequences) {
    const prospect = await deps.prospects.get(seq.prospectId, opts.workspaceId);
    if (!prospect) continue;
    if (!["contacted", "replied", "placed"].includes(prospect.status)) continue;
    const events = await deps.sequences.events(seq.id, opts.workspaceId);
    const lastCheck = events.filter((e) => e.event === "placement_verified").pop();
    if (lastCheck && Date.now() - lastCheck.ts.getTime() < 7 * 86_400_000) continue;
    eligible.push(seq.id);
  }
  const checks: PlacementCheck[] = [];
  for (const id of eligible.slice(0, 50)) {
    checks.push(await verifyPlacement(deps, { workspaceId: opts.workspaceId, sequenceId: id, actor: opts.actor }));
  }
  return checks.sort((a, b) => Number(b.alert) - Number(a.alert));
}
