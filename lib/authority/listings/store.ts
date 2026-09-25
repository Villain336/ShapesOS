// Marketr — Phase 6 L1 listings: prisma-backed listing store.
//
// Same interface as the memory twin in ./memory.ts. All queries are
// workspace-scoped.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import type { Prisma, ChannelStatus, CitationBriefStatus } from "@prisma/client";
import { scheduleNextEdit, type GbpEditRequest } from "./gbp";
import type { ListingTier } from "./tiers";
import type {
  ListingStore, ChannelRow, ProfileRow, SyncJobRow, BriefRow, SyncJobStatus,
} from "./memory";
import type { DirectoryEntry } from "./briefs";

function jsonInput(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

function toChannel(r: {
  id: string; workspaceId: string; channel: string; tier: string; status: string;
  lastSyncAt: Date | null; lastVerifiedAt: Date | null; syncErrorsJson: unknown; configJson: unknown;
}): ChannelRow {
  return {
    id: r.id, workspaceId: r.workspaceId, channel: r.channel, tier: r.tier as ListingTier,
    status: r.status, lastSyncAt: r.lastSyncAt, lastVerifiedAt: r.lastVerifiedAt,
    syncErrorsJson: Array.isArray(r.syncErrorsJson) ? r.syncErrorsJson : [],
    configJson: (r.configJson ?? {}) as Record<string, unknown>,
  };
}

function toProfile(r: {
  id: string; workspaceId: string; channel: string; locationRef: string;
  napJson: unknown; hoursJson: unknown; attributesJson: unknown; photosJson: unknown;
  verificationStatus: string;
}): ProfileRow {
  return {
    id: r.id, workspaceId: r.workspaceId, channel: r.channel, locationRef: r.locationRef,
    napJson: (r.napJson ?? {}) as Record<string, unknown>,
    hoursJson: (r.hoursJson ?? {}) as Record<string, unknown>,
    attributesJson: (r.attributesJson ?? {}) as Record<string, unknown>,
    photosJson: Array.isArray(r.photosJson) ? (r.photosJson as string[]) : [],
    verificationStatus: r.verificationStatus,
  };
}

function toJob(r: {
  id: string; workspaceId: string; channel: string; profileId: string;
  payloadJson: unknown; approvalId: string | null; status: string;
  scheduledAt: Date; executedAt: Date | null; error: string | null;
}): SyncJobRow {
  return {
    id: r.id, workspaceId: r.workspaceId, channel: r.channel, profileId: r.profileId,
    payloadJson: r.payloadJson as GbpEditRequest, approvalId: r.approvalId,
    status: r.status as SyncJobStatus, scheduledAt: r.scheduledAt,
    executedAt: r.executedAt, error: r.error,
  };
}

function toBrief(r: {
  id: string; workspaceId: string; competitorGapJson: unknown;
  directoriesJson: unknown; checklistStatus: string; createdAt: Date;
}): BriefRow {
  return {
    id: r.id, workspaceId: r.workspaceId,
    competitorGapJson: (r.competitorGapJson ?? {}) as Record<string, unknown>,
    directoriesJson: (Array.isArray(r.directoriesJson) ? r.directoriesJson : []) as DirectoryEntry[],
    checklistStatus: r.checklistStatus, createdAt: r.createdAt,
  };
}

export function createPrismaListingStore(): ListingStore {
  return {
    channels: {
      async upsert(input) {
        const r = await prisma.listingChannel.upsert({
          where: { workspaceId_channel: { workspaceId: input.workspaceId, channel: input.channel } },
          create: {
            id: createId(), workspaceId: input.workspaceId, channel: input.channel,
            tier: input.tier, configJson: jsonInput(input.config ?? {}),
          },
          update: { tier: input.tier, ...(input.config !== undefined ? { configJson: jsonInput(input.config) } : {}) },
        });
        return toChannel(r);
      },
      async list(workspaceId) {
        const rows = await prisma.listingChannel.findMany({ where: { workspaceId } });
        return rows.map(toChannel);
      },
      async get(workspaceId, channel) {
        const r = await prisma.listingChannel.findFirst({ where: { workspaceId, channel } });
        return r ? toChannel(r) : null;
      },
      async patch(workspaceId, channel, patch) {
        const existing = await prisma.listingChannel.findFirst({ where: { workspaceId, channel } });
        if (!existing) throw new Error("Channel not found in workspace.");
        const r = await prisma.listingChannel.update({
          where: { id: existing.id },
          data: {
            ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
            ...(patch.status !== undefined ? { status: patch.status as ChannelStatus } : {}),
            ...(patch.lastSyncAt !== undefined ? { lastSyncAt: patch.lastSyncAt } : {}),
            ...(patch.lastVerifiedAt !== undefined ? { lastVerifiedAt: patch.lastVerifiedAt } : {}),
            ...(patch.syncErrorsJson !== undefined ? { syncErrorsJson: jsonInput(patch.syncErrorsJson) } : {}),
            ...(patch.configJson !== undefined ? { configJson: jsonInput(patch.configJson) } : {}),
          },
        });
        return toChannel(r);
      },
    },
    profiles: {
      async create(input) {
        const r = await prisma.listingProfile.create({
          data: {
            id: createId(), workspaceId: input.workspaceId, channel: input.channel,
            locationRef: input.locationRef,
            napJson: jsonInput(input.nap ?? {}), hoursJson: jsonInput(input.hours ?? {}),
            attributesJson: jsonInput(input.attributes ?? {}), photosJson: jsonInput(input.photos ?? []),
          },
        });
        return toProfile(r);
      },
      async get(id, workspaceId) {
        const r = await prisma.listingProfile.findFirst({ where: { id, workspaceId } });
        return r ? toProfile(r) : null;
      },
      async list(workspaceId) {
        const rows = await prisma.listingProfile.findMany({ where: { workspaceId } });
        return rows.map(toProfile);
      },
    },
    jobs: {
      async enqueue(workspaceId, edit, approvalId) {
        const ahead = await prisma.listingSyncJob.findMany({
          where: { workspaceId, profileId: edit.profileId, status: "queued" },
          orderBy: { scheduledAt: "desc" },
          select: { scheduledAt: true },
        });
        const scheduledAt = scheduleNextEdit(ahead.map((j) => j.scheduledAt));
        const r = await prisma.listingSyncJob.create({
          data: {
            id: createId(), workspaceId, channel: "gbp", profileId: edit.profileId,
            payloadJson: jsonInput(edit), approvalId, scheduledAt,
          },
        });
        return toJob(r);
      },
      async listDue(workspaceId, now = new Date()) {
        const rows = await prisma.listingSyncJob.findMany({
          where: { workspaceId, status: "queued", scheduledAt: { lte: now } },
          orderBy: { scheduledAt: "asc" },
        });
        return rows.map(toJob);
      },
      async markExecuted(id, workspaceId) {
        const r = await prisma.listingSyncJob.findFirst({ where: { id, workspaceId } });
        if (!r) throw new Error("Sync job not found in workspace.");
        await prisma.listingSyncJob.update({ where: { id }, data: { status: "executed", executedAt: new Date() } });
      },
      async markFailed(id, workspaceId, error) {
        const r = await prisma.listingSyncJob.findFirst({ where: { id, workspaceId } });
        if (!r) throw new Error("Sync job not found in workspace.");
        await prisma.listingSyncJob.update({ where: { id }, data: { status: "failed", error } });
      },
      async queuedForProfile(workspaceId, profileId) {
        const rows = await prisma.listingSyncJob.findMany({
          where: { workspaceId, profileId, status: "queued" },
          orderBy: { scheduledAt: "asc" },
        });
        return rows.map(toJob);
      },
    },
    briefs: {
      async create(input) {
        const r = await prisma.citationBrief.create({
          data: {
            id: createId(), workspaceId: input.workspaceId,
            competitorGapJson: jsonInput(input.competitorGapJson),
            directoriesJson: jsonInput(input.directoriesJson),
          },
        });
        return toBrief(r);
      },
      async get(id, workspaceId) {
        const r = await prisma.citationBrief.findFirst({ where: { id, workspaceId } });
        return r ? toBrief(r) : null;
      },
      async list(workspaceId) {
        const rows = await prisma.citationBrief.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
        return rows.map(toBrief);
      },
      async update(id, workspaceId, patch) {
        const existing = await prisma.citationBrief.findFirst({ where: { id, workspaceId } });
        if (!existing) throw new Error("Citation brief not found in workspace.");
        const r = await prisma.citationBrief.update({
          where: { id },
          data: {
            ...(patch.directoriesJson !== undefined ? { directoriesJson: jsonInput(patch.directoriesJson) } : {}),
            ...(patch.checklistStatus !== undefined ? { checklistStatus: patch.checklistStatus as CitationBriefStatus } : {}),
          },
        });
        return toBrief(r);
      },
    },
  };
}
