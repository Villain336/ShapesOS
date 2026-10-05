// ShapesOS — Phase 9 (sites): site revisions (site_revisions, FORCE RLS).
//
// A revision is a full snapshot of a site's files that is NOT the live
// working copy:
//   draft   — an agent's work (site_publish_draft), waiting for a person
//   applied — a draft a person applied to the working copy
//   discarded — a draft a person threw away
//   backup  — the working copy as it was just before a draft was applied;
//             applying a backup is the revert
// Every read/write goes through withWorkspaceScope (the app.workspace_id
// GUC); the workspace is always the site's own (callers resolve it from the
// site's project, never from the client).

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { assertSnapshotSize, snapshotBytes, type SiteFile } from "./files";

export type SiteRevisionStatus = "draft" | "applied" | "discarded" | "backup";
export type SiteRevisionSource = "agent" | "backup";

export interface SiteRevisionSummary {
  id: string;
  siteId: string;
  number: number;
  status: SiteRevisionStatus;
  source: SiteRevisionSource;
  runId: string | null;
  summary: string | null;
  fileCount: number;
  bytes: number;
  patchTruncated: boolean;
  hasPatch: boolean;
  createdBy: string | null;
  appliedAt: Date | null;
  appliedBy: string | null;
  backupId: string | null;
  createdAt: Date;
}

export interface SiteRevision extends SiteRevisionSummary {
  files: SiteFile[];
  patch: string | null;
  baseFingerprint: string | null;
}

export interface CreateSiteRevisionInput {
  workspaceId: string;
  siteId: string;
  status: SiteRevisionStatus;
  source: SiteRevisionSource;
  files: SiteFile[];
  runId?: string | null;
  summary?: string | null;
  patch?: string | null;
  patchTruncated?: boolean;
  baseFingerprint?: string | null;
  createdBy?: string | null;
}

type Tx = Prisma.TransactionClient;

const SUMMARY_SELECT = {
  id: true,
  siteId: true,
  number: true,
  status: true,
  source: true,
  runId: true,
  summary: true,
  fileCount: true,
  bytes: true,
  patchTruncated: true,
  patch: true,
  createdBy: true,
  appliedAt: true,
  appliedBy: true,
  backupId: true,
  createdAt: true,
} as const;

function toSummary(r: Prisma.SiteRevisionGetPayload<{ select: typeof SUMMARY_SELECT }>): SiteRevisionSummary {
  const { patch, ...rest } = r;
  return {
    ...rest,
    status: r.status as SiteRevisionStatus,
    source: r.source as SiteRevisionSource,
    hasPatch: typeof patch === "string" && patch.length > 0,
  };
}

function readFiles(v: unknown): SiteFile[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f) =>
    f && typeof f === "object" && typeof (f as SiteFile).path === "string" && typeof (f as SiteFile).content === "string"
      ? [{ path: (f as SiteFile).path, content: (f as SiteFile).content }]
      : [],
  );
}

/** Create a revision inside an open workspace-scoped transaction. */
export async function createSiteRevisionTx(tx: Tx, input: CreateSiteRevisionInput): Promise<SiteRevisionSummary> {
  assertSnapshotSize(input.files);
  // Per-site sequence. The (site_id, number) unique index turns a racing
  // second writer into an error rather than a duplicate number.
  const last = await tx.siteRevision.findFirst({
    where: { workspaceId: input.workspaceId, siteId: input.siteId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const row = await tx.siteRevision.create({
    data: {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      number: (last?.number ?? 0) + 1,
      status: input.status,
      source: input.source,
      runId: input.runId ?? null,
      summary: input.summary?.slice(0, 500) ?? null,
      files: input.files as unknown as Prisma.InputJsonValue,
      fileCount: input.files.length,
      bytes: snapshotBytes(input.files),
      patch: input.patch ?? null,
      patchTruncated: input.patchTruncated === true,
      baseFingerprint: input.baseFingerprint ?? null,
      createdBy: input.createdBy ?? null,
    },
    select: SUMMARY_SELECT,
  });
  return toSummary(row);
}

export async function createSiteRevision(input: CreateSiteRevisionInput): Promise<SiteRevisionSummary> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withWorkspaceScope(input.workspaceId, (tx) => createSiteRevisionTx(tx as Tx, input));
    } catch (err) {
      // P2002: a concurrent revision took the number — once more.
      if ((err as { code?: string })?.code === "P2002" && attempt === 0) continue;
      throw err;
    }
  }
}

export async function listSiteRevisions(
  workspaceId: string,
  siteId: string,
  opts: { limit?: number } = {},
): Promise<SiteRevisionSummary[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.siteRevision.findMany({
      where: { workspaceId, siteId },
      orderBy: { number: "desc" },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
      select: SUMMARY_SELECT,
    }),
  );
  return rows.map(toSummary);
}

export async function getSiteRevisionTx(tx: Tx, workspaceId: string, siteId: string, id: string): Promise<SiteRevision | null> {
  const r = await tx.siteRevision.findFirst({
    where: { id, workspaceId, siteId },
    select: { ...SUMMARY_SELECT, files: true, baseFingerprint: true },
  });
  if (!r) return null;
  const { files, baseFingerprint, ...rest } = r;
  return { ...toSummary(rest), files: readFiles(files), patch: r.patch ?? null, baseFingerprint };
}

export function getSiteRevision(workspaceId: string, siteId: string, id: string): Promise<SiteRevision | null> {
  return withWorkspaceScope(workspaceId, (tx) => getSiteRevisionTx(tx as Tx, workspaceId, siteId, id));
}

/** Status change guarded on the current status (returns false when it lost). */
export async function setSiteRevisionStatusTx(
  tx: Tx,
  workspaceId: string,
  id: string,
  from: SiteRevisionStatus[],
  data: { status: SiteRevisionStatus; appliedAt?: Date; appliedBy?: string; backupId?: string | null },
): Promise<boolean> {
  const res = await tx.siteRevision.updateMany({
    where: { id, workspaceId, status: { in: from } },
    data,
  });
  return res.count === 1;
}
