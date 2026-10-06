// Marketr — Phase 16 slice 9: branded report engine — draft-for-approval gate.
//
// The gate's own service functions, modeled on lib/seo/autopilot-service.ts:
// create → approve/deny/edit, every transition audit-logged via FileChangeLog.
// The Phase 14 gate is the law; CopilotKit's report_preview component (slice 3
// registry) is the renderer.
//
// Gate law:
//  - draftReportSend: create a pending (or flagged) approval. Figures are
//    grounding-evaluated at draft time: any figure without a source pointer
//    flags the report for review (status `flagged`), NEVER silent.
//  - approveReportSend: pending/flagged → approved, then render the PDF via
//    WeasyPrint (the render service re-checks grounding — ungrounded figures
//    throw and the approval stays pending). Render failure → `failed` status
//    + audit, never a silent drop.
//  - denyReportSend: pending/flagged → denied.
//  - editReportSend: update-then-requeue-pending — the report stays in the
//    approval queue and must still be approved before it can render.
//    Editing figures re-runs the grounding evaluation.

import type { PrismaClient } from "@prisma/client";
import {
  evaluateFigures,
  UngroundedFiguresError,
  type ReportFigure,
} from "./figures";
import { renderReportPdf } from "./render-service";
import { brandKitRowToInput } from "./brand-css";
import { resolveTemplate } from "./templates/registry";
import { notifyApprovalDecided, notifyApprovalNeeded } from "@/lib/notifications/producers";

type Db = PrismaClient;

export interface ReportPayload {
  meta: Record<string, string>;
  figures: ReportFigure[];
}

export interface DraftReportInput {
  workspaceId: string;
  createdBy: string;
  templateName: string;
  /** Exact semver, or "latest" (resolved + pinned at draft time). */
  templateVersion?: string;
  brandKitId?: string | null;
  clientName: string;
  period: string;
  meta?: Record<string, string>;
  figures: ReportFigure[];
}

type ReportSendRow = {
  id: string;
  workspaceId: string;
  templateName: string;
  templateVersion: string;
  brandKitId: string | null;
  clientName: string;
  period: string;
  payload: unknown;
  status: string;
  reviewNote: string | null;
  pdfPath: string | null;
  createdBy: string;
};

function parsePayload(row: ReportSendRow): ReportPayload {
  const p = (row.payload ?? {}) as Partial<ReportPayload>;
  return {
    meta: (p.meta ?? {}) as Record<string, string>,
    figures: Array.isArray(p.figures) ? (p.figures as ReportFigure[]) : [],
  };
}

async function audit(
  db: Db,
  workspaceId: string,
  action: string,
  summary: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  // Same audit surface as the autopilot gate (FileChangeLog), workspace-scoped
  // (projectId null — milestone 11 allows workspace-scoped events).
  await db.fileChangeLog.create({
    data: {
      workspaceId,
      projectId: null,
      connectionId: null,
      filePath: "",
      actor,
      action: `report_send_${action}` as never,
      summary: summary.slice(0, 280),
    },
  });
}

async function loadApproval(db: Db, workspaceId: string, id: string): Promise<ReportSendRow> {
  const row = await db.reportSendApproval.findFirst({ where: { id, workspaceId } });
  if (!row) throw new Error("Report approval not found");
  return row as unknown as ReportSendRow;
}

/**
 * Draft a report send. Resolves + pins the template version, evaluates figure
 * grounding (ungrounded figures → `flagged`, never silently rendered), and
 * writes the drafted audit entry.
 */
