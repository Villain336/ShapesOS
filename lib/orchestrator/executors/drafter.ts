// Marketr — Phase 9 M2: Drafter executor (SPEC §P9A).
//
// DRAFT MODE ONLY. Writes outbound artifacts (outreach copy, briefs,
// content drafts) as drafts. Nothing sends: there is no send/publish tool
// in the allow-list, so sending is impossible even if asked. Every draft
// that would go external creates a mission_approval (Tier 2) INSTEAD of
// sending — the non-LLM approval executor (lib/authority/executor.ts) is
// the only path that can ever act on it, with human-signed authority.

import { evaluateTier } from "../authority";
import {
  autoApproveMissionApproval,
  type MissionApprovalStore,
  type StoredMissionApproval,
} from "../../authority/executor";
import { createPrismaMissionApprovalStore } from "../../authority/mission-approvals-db";
import {
  assertToolAllowed,
  checkKillSwitchesFirst,
  estimateCostCents,
  type GuardDeps,
} from "./_guard";

export const DRAFTER_TOOLS = Object.freeze([
  "draft.compose",
  "mission_approval.create",
]) as readonly string[];

export type DraftArtifactKind = "outreach" | "brief" | "content";

export interface DrafterInput {
  workspaceId: string;
  missionId?: string | null;
  brief: string;
  artifactKind?: DraftArtifactKind;
  channel?: string;
  audience?: string;
  /** Override the deterministic composer (tests). */
  compose?: (input: DrafterInput) => DraftArtifact | Promise<DraftArtifact>;
}

export interface DrafterDeps extends GuardDeps {
  /** Approval store for the Tier-2 request. Default: Prisma twin (production). */
  approvalStore?: MissionApprovalStore;
  /**
   * Phase 14 (approvals): may a rule approve the request? Default: the
   * workspace's automation rules for the drafter (lib/automation/policy.ts).
   */
  autoDecision?: (input: { workspaceId: string; action: string; description: string }) => Promise<{ auto: boolean; tier: 0 | 1 | 2 | 3; reason: string } | null>;
}

export interface DraftArtifact {
  kind: DraftArtifactKind;
  channel: string;
  audience: string;
  headline: string;
  body: string;
  cta: string;
  /** Always "draft" — the artifact is never sent by this executor. */
  status: "draft";
}

export interface DrafterResult {
  executor: "drafter";
  draft: DraftArtifact;
  /** The Tier-2 approval created INSTEAD of sending. */
  approval: StoredMissionApproval;
  summary: string;
  costCents: number;
}

/**
 * defaultCompose — deterministic draft assembly (M2 has no LLM composer).
 * Produces a structured draft from the brief; clearly marked DRAFT.
 */
function defaultCompose(input: DrafterInput): DraftArtifact {
  const kind = input.artifactKind ?? "content";
  const brief = input.brief.trim();
  const firstSentence = brief.split(/(?<=[.!?])\s/)[0] ?? brief;
  return {
    kind,
    channel: input.channel ?? "owned",
    audience: input.audience ?? "general",
    headline: `DRAFT — ${firstSentence.slice(0, 80)}`,
    body: `DRAFT (not sent, not published):\n\n${brief}\n\n— composed by the Chief Strategy Agent drafter; requires human approval before any external use.`,
    cta: "DRAFT CTA — review before use",
    status: "draft",
  };
}

/**
 * The external action this draft WOULD take if approved. The approval's
 * binding describes the send — the draft itself never sends.
 */
function externalActionFor(kind: DraftArtifactKind, draft: DraftArtifact): { kind: string; description: string } {
  switch (kind) {
    case "outreach":
      return { kind: "outreach_send", description: `Send outreach draft to ${draft.audience} via ${draft.channel}` };
    case "brief":
      return { kind: "publish_brief", description: `Publish campaign brief to ${draft.audience}` };
    case "content":
      return { kind: "publish_content", description: `Publish content draft to ${draft.channel}` };
  }
}

export async function runDrafter(
  input: DrafterInput,
  deps: DrafterDeps = {},
): Promise<DrafterResult> {
  await checkKillSwitchesFirst(input, deps);
  assertToolAllowed("drafter", DRAFTER_TOOLS, "draft.compose");
  if (!input.brief?.trim()) throw new Error("drafter: brief is required.");

  const compose = input.compose ?? defaultCompose;
  const draft = await compose(input);

  // Every external-bound draft creates a Tier-2 approval INSTEAD of sending.
  assertToolAllowed("drafter", DRAFTER_TOOLS, "mission_approval.create");
  const store = deps.approvalStore ?? createPrismaMissionApprovalStore();
  const external = externalActionFor(draft.kind, draft);
  const tier = evaluateTier(
    { kind: external.kind, description: external.description },
    {
      smallActionThresholdCents: 10_000,
      automationAllows: false,
      defaultCurrency: "USD",
      rates: { USD: 1 },
    },
  );
  if (tier !== 2) {
    // Fail closed: an external send that does NOT evaluate Tier 2 is either
    // a hard deny (Tier 3) or a misclassified action — never draft around it.
    throw new Error(
      `drafter: external action "${external.kind}" evaluated Tier ${tier}, not Tier 2 — refusing to create the approval.`,
    );
  }
  const created = await store.create({
    workspaceId: input.workspaceId,
    missionId: input.missionId ?? null,
    action: external.kind,
    tier: 2,
    bindingJson: {
      draft,
      channel: draft.channel,
      audience: draft.audience,
      note: "Draft only — created by the drafter instead of sending. Requires explicit human approval.",
    },
    createdBy: "chief-strategy-agent",
  });

  // Phase 14 (approvals): an automation rule for this action (the drafter's
  // own, else every agent's) approves the request on its authority — audited
  // as a hash-chained "auto_approved" event naming the rule. Without one it
  // waits for a person, as before. Sending still happens only through the
  // approval executor.
  const autoDecision =
    deps.autoDecision ??
    (async (q: { workspaceId: string; action: string; description: string }) => {
      const { autoApprovalFor } = await import("../../automation/policy");
      return autoApprovalFor(q.workspaceId, { agentKey: "drafter", action: q.action, description: q.description });
    });
  const decision = created.missionId
    ? await autoDecision({ workspaceId: input.workspaceId, action: external.kind, description: external.description }).catch(() => null)
    : null;
  const approval = await autoApproveMissionApproval(store, created, decision);

  const summary =
    `Drafted ${draft.kind} for ${draft.audience} via ${draft.channel} (status: draft — NOT sent). ` +
    (approval.status === "approved"
      ? `Tier-2 approval ${approval.id} approved by an automation rule (${decision?.reason ?? "rule"}); the approval executor is the only path to act on it.`
      : `Tier-2 approval ${approval.id} created instead of sending; the approval executor is the only path to act on it.`);

  return {
    executor: "drafter",
    draft,
    approval,
    summary,
    costCents: estimateCostCents(input.brief.length, JSON.stringify(draft).length),
  };
}
