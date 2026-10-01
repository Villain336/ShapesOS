// Marketr — Phase 18 slice 1: the bounded governed-action surface.
//
// ONE entry point humans and agents use: runAdsAction(). Every slug in the
// ADS_GOVERNED_ACTIONS catalog routes here; unknown slugs throw. Spend
// actions (launch / pause / adjust_budget) can only execute through the
// spend gate (./gate.ts) — this dispatcher never touches a platform API
// directly.
//
// Platform executors register per platform in later slices
// (amazon → slice 2, stackadapt → slice 3, walmart → slice 4, spotify is
// guided-only and never executes). Until a platform's executor registers,
// launch/pause fail closed with PLATFORM_NOT_CONNECTED.

import {
  approveSpendAction,
  executeSpendAction,
  proposeBudgetChange,
  proposeSpendAction,
  rejectSpendAction,
  type SpendApprovalStore,
  type SpendProposalStore,
} from "./gate";
import { adsActionDef, type AdsPlatformKey } from "./types";

export class AdsActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdsActionError";
    this.code = code;
  }
}

/** Platform API executor — registered by each platform slice. */
export type AdsPlatformExecutor = (input: {
  platformKey: AdsPlatformKey;
  action: "launch" | "pause" | "adjust_budget";
  payload: Record<string, unknown>;
  approvalId: string;
}) => Promise<{ platformReceiptId: string; externalId?: string }>;

const executors = new Map<AdsPlatformKey, AdsPlatformExecutor>();

/** Called by each platform connector slice to register its executor. */
export function registerAdsExecutor(platformKey: AdsPlatformKey, executor: AdsPlatformExecutor) {
  executors.set(platformKey, executor);
}

export interface AdsActionContext {
  workspaceId: string;
  actor: string;
  proposals: SpendProposalStore;
  approvals: SpendApprovalStore;
}

export type AdsActionArgs = Record<string, unknown>;

/**
 * Run one governed action. Reads and proposals run freely (logged by the
 * caller); approvals and executions go through the spend gate.
 */
export async function runAdsAction(
  ctx: AdsActionContext,
  slug: string,
  args: AdsActionArgs = {},
): Promise<unknown> {
  const def = adsActionDef(slug); // throws on unknown slug — fail closed
  switch (def.slug) {
    case "propose_campaign": {
      const kind = (args.kind as "launch" | "pause" | "budget_change" | "new_flight") ?? "launch";
      if (kind === "budget_change") {
        return proposeBudgetChange(ctx.proposals, {
          workspaceId: ctx.workspaceId,
          targetType: (args.targetType as "campaign" | "group") ?? "campaign",
          targetId: args.targetId as string,
          payload: (args.payload as Record<string, unknown>) ?? {},
          proposedBy: ctx.actor,
        });
      }
      return proposeSpendAction(ctx.proposals, {
        workspaceId: ctx.workspaceId,
        kind,
        action: kind === "launch" ? "launch" : kind === "pause" ? "pause" : "new_flight",
        targetType: (args.targetType as "campaign" | "group") ?? "campaign",
        targetId: args.targetId as string,
        payload: (args.payload as Record<string, unknown>) ?? {},
        proposedBy: ctx.actor,
        platformKey: args.platformKey as AdsPlatformKey | undefined,
      });
    }
    case "approve_spend":
      return approveSpendAction(ctx.proposals, ctx.approvals, args.proposalId as string, ctx.actor);
    case "launch":
    case "pause":
    case "adjust_budget": {
      const platformKey = args.platformKey as AdsPlatformKey;
      const executor = executors.get(platformKey);
      if (!executor) {
        throw new AdsActionError(
          "PLATFORM_NOT_CONNECTED",
          `No executor registered for ${platformKey ?? "unknown platform"} — its connector slice has not landed yet`,
        );
      }
      return executeSpendAction(
        ctx.proposals,
        ctx.approvals,
        {
          workspaceId: ctx.workspaceId,
          proposalId: args.proposalId as string,
          payload: (args.payload as Record<string, unknown>) ?? {},
        },
        async ({ proposal, approval, payload }) => {
          const receipt = await executor({
            platformKey,
            action: def.slug as "launch" | "pause" | "adjust_budget",
            payload,
            approvalId: approval.id,
          });
          return { proposalId: proposal.id, approvalId: approval.id, ...receipt };
        },
      );
    }
    case "pull_report":
      // Slice 1: reporting reads are served by lib/adplatforms/reporting.ts.
      // Returns the query descriptor; the UI layer resolves rows via Prisma.
      return {
        action: "pull_report",
        workspaceId: ctx.workspaceId,
        filters: {
          platformKey: args.platformKey,
          campaignId: args.campaignId,
          from: args.from,
          to: args.to,
        },
      };
    case "connect_account":
      // The OAuth start itself lives in ./oauth.ts (needs request base URL);
      // this surface validates the slug and returns the platform's auth kind.
      return { action: "connect_account", platformKey: args.platformKey };
    default:
      // Unreachable: adsActionDef throws on unknown slugs. Defense in depth.
      throw new AdsActionError("UNKNOWN_ACTION", `No handler for ads action: ${def.slug}`);
  }
}

export { rejectSpendAction };
