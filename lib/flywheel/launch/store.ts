// Marketr — F6 launch checklist store (prisma-backed, merge-safe).
//
// The `launch_checklist` table lives in prisma/fragments/phase7-launch.prisma
// and is merged into prisma/schema.prisma by the phase-7 coordinator. Until
// that merge lands, this store talks to the table with raw SQL so
// `npx tsc --noEmit` stays green pre-merge. Post-merge this can switch to
// the typed client; the row shape is identical.
//
// All queries are workspace-scoped — cross-workspace access is rejected by
// the WHERE clause.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import {
  LAUNCH_CHECKLIST_CATALOG,
  type LaunchCategory,
  type LaunchStatus,
} from "./catalog";

/** True when the F6 launch table exists (fragment merged + migrated). */
export async function launchTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM launch_checklist LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

export interface LaunchChecklistRow {
  id: string;
  workspaceId: string;
  key: string;
  item: string;
  category: LaunchCategory;
  status: LaunchStatus;
  evidenceUrl: string | null;
  note: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const VALID_STATUS: LaunchStatus[] = ["pending", "in_progress", "complete"];

function toRow(r: Record<string, unknown>): LaunchChecklistRow {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    key: String(r.key),
    item: String(r.item),
    category: String(r.category) as LaunchCategory,
    status: String(r.status) as LaunchStatus,
    evidenceUrl: (r.evidence_url as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

/**
 * Idempotently seed every catalog item for a workspace. Rows denormalize the
 * catalog title at insert; re-seeding never clobbers operator-edited titles
 * or statuses (INSERT ... ON CONFLICT DO NOTHING).
 */
export async function seedLaunchChecklist(workspaceId: string): Promise<number> {
  let inserted = 0;
  for (const item of LAUNCH_CHECKLIST_CATALOG) {
    const rows = (await prisma.$executeRawUnsafe(
      `INSERT INTO launch_checklist
         (id, workspace_id, "key", item, category, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW())
       ON CONFLICT (workspace_id, "key") DO NOTHING`,
      createId(),
      workspaceId,
      item.key,
      item.title,
      item.category,
    )) as unknown as number;
    inserted += Number(rows) || 0;
  }
  return inserted;
}

/** Every row for a workspace, catalog order. */
export async function listLaunchChecklist(workspaceId: string): Promise<LaunchChecklistRow[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT * FROM launch_checklist WHERE workspace_id = $1 ORDER BY created_at ASC`,
    workspaceId,
  )) as Record<string, unknown>[];
  return rows.map(toRow);
}

export interface LaunchProgress {
  total: number;
  complete: number;
  inProgress: number;
  pending: number;
  byCategory: Record<LaunchCategory, { total: number; complete: number }>;
}

export function progressOf(rows: LaunchChecklistRow[]): LaunchProgress {
  const byCategory = {
    security: { total: 0, complete: 0 },
    legal: { total: 0, complete: 0 },
    community: { total: 0, complete: 0 },
    build: { total: 0, complete: 0 },
  } as Record<LaunchCategory, { total: number; complete: number }>;
  let complete = 0;
  let inProgress = 0;
  for (const r of rows) {
    byCategory[r.category].total++;
    if (r.status === "complete") {
      complete++;
      byCategory[r.category].complete++;
    } else if (r.status === "in_progress") {
      inProgress++;
    }
  }
  return {
    total: rows.length,
    complete,
    inProgress,
    pending: rows.length - complete - inProgress,
    byCategory,
  };
}

export class LaunchChecklistError extends Error {}

/**
 * Mark one item complete (editor+). Requires evidence — a checklist item is
 * not "done" because someone said so; the evidence URL is the proof.
 * Idempotent: completing an already-complete item updates evidence/note.
 */
export async function completeChecklistItem(input: {
  workspaceId: string;
  key: string;
  evidenceUrl: string;
  note?: string;
}): Promise<LaunchChecklistRow> {
  const { workspaceId, key, evidenceUrl, note } = input;
  const url = evidenceUrl.trim();
  if (!url) throw new LaunchChecklistError("evidence_url is required — a checklist item is not done without proof.");
  if (!/^https?:\/\/\S+|^[\w./-]+\.(md|txt|yml|yaml)$/i.test(url) && !/^docs\//.test(url)) {
    // Allow repo-relative doc paths (docs/..., .github/...) as evidence in
    // addition to http(s) URLs — but nothing else free-form.
    if (!/^(docs\/|\.github\/|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md|THIRD_PARTY\.md|LICENSE)/.test(url)) {
      throw new LaunchChecklistError(
        "evidence_url must be an http(s) URL or a repo-relative doc path (docs/..., .github/..., *.md at root).",
      );
    }
  }
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE launch_checklist
        SET status = 'complete', evidence_url = $3, note = COALESCE($4, note),
            completed_at = NOW(), updated_at = NOW()
      WHERE workspace_id = $1 AND "key" = $2
      RETURNING *`,
    workspaceId,
    key,
    url,
    note?.trim() || null,
  )) as Record<string, unknown>[];
  if (rows.length === 0) throw new LaunchChecklistError(`Unknown checklist item: ${key}`);
  return toRow(rows[0]);
}

/** Set an item back to in_progress (re-open with a note). Editor+. */
export async function reopenChecklistItem(input: {
  workspaceId: string;
  key: string;
  note?: string;
}): Promise<LaunchChecklistRow> {
  const rows = (await prisma.$queryRawUnsafe(
    `UPDATE launch_checklist
        SET status = 'in_progress', note = COALESCE($3, note),
            completed_at = NULL, updated_at = NOW()
      WHERE workspace_id = $1 AND "key" = $2
      RETURNING *`,
    input.workspaceId,
    input.key,
    input.note?.trim() || null,
  )) as Record<string, unknown>[];
  if (rows.length === 0) throw new LaunchChecklistError(`Unknown checklist item: ${input.key}`);
  return toRow(rows[0]);
}

/** Guard helper: is this a known catalog key? */
export function isKnownChecklistKey(key: string): boolean {
  return LAUNCH_CHECKLIST_CATALOG.some((i) => i.key === key);
}

export { VALID_STATUS };