export async function draftReportSend(db: Db, input: DraftReportInput): Promise<ReportSendRow> {
  if (!input.templateName?.trim()) throw new Error("templateName is required");
  if (!input.clientName?.trim()) throw new Error("clientName is required");
  if (!input.period?.trim()) throw new Error("period is required");
  if (!Array.isArray(input.figures) || input.figures.length === 0) {
    throw new Error("At least one figure is required — reports never render invented numbers");
  }

  // Pin the template version at draft time (old reports re-render identical).
  const resolved = await resolveTemplate(input.templateName.trim(), input.templateVersion ?? "latest");

  if (input.brandKitId) {
    const kit = await db.brandKit.findFirst({
      where: { id: input.brandKitId, workspaceId: input.workspaceId },
    });
    if (!kit) throw new Error("Brand kit not found");
  }

  const payload: ReportPayload = {
    meta: { ...(input.meta ?? {}) },
    figures: input.figures,
  };
  const grounding = evaluateFigures(payload.figures);
  const status = grounding.allGrounded ? "pending" : "flagged";

  const row = (await db.reportSendApproval.create({
    data: {
      workspaceId: input.workspaceId,
      templateName: resolved.name,
      templateVersion: resolved.version,
      brandKitId: input.brandKitId ?? null,
      clientName: input.clientName.trim().slice(0, 200),
      period: input.period.trim().slice(0, 120),
      payload: payload as object,
      status,
      reviewNote: grounding.allGrounded
        ? null
        : `Flagged: ${grounding.ungroundedKeys.length} figure(s) missing a source pointer (${grounding.ungroundedKeys.join(", ")}). Source them before approving.`,
      createdBy: input.createdBy,
    },
  })) as unknown as ReportSendRow;

  await audit(
    db,
    input.workspaceId,
    grounding.allGrounded ? "drafted" : "flagged",
    grounding.allGrounded
      ? `Report drafted: "${row.clientName}" (${row.templateName}@${row.templateVersion}, ${row.period})`
      : `Report drafted and FLAGGED: "${row.clientName}" — figures without sources: ${grounding.ungroundedKeys.join(", ")}`,
  );
  // Phase 3 (J): best-effort "needs you" notification (never throws).
  await notifyApprovalNeeded({
    workspaceId: input.workspaceId,
    source: "report",
    sourceId: row.id,
    title: `${row.clientName} · ${row.period}`,
    requestedBy: input.createdBy,
  });
  return row;
}

/**
 * Approve a pending/flagged report and render the PDF. The render service
 * re-checks figure grounding — ungrounded figures throw UngroundedFiguresError
 * and the approval stays pending (no PDF, no silent render).
 */
