// Marketr — Phase 16 slice 9: report gate round-trip tests.
// Run: npx tsx --test lib/reports/__tests__/gate-roundtrip.test.ts
//
// Proves the draft-for-approval flow runs through the gate's OWN service
// functions (same code path as the API routes):
//  - draft: grounded figures → pending; sourceless figures → flagged (never silent)
//  - approve: pending → rendered, PDF bytes on disk (REAL WeasyPrint render)
//  - approve with ungrounded figures → refused, stays flagged, no PDF
//  - deny → denied; edit → requeue pending (figures re-grounded)
//  - every transition writes a FileChangeLog audit entry
//
// The real service functions run against a stub db — no live database.
// The approve test really invokes WeasyPrint (~2s); the test PDF is deleted
// after verification.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

import type { PrismaClient } from "@prisma/client";
import {
  draftReportSend,
  approveReportSend,
  denyReportSend,
  editReportSend,
} from "@/lib/reports/report-gate";
import { UngroundedFiguresError, type ReportFigure } from "@/lib/reports/figures";
import { weasyprintAvailable } from "@/lib/reports/render-service";

/** Real-PDF cases need the WeasyPrint venv (MARKETR_WEASYPRINT_PYTHON); skip, never fail, without it. */
const NO_WEASYPRINT = weasyprintAvailable() ? false : "WeasyPrint interpreter not installed (set MARKETR_WEASYPRINT_PYTHON)";

interface Captured {
  rows: Map<string, Record<string, unknown>>;
  audits: Array<{ action: string; summary: string }>;
  seq: number;
}

function stubDb(captured: Captured): PrismaClient {
  return {
    reportSendApproval: {
      create: async (args: { data: Record<string, unknown> }) => {
        const id = `rsa-${++captured.seq}`;
        const row = { id, ...args.data };
        captured.rows.set(id, row);
        return row;
      },
      findFirst: async (args: { where: { id: string } }) => {
        return captured.rows.get(args.where.id) ?? null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = captured.rows.get(args.where.id);
        if (!row) throw new Error("not found");
        const next = { ...row, ...args.data };
        captured.rows.set(args.where.id, next);
        return next;
      },
    },
    brandKit: {
      findFirst: async () => null, // default violet brand
    },
    fileChangeLog: {
      create: async (args: { data: { action: string; summary: string } }) => {
        captured.audits.push({ action: args.data.action, summary: args.data.summary });
        return args;
      },
    },
  } as unknown as PrismaClient;
}

const ARGS = { workspaceId: "ws-1", actor: "user-1" };

function groundedFigure(key: string, value: string): ReportFigure {
  return {
    key,
    label: `Label for ${key}`,
    value,
    source: { provider: "dataforseo", ref: `job-${key}-1` },
  };
}

function sourcelessFigure(key: string): ReportFigure {
  return { key, label: `Label for ${key}`, value: "invented-number" };
}

const renderedPdfs: string[] = [];
after(async () => {
  for (const p of renderedPdfs) {
    await fs.unlink(p).catch(() => undefined);
  }
});

