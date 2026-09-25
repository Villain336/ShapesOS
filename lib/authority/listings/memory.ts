// Marketr — Phase 6 L1: memory twins for the listings track.
//
// Pure in-memory implementation of the listing store interface, used by
// batteries. Mirrors lib/authority/approvals.ts' createMemoryAuthorityApprovalStore
// pattern. The prisma twin lives in ./store.ts.

import { createId } from "@/lib/media/ids";
import { scheduleNextEdit, type GbpEditRequest } from "./gbp";
import type { ListingTier } from "./tiers";
import type { DirectoryEntry } from "./briefs";

export interface ChannelRow {
  id: string;
  workspaceId: string;
  channel: string;
  tier: ListingTier;
  status: string;
  lastSyncAt: Date | null;
  lastVerifiedAt: Date | null;
  syncErrorsJson: unknown[];
  configJson: Record<string, unknown>;
}

export interface ProfileRow {
  id: string;
  workspaceId: string;
  channel: string;
  locationRef: string;
  napJson: Record<string, unknown>;
  hoursJson: Record<string, unknown>;
  attributesJson: Record<string, unknown>;
  photosJson: string[];
  verificationStatus: string;
}

export type SyncJobStatus = "queued" | "executed" | "failed";

export interface SyncJobRow {
  id: string;
  workspaceId: string;
  channel: string;
  profileId: string;
  payloadJson: GbpEditRequest;
  approvalId: string | null;
  status: SyncJobStatus;
  scheduledAt: Date;
  executedAt: Date | null;
  error: string | null;
}

export interface BriefRow {
  id: string;
  workspaceId: string;
  competitorGapJson: Record<string, unknown>;
  directoriesJson: DirectoryEntry[];
  checklistStatus: string;
  createdAt: Date;
}

export interface ListingStore {
  channels: {
    upsert(input: { workspaceId: string; channel: string; tier: ListingTier; config?: Record<string, unknown> }): Promise<ChannelRow>;
    list(workspaceId: string): Promise<ChannelRow[]>;
    get(workspaceId: string, channel: string): Promise<ChannelRow | null>;
    patch(workspaceId: string, channel: string, patch: Partial<ChannelRow>): Promise<ChannelRow>;
  };
  profiles: {
    create(input: { workspaceId: string; channel: string; locationRef: string; nap?: Record<string, unknown>; hours?: Record<string, unknown>; attributes?: Record<string, unknown>; photos?: string[] }): Promise<ProfileRow>;
    get(id: string, workspaceId: string): Promise<ProfileRow | null>;
    list(workspaceId: string): Promise<ProfileRow[]>;
  };
  jobs: {
    /** Cap-aware enqueue: burst jobs queue with scheduled_at spacing, never dropped. */
    enqueue(workspaceId: string, edit: GbpEditRequest, approvalId: string | null): Promise<SyncJobRow>;
    listDue(workspaceId: string, now?: Date): Promise<SyncJobRow[]>;
    markExecuted(id: string, workspaceId: string): Promise<void>;
    markFailed(id: string, workspaceId: string, error: string): Promise<void>;
    queuedForProfile(workspaceId: string, profileId: string): Promise<SyncJobRow[]>;
  };
  briefs: {
    create(input: { workspaceId: string; competitorGapJson: Record<string, unknown>; directoriesJson: DirectoryEntry[] }): Promise<BriefRow>;
    get(id: string, workspaceId: string): Promise<BriefRow | null>;
    list(workspaceId: string): Promise<BriefRow[]>;
    update(id: string, workspaceId: string, patch: { directoriesJson?: DirectoryEntry[]; checklistStatus?: string }): Promise<BriefRow>;
  };
}

function scoped<T extends { workspaceId: string; id: string }>(map: Map<string, T>, id: string, workspaceId: string, what: string): T {
  const r = map.get(id);
  if (!r || r.workspaceId !== workspaceId) throw new Error(`${what} not found in workspace.`);
  return r;
}