export async function approveReportSend(
  db: Db,
  args: { workspaceId: string; id: string; actor: string },
): Promise<ReportSendRow> {
  const row = await loadApproval(db, args.workspaceId, args.id);
  if (row.status !== "pending" && row.status !== "flagged") {
    throw new Error(`Report cannot be approved from status "${row.status}"`);
  }

  const payload = parsePayload(row);
  // Grounding is re-checked inside renderReportPdf (hard gate) — a report
  // with ungrounded figures can never reach the render audit below.

  let brandKit = null;
  if (row.brandKitId) {
    const kitRow = await db.brandKit.findFirst({
      where: { id: row.brandKitId, workspaceId: args.workspaceId },
    });
    if (kitRow) brandKit = brandKitRowToInput(kitRow as never);
  }

  const preparedOn = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  try {
    const rendered = await renderReportPdf({
      workspaceId: args.workspaceId,
      templateName: row.templateName,
      templateVersion: row.templateVersion,
      brandKit,
      meta: {
        report_title: `${row.clientName} — Performance Report`,
        meta_client: row.clientName,
        meta_period: row.period,
        meta_prepared_on: preparedOn,
        ...payload.meta,
      },
      figures: payload.figures,
    });
    const updated = (await db.reportSendApproval.update({
      where: { id: row.id },
      data: {
        status: "rendered",
        pdfPath: rendered.pdfPath,
        reviewNote: null,
        decidedBy: args.actor,
        decidedAt: new Date(),
      },
    })) as unknown as ReportSendRow;
    await audit(
      db,
      args.workspaceId,
      "rendered",
      `Report approved + rendered: "${row.clientName}" (${row.templateName}@${row.templateVersion}, ` +
        `${rendered.pageCount}p, ${(rendered.sizeBytes / 1024).toFixed(1)} KB, all ${payload.figures.length} figures source-traced)`,
    );
    await notifyApprovalDecided({
      workspaceId: args.workspaceId,
      source: "report",
      sourceId: row.id,
      title: `${row.clientName} · ${row.period}`,
      decision: "approved",
      decidedBy: args.actor,
      requestedBy: row.createdBy,
    });
    return updated;
  } catch (err) {
    if (err instanceof UngroundedFiguresError) {
      // Iron guardrail: stay pending, say why. Never a silent render.
      await db.reportSendApproval.update({
        where: { id: row.id },
        data: {
          status: "flagged",
          reviewNote: `Render refused: ${err.message}`,
        },
      });
      await audit(db, args.workspaceId, "flagged", `Report render refused: ${err.message}`, "system");
      throw err;
    }
    await db.reportSendApproval.update({
      where: { id: row.id },
      data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : String(err) },
    });
    await audit(
      db,
      args.workspaceId,
      "failed",
      `Report render failed: "${row.clientName}" — ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      "system",
    );
    throw err;
  }
}

/** Deny a pending/flagged report. Denials are never silent — audit row. */
export async function denyReportSend(
  db: Db,
  args: { workspaceId: string; id: string; actor: string; note?: string },
): Promise<void> {
  const row = await loadApproval(db, args.workspaceId, args.id);
  if (row.status !== "pending" && row.status !== "flagged") {
    throw new Error(`Report cannot be denied from status "${row.status}"`);
  }
  await db.reportSendApproval.update({
    where: { id: row.id },
    data: {
      status: "denied",
      reviewNote: args.note?.slice(0, 500) ?? null,
      decidedBy: args.actor,
      decidedAt: new Date(),
    },
  });
  await audit(
    db,
    args.workspaceId,
    "denied",
    `Report denied: "${row.clientName}" (${row.period})${args.note ? ` — ${args.note}` : ""}`,
  );
  await notifyApprovalDecided({
    workspaceId: args.workspaceId,
    source: "report",
    sourceId: row.id,
    title: `${row.clientName} · ${row.period}`,
    decision: "denied",
    decidedBy: args.actor,
    requestedBy: row.createdBy,
  });
}

/**
 * Edit a pending/flagged report (client name, period, meta, figures) and
 * requeue as pending — it must still be approved before it can render.
 * Editing figures re-runs the grounding evaluation (may flip to flagged).
 */
export async function editReportSend(
  db: Db,
  args: {
    workspaceId: string;
    id: string;
    actor: string;
    clientName?: string;
    period?: string;
    meta?: Record<string, string>;
    figures?: ReportFigure[];
  },
): Promise<ReportSendRow> {
  const row = await loadApproval(db, args.workspaceId, args.id);
  if (row.status !== "pending" && row.status !== "flagged") {
    throw new Error(`Report cannot be edited from status "${row.status}"`);
  }
  const payload = parsePayload(row);
  if (args.meta) payload.meta = { ...payload.meta, ...args.meta };
  if (args.figures) {
    if (args.figures.length === 0) throw new Error("At least one figure is required");
    payload.figures = args.figures;
  }
  const grounding = evaluateFigures(payload.figures);
  const changed = [
    args.clientName ? "client" : null,
    args.period ? "period" : null,
    args.meta ? "meta" : null,
    args.figures ? "figures" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  if (!changed) throw new Error("Edit requires at least one changed field");

  const updated = (await db.reportSendApproval.update({
    where: { id: row.id },
    data: {
      ...(args.clientName ? { clientName: args.clientName.trim().slice(0, 200) } : {}),
      ...(args.period ? { period: args.period.trim().slice(0, 120) } : {}),
      payload: payload as object,
      status: grounding.allGrounded ? "pending" : "flagged",
      reviewNote: grounding.allGrounded
        ? null
        : `Flagged after edit: figures without sources: ${grounding.ungroundedKeys.join(", ")}`,
      decidedBy: null,
      decidedAt: null,
    },
  })) as unknown as ReportSendRow;
  await audit(
    db,
    args.workspaceId,
    grounding.allGrounded ? "edited" : "flagged",
    `Report edited (${changed}): "${row.clientName}" — requeued for approval${grounding.allGrounded ? "" : `, FLAGGED (${grounding.ungroundedKeys.join(", ")})`}`,
  );
  return updated;
}
