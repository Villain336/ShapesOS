// Marketr — Phase 6 O1 outreach engine: campaign store + activation.
//
// Activation rules:
// - Depth 1/2: activation flips draft -> active (no checklist; depth 1 has no
//   sending code paths at all, depth 2 sends only via human click + approval).
// - Depth 3: runs the full enablement checklist against the sending domain
//   (assertDepth3Enabled — ANY failure blocks, naming the missing items) AND
//   requires an approved two-person depth3_activation AuthorityApproval whose
//   binding matches the exact activation payload. The approval is executed on
//   activation.
// Prisma store is production; createMemoryCampaignStore() is the battery twin.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import {
  assertDepth3Enabled, type ChecklistFailure,
} from "@/lib/authority/guards";
import { checklistInputFor, warmupDays, type DomainStore } from "./domains";
import { authorityApprovals, authorityAudit } from "@/lib/authority/db";
import { ApprovalError, type AuthorityApproval, sha256Hex, canonicalize } from "@/lib/authority/approvals";
import type { OutreachCampaign, OutreachCampaignStatus } from "@prisma/client";

export interface CampaignCreateInput {
  name: string;
  depth?: 1 | 2 | 3;
  sendingDomainId?: string;
  dailyCap?: number;
  createdBy: string;
}

export interface CampaignStore {
  create(workspaceId: string, input: CampaignCreateInput): Promise<OutreachCampaign>;
  get(id: string, workspaceId: string): Promise<OutreachCampaign | null>;
  list(workspaceId: string): Promise<OutreachCampaign[]>;
  update(id: string, workspaceId: string, data: Partial<OutreachCampaign>): Promise<OutreachCampaign>;
}

export interface Depth3ActivationBinding {
  campaignId: string;
  sendingDomainId: string;
  depth: 3;
  dailyCap: number;
  checklistHash: string; // sha256 of the canonical checklist input at request time
}

export interface ActivationResult {
  campaign: OutreachCampaign;
  checklist: { failures: ChecklistFailure[]; passed: boolean };
  approval?: AuthorityApproval | null;
}

/** Canonical activation binding for a depth-3 campaign (hashed into the approval). */
export function activationBindingFor(
  campaign: Pick<OutreachCampaign, "id" | "dailyCap">,
  sendingDomainId: string,
  checklist: { failures: ChecklistFailure[]; passed: boolean },
): Depth3ActivationBinding {
  return {
    campaignId: campaign.id,
    sendingDomainId,
    depth: 3,
    dailyCap: campaign.dailyCap,
    checklistHash: sha256Hex(canonicalize(checklist)),
  };
}

// ---------------------------------------------------------------------------
// Prisma store
// ---------------------------------------------------------------------------

export function prismaCampaignStore(): CampaignStore {
  async function scoped(id: string, workspaceId: string) {
    const c = await prisma.outreachCampaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw new Error("Outreach campaign not found in workspace.");
    return c;
  }
  return {
    async create(workspaceId, input) {
      const depth = input.depth ?? 1;
      if (![1, 2, 3].includes(depth)) throw new Error("Depth must be 1, 2, or 3.");
      return prisma.outreachCampaign.create({
        data: {
          id: createId(),
          workspaceId,
          name: input.name,
          depth,
          status: "draft",
          sendingDomainId: input.sendingDomainId ?? null,
          dailyCap: Math.min(Math.max(input.dailyCap ?? 30, 1), 50),
          createdBy: input.createdBy,
        },
      });
    },
    get: (id, workspaceId) => prisma.outreachCampaign.findFirst({ where: { id, workspaceId } }),
    list: (workspaceId) => prisma.outreachCampaign.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }),
    async update(id, workspaceId, data) {
      await scoped(id, workspaceId);
      const { id: _id, workspaceId: _ws, createdAt: _ca, ...rest } = data;
      return prisma.outreachCampaign.update({ where: { id }, data: rest as never });
    },
  };
}

