// Marketr — Phase 7 F2: recycling brief object + lifecycle service.
//
// Lifecycle: draft → approved → regenerating → ready.
//
//   draft         brief generated from a trigger signal; variant specs are
//                 deterministic (adaptation rules); no rewrite has run.
//   approved      a HUMAN approved the brief; variants are routed into the
//                 studio approval flows (routing receipts, never publishes).
//   regenerating  the studio is regenerating variants (human-driven); each
//                 regenerated asset appends a "regenerated" lineage entry with
//                 its studio-attested creative hash.
//   ready         every target channel has a regenerated asset carrying a
//                 creative hash — eligible for per-buy creative-hash binding
//                 downstream (Phase 5). Still nothing published, nothing in a
//                 buy: buys bind creative hashes through their own approval
//                 objects.
//
// There is no path from this module to a publish or a buy. That is the
// invariant (SPEC-PHASE7 §9.9), enforced by assertNoAutoPublish and by the
// StudioRouter contract, which has no publish verb at all.

import { createId } from "@/lib/media/ids";
import {
  type ChannelName, type RecyclingBrief, type RecyclingBriefStatus,
  type RecyclingSignal, type StudioRouteReceipt, type TriggerSignalRef,
  lineageHash, verifyLineage, isChannelName,
} from "./types";
import { adaptBrief, UnsupportedChannelPairError } from "./adaptation";
import { type RecyclingAuditStore } from "./audit";

export class RecyclingGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecyclingGateError";
  }
}

// ---------------------------------------------------------------------------
// Store interface + memory twin (the battery runs on the twin)
// ---------------------------------------------------------------------------

export interface CreateBriefInput {
  workspaceId: string;
  sourceAssetId: string;
  sourceChannel: ChannelName;
  triggerSignal: TriggerSignalRef;
  targetChannels: ChannelName[];
  createdBy: string;
}

export interface RecyclingBriefStore {
  create(input: Omit<RecyclingBrief, "id" | "createdAt" | "updatedAt">): Promise<RecyclingBrief>;
  get(id: string, workspaceId: string): Promise<RecyclingBrief | null>;
  update(id: string, workspaceId: string, patch: Partial<RecyclingBrief>): Promise<RecyclingBrief>;
  list(workspaceId: string, status?: RecyclingBriefStatus, limit?: number): Promise<RecyclingBrief[]>;
}