export function createMemoryListingStore(): ListingStore {
  const channels = new Map<string, ChannelRow>();
  const profiles = new Map<string, ProfileRow>();
  const jobs = new Map<string, SyncJobRow>();
  const briefs = new Map<string, BriefRow>();

  return {
    channels: {
      async upsert(input) {
        const key = `${input.workspaceId}:${input.channel}`;
        const existing = channels.get(key);
        const row: ChannelRow = existing
          ? { ...existing, tier: input.tier, configJson: input.config ?? existing.configJson }
          : {
              id: createId(), workspaceId: input.workspaceId, channel: input.channel, tier: input.tier,
              status: "disconnected", lastSyncAt: null, lastVerifiedAt: null,
              syncErrorsJson: [], configJson: input.config ?? {},
            };
        channels.set(key, row);
        return row;
      },
      async list(workspaceId) {
        return [...channels.values()].filter((c) => c.workspaceId === workspaceId);
      },
      async get(workspaceId, channel) {
        return channels.get(`${workspaceId}:${channel}`) ?? null;
      },
      async patch(workspaceId, channel, patch) {
        const key = `${workspaceId}:${channel}`;
        const row = channels.get(key);
        if (!row) throw new Error("Channel not found in workspace.");
        const next = { ...row, ...patch, id: row.id, workspaceId: row.workspaceId, channel: row.channel };
        channels.set(key, next);
        return next;
      },
    },
    profiles: {
      async create(input) {
        const row: ProfileRow = {
          id: createId(), workspaceId: input.workspaceId, channel: input.channel, locationRef: input.locationRef,
          napJson: input.nap ?? {}, hoursJson: input.hours ?? {}, attributesJson: input.attributes ?? {},
          photosJson: input.photos ?? [], verificationStatus: "unverified",
        };
        profiles.set(row.id, row);
        return row;
      },
      async get(id, workspaceId) {
        const r = profiles.get(id);
        return r && r.workspaceId === workspaceId ? r : null;
      },
      async list(workspaceId) {
        return [...profiles.values()].filter((p) => p.workspaceId === workspaceId);
      },
    },
    jobs: {
      async enqueue(workspaceId, edit, approvalId) {
        const ahead = [...jobs.values()]
          .filter((j) => j.workspaceId === workspaceId && j.profileId === edit.profileId && j.status === "queued")
          .map((j) => j.scheduledAt);
        const scheduledAt = scheduleNextEdit(ahead);
        const row: SyncJobRow = {
          id: createId(), workspaceId, channel: "gbp", profileId: edit.profileId,
          payloadJson: edit, approvalId, status: "queued",
          scheduledAt, executedAt: null, error: null,
        };
        jobs.set(row.id, row);
        return row;
      },
      async listDue(workspaceId, now = new Date()) {
        return [...jobs.values()]
          .filter((j) => j.workspaceId === workspaceId && j.status === "queued" && j.scheduledAt.getTime() <= now.getTime())
          .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
      },
      async markExecuted(id, workspaceId) {
        const j = scoped(jobs, id, workspaceId, "Sync job");
        j.status = "executed";
        j.executedAt = new Date();
      },
      async markFailed(id, workspaceId, error) {
        const j = scoped(jobs, id, workspaceId, "Sync job");
        j.status = "failed";
        j.error = error;
      },
      async queuedForProfile(workspaceId, profileId) {
        return [...jobs.values()]
          .filter((j) => j.workspaceId === workspaceId && j.profileId === profileId && j.status === "queued")
          .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
      },
    },
    briefs: {
      async create(input) {
        const row: BriefRow = {
          id: createId(), workspaceId: input.workspaceId,
          competitorGapJson: input.competitorGapJson, directoriesJson: input.directoriesJson,
          checklistStatus: "draft", createdAt: new Date(),
        };
        briefs.set(row.id, row);
        return row;
      },
      async get(id, workspaceId) {
        const r = briefs.get(id);
        return r && r.workspaceId === workspaceId ? r : null;
      },
      async list(workspaceId) {
        return [...briefs.values()].filter((b) => b.workspaceId === workspaceId);
      },
      async update(id, workspaceId, patch) {
        const r = scoped(briefs, id, workspaceId, "Citation brief");
        if (patch.directoriesJson) r.directoriesJson = patch.directoriesJson;
        if (patch.checklistStatus) r.checklistStatus = patch.checklistStatus;
        return r;
      },
    },
  };
}