// ---------------------------------------------------------------------------
// Memory store (battery twin)
// ---------------------------------------------------------------------------

export function createMemoryCampaignStore(): CampaignStore {
  const rows = new Map<string, OutreachCampaign>();
  function scoped(id: string, workspaceId: string): OutreachCampaign {
    const c = rows.get(id);
    if (!c || c.workspaceId !== workspaceId) throw new Error("Outreach campaign not found in workspace.");
    return c;
  }
  return {
    async create(workspaceId, input) {
      const depth = input.depth ?? 1;
      if (![1, 2, 3].includes(depth)) throw new Error("Depth must be 1, 2, or 3.");
      const c = {
        id: createId(), workspaceId, name: input.name, depth, status: "draft" as OutreachCampaignStatus,
        sendingDomainId: input.sendingDomainId ?? null,
        dailyCap: Math.min(Math.max(input.dailyCap ?? 30, 1), 50),
        warmupVerifiedAt: null, authStatusJson: {}, approvalId: null,
        createdBy: input.createdBy, createdAt: new Date(),
      } satisfies OutreachCampaign;
      rows.set(c.id, c);
      return c;
    },
    async get(id, workspaceId) {
      const c = rows.get(id);
      return c && c.workspaceId === workspaceId ? c : null;
    },
    async list(workspaceId) {
      return [...rows.values()].filter((c) => c.workspaceId === workspaceId);
    },
    async update(id, workspaceId, data) {
      const cur = scoped(id, workspaceId);
      const next = { ...cur, ...data };
      rows.set(id, next);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Activation engine (store-agnostic)
// ---------------------------------------------------------------------------

export interface ActivationDeps {
  campaigns: CampaignStore;
  domains: DomainStore;
}

/**
 * Step 1 of depth-3 activation: run the checklist, then create + submit a
 * depth3_activation approval (pending). Two distinct humans approve it via the
 * generic /api/authority/approvals routes; finalizeDepth3Activation completes.
 * Throws (naming missing items) when the checklist fails.
 */
export async function requestDepth3Activation(
  deps: ActivationDeps,
  opts: { workspaceId: string; campaignId: string; sendingDomainId?: string; actor: string },
): Promise<{ campaign: OutreachCampaign; checklist: { failures: ChecklistFailure[]; passed: boolean }; approval: AuthorityApproval }> {
  const { campaigns, domains } = deps;
  let campaign = await campaigns.get(opts.campaignId, opts.workspaceId);
  if (!campaign) throw new Error("Outreach campaign not found in workspace.");
  if (campaign.depth !== 3) throw new Error("Depth-3 activation applies only to depth-3 campaigns.");

  const sendingDomainId = opts.sendingDomainId ?? campaign.sendingDomainId;
  if (!sendingDomainId) {
    throw new Error("A sending domain is required for depth-3 activation.");
  }
  const domain = await domains.get(sendingDomainId, opts.workspaceId);
  if (!domain) throw new Error("Sending domain not found in workspace.");

  // The checklist is law: ANY failure blocks, with the missing items named.
  const failures = assertChecklistOrThrow(domain);
  const checklist = { failures, passed: true };

  campaign = await campaigns.update(campaign.id, opts.workspaceId, {
    sendingDomainId,
    status: "checklist_pending",
    authStatusJson: {
      checklist: "pass",
      checkedAt: new Date().toISOString(),
      warmupDays: warmupDays({ warmupStartedAt: domain.warmupStartedAt }),
    } as never,
  });

  const binding = activationBindingFor(campaign, sendingDomainId, checklist);
  let approval = await authorityApprovals.create({
    workspaceId: opts.workspaceId,
    type: "depth3_activation",
    bindingJson: binding as unknown as Record<string, unknown>,
    createdBy: opts.actor,
  });
  approval = await authorityApprovals.submit(approval.id, opts.workspaceId, opts.actor);

  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId,
    actor: opts.actor,
    action: "depth3_activation_requested",
    entityType: "outreach_campaign",
    entityId: campaign.id,
    detail: { approvalId: approval.id, sendingDomainId, dailyCap: campaign.dailyCap },
  });

  return { campaign, checklist, approval };
}

/** Run the checklist; throw naming every missing item when it fails. */
function assertChecklistOrThrow(domain: Parameters<typeof checklistInputFor>[0]): ChecklistFailure[] {
  assertDepth3Enabled(checklistInputFor(domain));
  return [];
}

/**
 * Step 2: finalize depth-3 activation with an approved two-person approval.
 * Re-runs the checklist (fail-closed if anything changed), verifies the
 * approval binding matches the exact activation payload, executes it, and
 * flips the campaign active.
 */
export async function finalizeDepth3Activation(
  deps: ActivationDeps,
  opts: { workspaceId: string; campaignId: string; approvalId: string; actor: string },
): Promise<ActivationResult> {
  const { campaigns, domains } = deps;
  let campaign = await campaigns.get(opts.campaignId, opts.workspaceId);
  if (!campaign) throw new Error("Outreach campaign not found in workspace.");
  if (campaign.depth !== 3) throw new Error("Depth-3 activation applies only to depth-3 campaigns.");
  if (!campaign.sendingDomainId) throw new Error("A sending domain is required for depth-3 activation.");
  const domain = await domains.get(campaign.sendingDomainId, opts.workspaceId);
  if (!domain) throw new Error("Sending domain not found in workspace.");

  const failures = assertChecklistOrThrow(domain);
  const checklist = { failures, passed: true };

  const approval = await authorityApprovals.get(opts.approvalId, opts.workspaceId);
  if (!approval) throw new ApprovalError("Depth-3 activation approval not found in workspace.");
  if (approval.type !== "depth3_activation") throw new ApprovalError("Approval is not a depth3_activation approval.");
  if (approval.status !== "approved") {
    throw new ApprovalError(`Depth-3 activation requires an approved two-person approval (status: ${approval.status}).`);
  }
  if (new Set(approval.approvers).size < 2) {
    throw new ApprovalError("Depth-3 activation requires two distinct approvers.");
  }

  const binding = activationBindingFor(campaign, campaign.sendingDomainId, checklist);
  await authorityApprovals.execute(approval.id, opts.workspaceId, binding as unknown as Record<string, unknown>);

  campaign = await campaigns.update(campaign.id, opts.workspaceId, {
    status: "active",
    approvalId: approval.id,
    warmupVerifiedAt: new Date(),
    authStatusJson: {
      checklist: "pass",
      activatedAt: new Date().toISOString(),
      approvers: approval.approvers,
      warmupDays: warmupDays({ warmupStartedAt: domain.warmupStartedAt }),
    } as never,
  });

  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId,
    actor: opts.actor,
    action: "depth3_activated",
    entityType: "outreach_campaign",
    entityId: campaign.id,
    detail: { approvalId: approval.id, approvers: approval.approvers },
  });

  return { campaign, checklist, approval };
}

/** Activate a depth-1 or depth-2 campaign (draft -> active; no checklist, no sends). */
export async function activateShallowCampaign(
  deps: ActivationDeps,
  opts: { workspaceId: string; campaignId: string; actor: string },
): Promise<OutreachCampaign> {
  const campaign = await deps.campaigns.get(opts.campaignId, opts.workspaceId);
  if (!campaign) throw new Error("Outreach campaign not found in workspace.");
  if (campaign.depth === 3) throw new Error("Use the depth-3 activation flow for depth-3 campaigns.");
  const updated = await deps.campaigns.update(campaign.id, opts.workspaceId, { status: "active" });
  await authorityAudit.logAsync({
    workspaceId: opts.workspaceId,
    actor: opts.actor,
    action: "campaign_activated",
    entityType: "outreach_campaign",
    entityId: campaign.id,
    detail: { depth: campaign.depth },
  });
  return updated;
}
