// ShapesOS — Phase 21B (WS=drive): quota charging under row locks.
//
// One call charges (or frees) bytes against the workspace total AND the
// scopes the path belongs to (a person's home, an app container), under
// FOR UPDATE locks so concurrent writers serialise and none can race past a
// limit. The arithmetic is lib/drive/quota.ts (pure, unit-tested).

import type { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_QUOTA_BYTES, FsError } from "../filesystem/core";
import { DEFAULT_APP_QUOTA_BYTES, checkQuotaChange, type QuotaScopeRef } from "./quota";

type Tx = Prisma.TransactionClient | PrismaClient;

/** The per-workspace structure lock: every drive mutation takes it first (lock order: this, quota rows, journal counter). */
export async function lockDriveTree(tx: Tx, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"drive:" + workspaceId}))`;
}

export async function chargeQuota(tx: Tx, workspaceId: string, scopes: QuotaScopeRef[], delta: number): Promise<void> {
  await tx.workspaceQuota.upsert({
    where: { workspaceId },
    create: { workspaceId, limitBytes: BigInt(DEFAULT_QUOTA_BYTES), usedBytes: BigInt(0) },
    update: {},
  });
  await tx.$queryRaw`SELECT "workspace_id" FROM "workspace_quotas" WHERE "workspace_id" = ${workspaceId} FOR UPDATE`;
  const quota = await tx.workspaceQuota.findUniqueOrThrow({ where: { workspaceId } });
  const scopeRows: Array<{ key: string; limit: number | null; used: number }> = [];
  for (const s of [...scopes].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    await tx.workspaceDriveQuota.upsert({
      where: { workspaceId_scope: { workspaceId, scope: s.key } },
      create: { workspaceId, scope: s.key, limitBytes: s.kind === "app" ? BigInt(DEFAULT_APP_QUOTA_BYTES) : null, usedBytes: BigInt(0) },
      update: {},
    });
    await tx.$queryRaw`SELECT "scope" FROM "workspace_drive_quotas" WHERE "workspace_id" = ${workspaceId} AND "scope" = ${s.key} FOR UPDATE`;
    const row = await tx.workspaceDriveQuota.findUniqueOrThrow({ where: { workspaceId_scope: { workspaceId, scope: s.key } } });
    scopeRows.push({ key: s.key, limit: row.limitBytes === null ? null : Number(row.limitBytes), used: Number(row.usedBytes) });
  }
  const verdict = checkQuotaChange({ workspace: { limit: Number(quota.limitBytes), used: Number(quota.usedBytes) }, scopes: scopeRows, delta });
  if (!verdict.ok) {
    throw new FsError(
      "quota_exceeded",
      verdict.scope === "workspace"
        ? "Workspace storage quota exceeded."
        : verdict.scope.startsWith("user:")
          ? "Your personal storage limit is full."
          : "This app's storage limit is full.",
    );
  }
  if (delta !== 0) {
    // GREATEST: a counter that drifted can never go negative.
    await tx.$executeRaw`UPDATE "workspace_quotas" SET "used_bytes" = GREATEST(0, "used_bytes" + ${BigInt(delta)}) WHERE "workspace_id" = ${workspaceId}`;
    for (const s of scopes) {
      await tx.$executeRaw`UPDATE "workspace_drive_quotas" SET "used_bytes" = GREATEST(0, "used_bytes" + ${BigInt(delta)}) WHERE "workspace_id" = ${workspaceId} AND "scope" = ${s.key}`;
    }
  }
}

/** Set (or clear with null) the separate limit of a scope. */
export async function setScopeLimit(tx: Tx, workspaceId: string, scope: string, limitBytes: number | null): Promise<void> {
  await tx.workspaceDriveQuota.upsert({
    where: { workspaceId_scope: { workspaceId, scope } },
    create: { workspaceId, scope, limitBytes: limitBytes === null ? null : BigInt(limitBytes), usedBytes: BigInt(0) },
    update: { limitBytes: limitBytes === null ? null : BigInt(limitBytes) },
  });
}

export async function getScopeUsage(tx: Tx, workspaceId: string, scope: string): Promise<{ limitBytes: number | null; usedBytes: number }> {
  const row = await tx.workspaceDriveQuota.findUnique({ where: { workspaceId_scope: { workspaceId, scope } } });
  return { limitBytes: row?.limitBytes == null ? null : Number(row.limitBytes), usedBytes: Number(row?.usedBytes ?? 0n) };
}
