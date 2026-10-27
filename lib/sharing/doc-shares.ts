// ShapesOS — Phase 23: tokenized external share links for Office docs and
// Reports (the Studio/CAD share pattern extended to the remaining deliverable
// surfaces; recommendation vs Claude #4).
//
// Same rules as the file-share family (lib/files/shares.ts): only the
// SHA-256 of a token is stored (the raw token is returned ONCE at creation),
// links are scope-limited (one doc or one report PDF), expirable, revocable,
// and the one cross-workspace read (public lookup by token hash) runs inside
// a transaction that sets app.doc_report_share_route='lookup' — everything
// after runs under the link's own workspace scope. Unknown, expired and
// revoked tokens all resolve to null (no oracle).

import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const DOC_SHARE_TOKEN_PREFIX = "osh_";
export const REPORT_SHARE_TOKEN_PREFIX = "rsh_";
export const SHARE_MAX_DAYS = 90;
export const SHARE_DEFAULT_DAYS = 7;

export function generateShareToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenHint(token: string): string {
  return token.slice(-4);
}

export function shareUnusableReason(
  link: { revokedAt: Date | null; expiresAt: Date | null },
  now = new Date(),
): "revoked" | "expired" | null {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

export interface ShareLinkView {
  id: string;
  label: string | null;
  tokenHint: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  state: "live" | "expired" | "revoked";
  openCount: number;
  lastOpenedAt: string | null;
}

function toView(s: {
  id: string; label: string | null; tokenHint: string; createdAt: Date;
  expiresAt: Date | null; revokedAt: Date | null; openCount: number; lastOpenedAt: Date | null;
}): ShareLinkView {
  return {
    id: s.id,
    label: s.label,
    tokenHint: s.tokenHint,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt?.toISOString() ?? null,
    revokedAt: s.revokedAt?.toISOString() ?? null,
    state: shareUnusableReason(s) ?? "live",
    openCount: s.openCount,
    lastOpenedAt: s.lastOpenedAt?.toISOString() ?? null,
  };
}

const SELECT = {
  id: true, label: true, tokenHint: true, createdAt: true,
  expiresAt: true, revokedAt: true, openCount: true, lastOpenedAt: true,
} as const;

// ── Office docs ─────────────────────────────────────────────────────────────

export async function listDocShares(workspaceId: string, docId: string): Promise<ShareLinkView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDocShare.findMany({ where: { workspaceId, docId }, orderBy: { createdAt: "desc" }, select: SELECT }),
  );
  return rows.map(toView);
}

export async function createDocShare(input: {
  workspaceId: string;
  docId: string;
  userId: string;
  label?: string;
  expiresInDays?: number;
}): Promise<{ share: ShareLinkView; token: string }> {
  const days = Math.min(Math.max(1, input.expiresInDays ?? SHARE_DEFAULT_DAYS), SHARE_MAX_DAYS);
  const token = generateShareToken(DOC_SHARE_TOKEN_PREFIX);
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const row = await withWorkspaceScope(input.workspaceId, async (tx) => {
    // The doc must belong to this workspace — never mint a link to something
    // the actor can't see.
    const doc = await tx.univerDoc.findFirst({ where: { id: input.docId, workspaceId: input.workspaceId }, select: { id: true } });
    if (!doc) throw new Error("DOC_NOT_FOUND");
    return tx.univerDocShare.create({
      data: {
        workspaceId: input.workspaceId,
        docId: input.docId,
        tokenHash: hashShareToken(token),
        tokenHint: tokenHint(token),
        label: input.label?.slice(0, 120) || null,
        expiresAt,
        createdBy: input.userId,
      },
      select: SELECT,
    });
  });
  return { share: toView(row), token };
}

export async function revokeDocShare(workspaceId: string, docId: string, shareId: string, userId: string): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const res = await tx.univerDocShare.updateMany({
      where: { id: shareId, docId, workspaceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: userId },
    });
    if (res.count === 0) throw new Error("SHARE_NOT_FOUND");
  });
}

export interface ResolvedDocShare {
  share: { id: string; workspaceId: string; docId: string };
  doc: { id: string; kind: string; title: string; snapshot: unknown; updatedAt: Date };
}