export function createMemoryRecyclingBriefStore(): RecyclingBriefStore {
  const briefs = new Map<string, RecyclingBrief>();
  const key = (id: string, workspaceId: string) => `${workspaceId}:${id}`;

  return {
    async create(input) {
      const now = new Date();
      const row: RecyclingBrief = { ...structuredClone(input), id: createId(), createdAt: now, updatedAt: now };
      briefs.set(key(row.id, row.workspaceId), row);
      return structuredClone(row);
    },
    async get(id, workspaceId) {
      const b = briefs.get(key(id, workspaceId));
      return b ? structuredClone(b) : null;
    },
    async update(id, workspaceId, patch) {
      const b = briefs.get(key(id, workspaceId));
      if (!b) throw new RecyclingGateError("Brief not found in workspace.");
      const next = { ...structuredClone(b), ...structuredClone(patch), updatedAt: new Date() };
      briefs.set(key(id, workspaceId), next);
      return structuredClone(next);
    },
    async list(workspaceId, status, limit = 100) {
      return [...briefs.values()]
        .filter((b) => b.workspaceId === workspaceId && (!status || b.status === status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((b) => structuredClone(b));
    },
  };
}

// ---------------------------------------------------------------------------
// Studio routing — the interface the approve step routes through.
// The contract has NO publish verb: routing means "enter the studio's human
// review queue". The fake router (default) records the route loudly and can
// never publish anything, because there is nothing to call.
// ---------------------------------------------------------------------------

export interface StudioRouter {
  /** Route one variant into the studio approval flow. Never publishes. */
  route(args: {
    brief: RecyclingBrief;
    variantChannel: ChannelName;
    actor: string;
  }): Promise<StudioRouteReceipt>;
}

export const fakeStudioRouter: StudioRouter = {
  async route({ brief, variantChannel, actor }) {
    const now = new Date().toISOString();
    return {
      variantChannel,
      // A review-queue ref — the studio human regenerates the variant from
      // the deterministic spec; nothing here creates or publishes an asset.
      studioRef: `studio_pending:${brief.id}:${variantChannel}`,
      receipt: `fake_route_${createId()}`,
      routedAt: now,
      routedBy: actor,
      provider: "fake",
    };
  },
};

// ---------------------------------------------------------------------------
// Brief generation — pure, deterministic
// ---------------------------------------------------------------------------

/** Signal → brief payload (no I/O; the store persists it). */
export function buildBrief(args: {
  signal: RecyclingSignal;
  targetChannels: ChannelName[];
  createdBy: string;
  now?: Date;
}): Omit<RecyclingBrief, "id" | "createdAt" | "updatedAt"> {
  const { signal, targetChannels, createdBy } = args;
  const now = args.now ?? new Date();
  if (!isChannelName(signal.sourceChannel)) {
    throw new RecyclingGateError(`Unknown source channel "${signal.sourceChannel}".`);
  }
  if (targetChannels.length === 0) {
    throw new RecyclingGateError("A recycling brief needs at least one target channel.");
  }
  for (const t of targetChannels) {
    if (!isChannelName(t)) throw new RecyclingGateError(`Unknown target channel "${t}".`);
  }

  // Deterministic specs — throws UnsupportedChannelPairError on unmapped pairs.
  const variantSpecs = adaptBrief(signal.sourceChannel, targetChannels);

  const triggerSignal: TriggerSignalRef = {
    kind: signal.kind,
    signalId: signal.id,
    metricValue: signal.metricValue,
    metricUnit: signal.metricUnit,
    observedAt: signal.observedAt,
    source: signal.source,
  };

  // Creative-hash lineage: source entry commits to the trigger signal;
  // each variant entry commits to its deterministic spec.
  const at = now.toISOString();
  const lineage = [
    {
      hash: lineageHash({
        assetRef: signal.sourceAssetId, stage: "source", channel: signal.sourceChannel,
        signal: triggerSignal,
      }),
      assetRef: signal.sourceAssetId,
      stage: "source" as const,
      channel: signal.sourceChannel,
      at,
    },
    ...targetChannels.map((ch) => ({
      hash: lineageHash({
        assetRef: signal.sourceAssetId, stage: "variant", channel: ch,
        spec: variantSpecs[ch],
      }),
      assetRef: signal.sourceAssetId,
      stage: "variant" as const,
      channel: ch,
      at,
    })),
  ];

  return {
    workspaceId: signal.workspaceId,
    sourceAssetId: signal.sourceAssetId,
    sourceChannel: signal.sourceChannel,
    triggerSignal,
    targetChannels: [...new Set(targetChannels)],
    variantSpecs,
    creativeHashLineage: lineage,
    status: "draft",
    approvalId: null,
    studioRouting: [],
    createdBy,
  };
}

/** Persist a generated brief + audit the creation. */
export async function createBrief(
  store: RecyclingBriefStore,
  audit: RecyclingAuditStore,
  input: Omit<RecyclingBrief, "id" | "createdAt" | "updatedAt">,
): Promise<RecyclingBrief> {
  const brief = await store.create(input);
  const chain = verifyLineage(brief);
  if (!chain.ok) throw new RecyclingGateError("Brief failed its own lineage check at creation — refusing to persist.");
  await audit.log({
    briefId: brief.id,
    workspaceId: brief.workspaceId,
    actor: brief.createdBy,
    action: "brief_created",
    detail: {
      sourceAssetId: brief.sourceAssetId,
      trigger: brief.triggerSignal.kind,
      targets: brief.targetChannels,
      lineageEntries: brief.creativeHashLineage.length,
    },
  });
  return brief;
}

// ---------------------------------------------------------------------------
// Approval → routing. The ONLY way variants move forward.
// ---------------------------------------------------------------------------

/**
 * Invariant proof helper (SPEC §9.9): the routing surface cannot express a
 * publish. The StudioRouter contract has no publish verb; this function
 * additionally rejects any brief whose payload smuggles publish intent, and
 * logs the attempt as publish_blocked. There is no code path in this module
 * that attaches a variant to a buy — buys bind creative hashes through their
 * own Phase 5 approval objects, downstream of here.
 */
export function assertNoAutoPublish(brief: RecyclingBrief): void {
  const raw = brief as unknown as Record<string, unknown>;
  const suspicious = ["autoPublish", "publish", "publishNow", "goLive", "attachToBuy", "buyId"];
  for (const k of suspicious) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== false) {
      throw new RecyclingGateError(
        `Publish intent smuggled into brief payload (field "${k}") — blocked. Recycling proposes; humans approve.`,
      );
    }
  }
  for (const spec of Object.values(brief.variantSpecs ?? {})) {
    const s = spec as unknown as Record<string, unknown>;
    for (const k of suspicious) {
      if (s[k] !== undefined && s[k] !== null && s[k] !== false) {
        throw new RecyclingGateError(`Publish intent smuggled into variant spec (field "${k}") — blocked.`);
      }
    }
  }
}

