// Marketr — Phase 7 F2: prisma-backed stores for recycling briefs + audit.
//
// The Phase 7 recycling fragment (prisma/fragments/phase7-recycling.prisma)
// is merged into prisma/schema.prisma by the coordinator AFTER all tracks
// land, so the generated client does not know these models yet. This module
// therefore talks raw SQL against the fragment's table names. Once the
// fragment is merged and the client regenerated, this can be replaced with
// a typed store — the RecyclingBriefStore / RecyclingAuditStore interfaces
// stay the same.
//
// Until then, recyclingTablesReady() is false and the API routes return 503,
// exactly like the Phase 5 media routes pre-migration.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import {
  type ChannelName, type RecyclingBrief, type RecyclingBriefStatus,
  type StudioRouteReceipt, type TriggerSignalRef, type VariantSpec,
} from "./types";
import {
  type CreateBriefInput, type RecyclingBriefStore,
} from "./briefs";
import {
  type RecyclingAuditAction, type RecyclingAuditEvent, type RecyclingAuditInput,
  type RecyclingAuditStore, auditEventHash,
} from "./audit";
import { canonicalize } from "@/lib/media/approvals";
import { sha256Hex } from "@/lib/media/safety";

/** True when the Phase 7 recycling tables exist (fragment merged + migrated). */
export async function recyclingTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM recycling_briefs LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