/** Public-route lookup: by token hash, no workspace context. */
export async function resolveDocShareToken(token: string, now = new Date()): Promise<ResolvedDocShare | null> {
  if (!token.startsWith(DOC_SHARE_TOKEN_PREFIX)) return null;
  const link = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.doc_report_share_route = 'lookup'`);
    return tx.univerDocShare.findFirst({
      where: { tokenHash: hashShareToken(token), revokedAt: null },
      select: { id: true, workspaceId: true, docId: true, expiresAt: true, revokedAt: true },
    });
  });
  if (!link || shareUnusableReason(link, now)) return null;
  const doc = await withWorkspaceScope(link.workspaceId, (tx) =>
    tx.univerDoc.findFirst({
      where: { id: link.docId, workspaceId: link.workspaceId },
      select: { id: true, kind: true, title: true, snapshot: true, updatedAt: true },
    }),
  );
  if (!doc) return null;
  return { share: { id: link.id, workspaceId: link.workspaceId, docId: link.docId }, doc };
}

// ── Reports ─────────────────────────────────────────────────────────────────

export async function listReportShares(workspaceId: string, reportId: string): Promise<ShareLinkView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.reportShare.findMany({ where: { workspaceId, reportId }, orderBy: { createdAt: "desc" }, select: SELECT }),
  );
  return rows.map(toView);
}

export async function createReportShare(input: {
  workspaceId: string;
  reportId: string;
  userId: string;
  label?: string;
  expiresInDays?: number;
}): Promise<{ share: ShareLinkView; token: string }> {
  const days = Math.min(Math.max(1, input.expiresInDays ?? SHARE_DEFAULT_DAYS), SHARE_MAX_DAYS);
  const token = generateShareToken(REPORT_SHARE_TOKEN_PREFIX);
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const row = await withWorkspaceScope(input.workspaceId, async (tx) => {
    // Reports scope to the workspace through their template; only a ready
    // report (a real PDF) is shareable.
    const report = await tx.report.findFirst({
      where: { id: input.reportId, template: { workspaceId: input.workspaceId } },
      select: { id: true, status: true },
    });
    if (!report) throw new Error("REPORT_NOT_FOUND");
    if (report.status !== "ready" && report.status !== "sent") throw new Error("REPORT_NOT_READY");
    return tx.reportShare.create({
      data: {
        workspaceId: input.workspaceId,
        reportId: input.reportId,
        tokenHash: hashShareToken(token),
        tokenHint: tokenHint(token),
        label: input.label?.slice(0, 120) || null,
        expiresAt,
        createdBy: input.userId,
      },
      select: SELECT,
    });
  });
  return { share: toView(row), token };
}

export async function revokeReportShare(workspaceId: string, reportId: string, shareId: string, userId: string): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const res = await tx.reportShare.updateMany({
      where: { id: shareId, reportId, workspaceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: userId },
    });
    if (res.count === 0) throw new Error("SHARE_NOT_FOUND");
  });
}

export interface ResolvedReportShare {
  share: { id: string; workspaceId: string; reportId: string };
  report: { id: string; pdfPath: string | null; period: string; templateName: string | null };
}

/** Public-route lookup: by token hash, no workspace context. */
export async function resolveReportShareToken(token: string, now = new Date()): Promise<ResolvedReportShare | null> {
  if (!token.startsWith(REPORT_SHARE_TOKEN_PREFIX)) return null;
  const link = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.doc_report_share_route = 'lookup'`);
    return tx.reportShare.findFirst({
      where: { tokenHash: hashShareToken(token), revokedAt: null },
      select: { id: true, workspaceId: true, reportId: true, expiresAt: true, revokedAt: true },
    });
  });
  if (!link || shareUnusableReason(link, now)) return null;
  const report = await withWorkspaceScope(link.workspaceId, (tx) =>
    tx.report.findFirst({
      where: { id: link.reportId, template: { workspaceId: link.workspaceId }, status: { in: ["ready", "sent"] } },
      select: { id: true, pdfPath: true, period: true, template: { select: { name: true } } },
    }),
  );
  if (!report || !report.pdfPath) return null;
  return {
    share: { id: link.id, workspaceId: link.workspaceId, reportId: link.reportId },
    report: { id: report.id, pdfPath: report.pdfPath, period: report.period, templateName: report.template?.name ?? null },
  };
}

/** Count an open of a shared doc/report page. Best effort. */
export async function recordDocShareOpen(share: { id: string; workspaceId: string }): Promise<void> {
  await withWorkspaceScope(share.workspaceId, (tx) =>
    tx.univerDocShare.update({ where: { id: share.id }, data: { openCount: { increment: 1 }, lastOpenedAt: new Date() } }),
  ).catch(() => undefined);
}

export async function recordReportShareOpen(share: { id: string; workspaceId: string }): Promise<void> {
  await withWorkspaceScope(share.workspaceId, (tx) =>
    tx.reportShare.update({ where: { id: share.id }, data: { openCount: { increment: 1 }, lastOpenedAt: new Date() } }),
  ).catch(() => undefined);
}
