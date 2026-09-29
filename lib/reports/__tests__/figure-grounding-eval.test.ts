// Marketr — Phase 16 slice 11 evals: figure grounding negative battery.
// Run: npx tsx --test lib/reports/__tests__/figure-grounding-eval.test.ts
//
// Slice 9's figures.test.ts proved the guardrail on synthetic figures. This
// eval runs the battery at the EVAL level — the full gate path —
// battery: for EVERY template slot in the report's figure set, place an
// UNGROUNDED figure in that slot while every other figure is grounded, and
// assert the report is flagged/refused with that exact slot named. A figure
// with no source pointer must be flagged for review and NEVER rendered,
// wherever it hides.
//
// Paths exercised:
//   1. draftReportSend (gate): ungrounded figure in any slot → status
//      "flagged", reviewNote names the slot — never silently "pending".
//   2. assertFiguresGrounded (pure): throws UngroundedFiguresError naming
//      exactly the ungrounded slot(s).
//   3. renderReportPdf (render service): refuses before any PDF bytes exist.
//
// The real service functions run against a stub db — no live database.
// No WeasyPrint render is attempted with ungrounded figures (the refusal
// happens before the renderer is invoked).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";
import { draftReportSend } from "@/lib/reports/report-gate";
import { renderReportPdf } from "@/lib/reports/render-service";
import {
  assertFiguresGrounded,
  evaluateFigures,
  UngroundedFiguresError,
  type ReportFigure,
} from "@/lib/reports/figures";

// Representative KPI slots of the client-performance template's figure
// block. The template's <!--FIGURE_BLOCK--> is a free figure list — the
// battery treats each slot as an independent "ungrounded here must be
// caught" case.
const SLOTS = [
  "organic_sessions",
  "leads",
  "conversion_rate",
  "avg_position",
  "clicks",
  "impressions",
] as const;

function grounded(key: string): ReportFigure {
  return {
    key,
    label: `Label ${key}`,
    value: "12,480",
    source: { provider: "dataforseo", ref: `job-${key}-1` },
  };
}

function sourceless(key: string): ReportFigure {
  return { key, label: `Label ${key}`, value: "invented-number" };
}

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
      findFirst: async () => null,
    },
    fileChangeLog: {
      create: async (args: { data: { action: string; summary: string } }) => {
        captured.audits.push({ action: args.data.action, summary: args.data.summary });
        return args;
      },
    },
  } as unknown as PrismaClient;
}

const DRAFT = {
  workspaceId: "ws-1",
  createdBy: "user-1",
  templateName: "client-performance",
  clientName: "Eval Client",
  period: "September 2026",
};

describe("figure grounding eval: ungrounded figure in every template slot", () => {
  for (const slot of SLOTS) {
    it(`draft flags the report when slot "${slot}" is ungrounded (never pending)`, async () => {
      const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
      const figures = SLOTS.map((s) => (s === slot ? sourceless(s) : grounded(s)));
      const row = await draftReportSend(stubDb(captured), { ...DRAFT, figures });
      assert.equal(row.status, "flagged", `slot ${slot}: must be flagged, not pending`);
      assert.match(String(row.reviewNote), new RegExp(slot), `slot ${slot}: reviewNote must name it`);
      assert.equal(
        captured.audits[0]!.action,
        "report_send_flagged",
        `slot ${slot}: flagging must be audited`,
      );
    });

    it(`assertFiguresGrounded refuses with exactly slot "${slot}" named`, () => {
      const figures = SLOTS.map((s) => (s === slot ? sourceless(s) : grounded(s)));
      let caught: unknown;
      try {
        assertFiguresGrounded(figures);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof UngroundedFiguresError, `slot ${slot}: must throw`);
      assert.deepEqual((caught as UngroundedFiguresError).ungroundedKeys, [slot]);
    });
  }

  it("control: every slot grounded → draft is pending, nothing flagged", async () => {
    const captured: Captured = { rows: new Map(), audits: [], seq: 0 };
    const row = await draftReportSend(stubDb(captured), {
      ...DRAFT,
      figures: SLOTS.map(grounded),
    });
    assert.equal(row.status, "pending");
    assert.equal(evaluateFigures(SLOTS.map(grounded)).allGrounded, true);
  });

  it("two ungrounded slots are BOTH named in the refusal", () => {
    const figures = SLOTS.map((s) =>
      s === "leads" || s === "clicks" ? sourceless(s) : grounded(s),
    );
    const result = evaluateFigures(figures);
    assert.equal(result.allGrounded, false);
    assert.deepEqual(result.ungroundedKeys, ["leads", "clicks"]);
  });
});

describe("figure grounding eval: render service never renders invented numbers", () => {
  it("renderReportPdf refuses before producing any PDF bytes", async () => {
    const figures = SLOTS.map((s) => (s === "avg_position" ? sourceless(s) : grounded(s)));
    await assert.rejects(
      renderReportPdf({
        templateName: "client-performance",
        templateVersion: "1.0.0",
        brandKit: null,
        meta: { report_title: "Eval", meta_client: "Eval Client", meta_period: "September 2026" },
        figures,
      }),
      (err: unknown) => {
        assert.ok(err instanceof UngroundedFiguresError);
        assert.deepEqual(err.ungroundedKeys, ["avg_position"]);
        return true;
      },
    );
  });

  it("renderReportPdf with every figure grounded produces a real PDF", async () => {
    const result = await renderReportPdf({
      templateName: "client-performance",
      templateVersion: "1.0.0",
      brandKit: null,
      meta: { report_title: "Eval", meta_client: "Eval Client", meta_period: "September 2026" },
      figures: SLOTS.map(grounded),
      draft: true,
    });
    assert.ok(result.pdfPath);
    assert.ok(result.sizeBytes > 10_000, `PDF suspiciously small: ${result.sizeBytes}`);
    // Cleanup: the eval must not leave PDFs behind.
    const { promises: fs } = await import("node:fs");
    await fs.unlink(result.pdfPath).catch(() => undefined);
  });
});