type BriefRow = {
  id: string;
  workspace_id: string;
  source_asset_id: string;
  source_channel: string;
  trigger_signal_json: unknown;
  target_channels: string[];
  variant_specs_json: unknown;
  creative_hash_lineage_json: unknown;
  status: string;
  approval_id: string | null;
  studio_routing_json: unknown;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

function toBrief(r: BriefRow): RecyclingBrief {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sourceAssetId: r.source_asset_id,
    sourceChannel: r.source_channel as ChannelName,
    triggerSignal: (r.trigger_signal_json ?? {}) as TriggerSignalRef,
    targetChannels: (r.target_channels ?? []) as ChannelName[],
    variantSpecs: (r.variant_specs_json ?? {}) as Record<string, VariantSpec>,
    creativeHashLineage: (Array.isArray(r.creative_hash_lineage_json)
      ? r.creative_hash_lineage_json
      : []) as RecyclingBrief["creativeHashLineage"],
    status: r.status as RecyclingBriefStatus,
    approvalId: r.approval_id,
    studioRouting: (Array.isArray(r.studio_routing_json)
      ? r.studio_routing_json
      : []) as StudioRouteReceipt[],
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function prismaRecyclingBriefStore(): RecyclingBriefStore {
  return {
    async create(input: CreateBriefInput & {
      triggerSignal: TriggerSignalRef;
      variantSpecs: Record<string, VariantSpec>;
      creativeHashLineage: RecyclingBrief["creativeHashLineage"];
      status: RecyclingBriefStatus;
      approvalId: string | null;
      studioRouting: StudioRouteReceipt[];
    }) {
      const id = createId();
      await prisma.$executeRaw`
        INSERT INTO recycling_briefs (
          id, workspace_id, source_asset_id, source_channel, trigger_signal_json,
          target_channels, variant_specs_json, creative_hash_lineage_json, status,
          approval_id, studio_routing_json, created_by
        ) VALUES (
          ${id}, ${input.workspaceId}, ${input.sourceAssetId}, ${input.sourceChannel},
          ${JSON.stringify(input.triggerSignal)}::jsonb,
          ${input.targetChannels}::text[],
          ${JSON.stringify(input.variantSpecs)}::jsonb,
          ${JSON.stringify(input.creativeHashLineage)}::jsonb,
          ${input.status},
          ${input.approvalId},
          ${JSON.stringify(input.studioRouting)}::jsonb,
          ${input.createdBy}
        )`;
      return (await this.get(id, input.workspaceId))!;
    },
    async get(id, workspaceId) {
      const rows = await prisma.$queryRaw<BriefRow[]>`
        SELECT id, workspace_id, source_asset_id, source_channel, trigger_signal_json,
               target_channels, variant_specs_json, creative_hash_lineage_json, status,
               approval_id, studio_routing_json, created_by, created_at, updated_at
        FROM recycling_briefs WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return rows.length ? toBrief(rows[0]) : null;
    },
    async update(id, workspaceId, patch) {
      const cur = await this.get(id, workspaceId);
      if (!cur) throw new Error("Brief not found in workspace.");
      const next = { ...cur, ...patch };
      await prisma.$executeRaw`
        UPDATE recycling_briefs SET
          source_asset_id = ${next.sourceAssetId},
          source_channel = ${next.sourceChannel},
          trigger_signal_json = ${JSON.stringify(next.triggerSignal)}::jsonb,
          target_channels = ${next.targetChannels}::text[],
          variant_specs_json = ${JSON.stringify(next.variantSpecs)}::jsonb,
          creative_hash_lineage_json = ${JSON.stringify(next.creativeHashLineage)}::jsonb,
          status = ${next.status},
          approval_id = ${next.approvalId},
          studio_routing_json = ${JSON.stringify(next.studioRouting)}::jsonb,
          updated_at = NOW()
        WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return (await this.get(id, workspaceId))!;
    },
    async list(workspaceId, status, limit = 100) {
      const rows = status
        ? await prisma.$queryRaw<BriefRow[]>`
            SELECT id, workspace_id, source_asset_id, source_channel, trigger_signal_json,
                   target_channels, variant_specs_json, creative_hash_lineage_json, status,
                   approval_id, studio_routing_json, created_by, created_at, updated_at
            FROM recycling_briefs
            WHERE workspace_id = ${workspaceId} AND status = ${status}
            ORDER BY created_at DESC LIMIT ${limit}`
        : await prisma.$queryRaw<BriefRow[]>`
            SELECT id, workspace_id, source_asset_id, source_channel, trigger_signal_json,
                   target_channels, variant_specs_json, creative_hash_lineage_json, status,
                   approval_id, studio_routing_json, created_by, created_at, updated_at
            FROM recycling_briefs
            WHERE workspace_id = ${workspaceId}
            ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.map(toBrief);
    },
  };
}

// NOTE: this module uses raw SQL (not the generated client) because the
// Phase 7 recycling fragment is merged into prisma/schema.prisma by the
// coordinator after all tracks land. The coordinator's typed-store swap only
// needs to replace this file's internals — the store interfaces are stable.

type AuditRow = {
  id: string;
  brief_id: string;
  workspace_id: string;
  ts: Date;
  actor: string;
  action: string;
  payload_hash: string;
  prev_hash: string;
  event_hash: string;
  detail: unknown;
};

function toAuditEvent(r: AuditRow): RecyclingAuditEvent {
  return {
    id: r.id,
    briefId: r.brief_id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    actor: r.actor,
    action: r.action as RecyclingAuditAction,
    payloadHash: r.payload_hash,
    prevHash: r.prev_hash,
    eventHash: r.event_hash,
    detail: (r.detail ?? null) as Record<string, unknown> | null,
  };
}

export function prismaRecyclingAuditStore(): RecyclingAuditStore {
  return {
    async log(input: RecyclingAuditInput) {
      const ts = input.ts ?? new Date();
      const payloadHash = sha256Hex(canonicalize(input.detail ?? {}));
      const prev = await prisma.$queryRaw<{ event_hash: string }[]>`
        SELECT event_hash FROM recycling_brief_events
        WHERE brief_id = ${input.briefId} AND workspace_id = ${input.workspaceId}
        ORDER BY ts DESC LIMIT 1`;
      const prevHash = prev.length ? prev[0].event_hash : "GENESIS";
      const eventHash = auditEventHash(prevHash, {
        briefId: input.briefId,
        ts: ts.toISOString(),
        actor: input.actor,
        action: input.action,
        payloadHash,
      });
      const id = createId();
      await prisma.$executeRaw`
        INSERT INTO recycling_brief_events
          (id, brief_id, workspace_id, ts, actor, action, payload_hash, prev_hash, event_hash, detail)
        VALUES (${id}, ${input.briefId}, ${input.workspaceId}, ${ts}, ${input.actor},
                ${input.action}, ${payloadHash}, ${prevHash}, ${eventHash},
                ${JSON.stringify(input.detail ?? null)}::jsonb)`;
      const rows = await prisma.$queryRaw<AuditRow[]>`
        SELECT id, brief_id, workspace_id, ts, actor, action, payload_hash, prev_hash, event_hash, detail
        FROM recycling_brief_events WHERE id = ${id}`;
      return toAuditEvent(rows[0]);
    },
    async list(briefId, workspaceId, limit = 200) {
      const rows = await prisma.$queryRaw<AuditRow[]>`
        SELECT id, brief_id, workspace_id, ts, actor, action, payload_hash, prev_hash, event_hash, detail
        FROM recycling_brief_events
        WHERE brief_id = ${briefId} AND workspace_id = ${workspaceId}
        ORDER BY ts ASC LIMIT ${limit}`;
      return rows.map(toAuditEvent);
    },
    async verifyChain(briefId, workspaceId) {
      const events = await this.list(briefId, workspaceId, 10000);
      let prev = "GENESIS";
      for (const e of events) {
        const recomputed = auditEventHash(prev, {
          briefId: e.briefId,
          ts: e.ts.toISOString(),
          actor: e.actor,
          action: e.action,
          payloadHash: e.payloadHash,
        });
        if (recomputed !== e.eventHash) return { ok: false as const, brokenAt: e.id };
        prev = e.eventHash;
      }
      return { ok: true as const };
    },
  };
}