describe("report send gate round-trip", () => {
  it("drafts grounded figures as pending", async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const db = stubDb(captured);
    const row = await draftReportSend(db, {
      workspaceId: ARGS.workspaceId,
      createdBy: ARGS.actor,
      templateName: "client-performance",
      templateVersion: "1.0.0",
      clientName: "Test Client",
      period: "September 2026",
      figures: [groundedFigure("organic_sessions", "12,480")],
    });
    assert.equal(row.status, "pending");
    assert.equal(row.templateVersion, "1.0.0");
    assert.equal(captured.audits.length, 1);
    assert.equal(captured.audits[0].action, "report_send_drafted");
  });

  it("drafts sourceless figures as flagged — never silent", async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const db = stubDb(captured);
    const row = await draftReportSend(db, {
      workspaceId: ARGS.workspaceId,
      createdBy: ARGS.actor,
      templateName: "client-performance",
      clientName: "Test Client",
      period: "September 2026",
      figures: [groundedFigure("a", "1"), sourcelessFigure("mystery_metric")],
    });
    assert.equal(row.status, "flagged");
    assert.match(String(row.reviewNote), /mystery_metric/);
    assert.equal(captured.audits[0].action, "report_send_flagged");
  });

  it("approve renders a real PDF via WeasyPrint", { skip: NO_WEASYPRINT }, async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const db = stubDb(captured);
    const draft = await draftReportSend(db, {
      workspaceId: ARGS.workspaceId,
      createdBy: ARGS.actor,
      templateName: "client-performance",
      clientName: "Render Client",
      period: "September 2026",
      figures: [
        groundedFigure("organic_sessions", "12,480"),
        { ...groundedFigure("leads", "214"), delta: "+8.2% vs prior period" },
      ],
    });
    const rendered = await approveReportSend(db, { ...ARGS, id: draft.id });
    assert.equal(rendered.status, "rendered");
    assert.ok(rendered.pdfPath, "pdfPath must be set");
    renderedPdfs.push(rendered.pdfPath as string);

    // Prove the bytes are a real PDF with the source pointers inside.
    const bytes = await fs.readFile(rendered.pdfPath as string);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert.ok(bytes.length > 10_000, `PDF suspiciously small: ${bytes.length} bytes`);

    const actions = captured.audits.map((a) => a.action);
    assert.deepEqual(actions, ["report_send_drafted", "report_send_rendered"]);
  });

  it("approve refuses when figures lose their source — stays flagged, no PDF", async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const db = stubDb(captured);
    const draft = await draftReportSend(db, {
      workspaceId: ARGS.workspaceId,
      createdBy: ARGS.actor,
      templateName: "client-performance",
      clientName: "Sourceless Client",
      period: "September 2026",
      figures: [groundedFigure("a", "1")],
    });
    // Simulate an edit that drops the source (bypassing edit's own re-grounding
    // is impossible — so this goes through editReportSend itself).
    const edited = await editReportSend(db, {
      ...ARGS,
      id: draft.id,
      figures: [sourcelessFigure("a")],
    });
    assert.equal(edited.status, "flagged");

    await assert.rejects(
      approveReportSend(db, { ...ARGS, id: draft.id }),
      (err: unknown) => err instanceof UngroundedFiguresError,
    );
    const row = captured.rows.get(draft.id)!;
    assert.equal(row.status, "flagged");
    assert.equal(row.pdfPath, undefined);
    assert.ok(captured.audits.some((a) => a.action === "report_send_flagged"));
  });

  it("deny transitions to denied with an audit entry", async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const db = stubDb(captured);
    const draft = await draftReportSend(db, {
      workspaceId: ARGS.workspaceId,
      createdBy: ARGS.actor,
      templateName: "client-performance",
      clientName: "Denied Client",
      period: "September 2026",
      figures: [groundedFigure("a", "1")],
    });
    await denyReportSend(db, { ...ARGS, id: draft.id, note: "wrong period" });
    const row = captured.rows.get(draft.id)!;
    assert.equal(row.status, "denied");
    assert.equal(row.reviewNote, "wrong period");
    assert.ok(captured.audits.some((a) => a.action === "report_send_denied"));
  });

  it("edit requeues pending and must still be approved", async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const db = stubDb(captured);
    const draft = await draftReportSend(db, {
      workspaceId: ARGS.workspaceId,
      createdBy: ARGS.actor,
      templateName: "client-performance",
      clientName: "Edited Client",
      period: "September 2026",
      figures: [groundedFigure("a", "1")],
    });
    const edited = await editReportSend(db, { ...ARGS, id: draft.id, period: "October 2026" });
    assert.equal(edited.status, "pending");
    assert.equal(edited.period, "October 2026");
    assert.ok(captured.audits.some((a) => a.action === "report_send_edited"));
  });

  it("cannot approve from denied status", async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const db = stubDb(captured);
    const draft = await draftReportSend(db, {
      workspaceId: ARGS.workspaceId,
      createdBy: ARGS.actor,
      templateName: "client-performance",
      clientName: "Dead Client",
      period: "September 2026",
      figures: [groundedFigure("a", "1")],
    });
    await denyReportSend(db, { ...ARGS, id: draft.id });
    await assert.rejects(approveReportSend(db, { ...ARGS, id: draft.id }), /cannot be approved/);
  });
});