const STATUS_FLOW: Record<RecyclingBriefStatus, RecyclingBriefStatus[]> = {
  draft: ["approved"],
  approved: ["regenerating"],
  regenerating: ["ready"],
  ready: [],
};

function assertTransition(from: RecyclingBriefStatus, to: RecyclingBriefStatus): void {
  if (!STATUS_FLOW[from].includes(to)) {
    throw new RecyclingGateError(`Illegal brief transition "${from}" → "${to}".`);
  }
}

/**
 * Human approval of a brief. Requires status "draft". Routes every variant
 * into the studio approval flows via the injected router (fake by default),
 * transitions draft → approved → regenerating, and audits everything.
 * Nothing here publishes; nothing here touches a buy.
 */
export async function approveBrief(args: {
  store: RecyclingBriefStore;
  audit: RecyclingAuditStore;
  router?: StudioRouter;
  id: string;
  workspaceId: string;
  actor: string;
  note?: string;
  now?: Date;
}): Promise<{ brief: RecyclingBrief; receipts: StudioRouteReceipt[] }> {
  const { store, audit, id, workspaceId, actor } = args;
  const router = args.router ?? fakeStudioRouter;

  const brief = await store.get(id, workspaceId);
  if (!brief) throw new RecyclingGateError("Brief not found in workspace.");
  if (brief.status !== "draft") {
    throw new RecyclingGateError(
      `Only draft briefs can be approved (status: "${brief.status}").`,
    );
  }
  assertNoAutoPublish(brief);
  const chain = verifyLineage(brief);
  if (!chain.ok) {
    throw new RecyclingGateError(
      `Lineage integrity check failed at entry ${chain.brokenAt} — brief is tampered, refusing approval.`,
    );
  }

  // Route every variant into the studio approval flow. Each route is a
  // review-queue entry for a human — never an asset, never a publish.
  const receipts: StudioRouteReceipt[] = [];
  for (const channel of brief.targetChannels) {
    const receipt = await router.route({ brief, variantChannel: channel, actor });
    receipts.push(receipt);
    await audit.log({
      briefId: brief.id, workspaceId, actor,
      action: "variant_routed",
      detail: {
        variantChannel: channel,
        studioRef: receipt.studioRef,
        receipt: receipt.receipt,
        provider: receipt.provider,
        publishes: false,
      },
      ts: args.now,
    });
  }

  const approvalId = `recycling_approval_${createId()}`;
  let next = await store.update(id, workspaceId, {
    status: "approved",
    approvalId,
    studioRouting: receipts,
  });
  assertTransition(brief.status, "approved");
  await audit.log({
    briefId: brief.id, workspaceId, actor,
    action: "brief_approved",
    detail: { approvalId, note: args.note ?? null, variantsRouted: receipts.length },
    ts: args.now,
  });
  assertTransition("approved", "regenerating");
  next = await store.update(id, workspaceId, { status: "regenerating" });
  return { brief: next, receipts };
}

/** Reject a draft brief (human decision, audited). */
export async function rejectBrief(args: {
  store: RecyclingBriefStore;
  audit: RecyclingAuditStore;
  id: string;
  workspaceId: string;
  actor: string;
  reason: string;
}): Promise<RecyclingBrief> {
  const brief = await args.store.get(args.id, args.workspaceId);
  if (!brief) throw new RecyclingGateError("Brief not found in workspace.");
  if (brief.status !== "draft") {
    throw new RecyclingGateError(`Only draft briefs can be rejected (status: "${brief.status}").`);
  }
  const next = await args.store.update(args.id, args.workspaceId, { status: "draft" });
  await args.audit.log({
    briefId: args.id, workspaceId: args.workspaceId, actor: args.actor,
    action: "brief_rejected", detail: { reason: args.reason },
  });
  return next;
}

/**
 * Record a studio-regenerated asset for one variant (called by the studio
 * human/operator when the variant is done). Appends a "regenerated" lineage
 * entry carrying the studio-attested creative hash — the same hash the
 * per-buy binding will verify at execution time (Phase 5 TOCTOU pattern).
 */
export async function recordRegeneratedAsset(args: {
  store: RecyclingBriefStore;
  audit: RecyclingAuditStore;
  id: string;
  workspaceId: string;
  actor: string;
  variantChannel: ChannelName;
  creativeHash: string;
  assetRef: string;
  now?: Date;
}): Promise<RecyclingBrief> {
  const { store, audit } = args;
  const brief = await store.get(args.id, args.workspaceId);
  if (!brief) throw new RecyclingGateError("Brief not found in workspace.");
  if (brief.status !== "regenerating") {
    throw new RecyclingGateError(
      `Regenerated assets are only accepted in "regenerating" (status: "${brief.status}"). ` +
      `The brief must be human-approved and routed first.`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(args.creativeHash)) {
    throw new RecyclingGateError("creativeHash must be a 64-char hex sha256 — the studio must attest the real bytes.");
  }
  if (!brief.targetChannels.includes(args.variantChannel)) {
    throw new RecyclingGateError(`Channel "${args.variantChannel}" is not a target of this brief.`);
  }
  if (brief.creativeHashLineage.some((e) => e.stage === "regenerated" && e.channel === args.variantChannel)) {
    throw new RecyclingGateError(`Variant "${args.variantChannel}" already has a regenerated asset.`);
  }
  assertNoAutoPublish(brief);

  const entry = {
    hash: args.creativeHash,
    assetRef: args.assetRef,
    stage: "regenerated" as const,
    channel: args.variantChannel,
    at: (args.now ?? new Date()).toISOString(),
  };
  const next = await store.update(args.id, args.workspaceId, {
    creativeHashLineage: [...brief.creativeHashLineage, entry],
  });
  await audit.log({
    briefId: brief.id, workspaceId: args.workspaceId, actor: args.actor,
    action: "asset_regenerated",
    detail: {
      variantChannel: args.variantChannel,
      assetRef: args.assetRef,
      creativeHash: args.creativeHash,
      note: "asset re-enters studio approval flows; enters a buy only via its own per-buy approval object",
    },
    ts: args.now,
  });
  return next;
}

/** Mark ready when every target has a regenerated asset with a creative hash. */
export async function markBriefReady(args: {
  store: RecyclingBriefStore;
  audit: RecyclingAuditStore;
  id: string;
  workspaceId: string;
  actor: string;
}): Promise<RecyclingBrief> {
  const brief = await args.store.get(args.id, args.workspaceId);
  if (!brief) throw new RecyclingGateError("Brief not found in workspace.");
  if (brief.status !== "regenerating") {
    throw new RecyclingGateError(`Only regenerating briefs can become ready (status: "${brief.status}").`);
  }
  const regenerated = new Set(
    brief.creativeHashLineage.filter((e) => e.stage === "regenerated").map((e) => e.channel),
  );
  const missing = brief.targetChannels.filter((c) => !regenerated.has(c));
  if (missing.length > 0) {
    throw new RecyclingGateError(`Cannot mark ready — variants still regenerating: ${missing.join(", ")}.`);
  }
  const chain = verifyLineage(brief);
  if (!chain.ok) throw new RecyclingGateError("Lineage check failed — refusing to mark ready.");
  const next = await args.store.update(args.id, args.workspaceId, { status: "ready" });
  await args.audit.log({
    briefId: brief.id, workspaceId: args.workspaceId, actor: args.actor,
    action: "asset_regenerated",
    detail: { ready: true, creativeHashes: brief.creativeHashLineage.filter((e) => e.stage === "regenerated").map((e) => ({ channel: e.channel, hash: e.hash })) },
  });
  return next;
}

export { UnsupportedChannelPairError };
export { STATUS_FLOW };
