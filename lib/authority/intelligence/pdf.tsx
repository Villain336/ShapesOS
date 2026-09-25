// Marketr — Phase 6 I1: Intelligence Report document (PDF) on the house stack.
//
// Builds a pdfcn React tree with @/lib/pdf-primitives and renders it with
// @/lib/pdf/renderer (takumi). Saved to .data/reports/intelligence-<id>.pdf
// and the IntelligenceReport row's pdfUrl is updated.

import React from "react";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { renderPdf } from "@/lib/pdf/renderer";
import { Document, Page, View, Text } from "@/lib/pdf-primitives";
import type { AuditResult, Completeness, RevenueOpportunity, GrowthPlan } from "./types";
import { AUDIT_NAMES } from "./types";

const INK = "#1c1917";
const MUTED = "#78716c";
const ACCENT = "#4f46e5";
const CARD = "#fafaf9";
const LINE = "#e7e5e4";

/**
 * The takumi default font does not cover geometric shapes or arrows —
 * an uncovered glyph crashes the render. Sanitize ALL dynamic text
 * (audit findings, opportunities, plan copy) at the PDF boundary.
 */
const GLYPH_MAP: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->",
  "●": "-", "○": "-", "▲": "!", "△": "!",
  "✓": "yes", "✗": "x", "✘": "x", "★": "*",
};
export function pdfSafe(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[→←↔●○▲△✓✗✘★]/g, (ch) => GLYPH_MAP[ch] ?? "");
}

const COMPLETENESS_LABEL: Record<Completeness, string> = {
  full: "Full data", partial: "Partial data", unavailable: "Unavailable",
};
const COMPLETENESS_COLOR: Record<Completeness, string> = {
  full: "#15803d", partial: "#b45309", unavailable: "#78716c",
};

function AuditSection({ audit }: { audit: AuditResult }) {
  return (
    <View wrap={false} style={{ marginBottom: 14, padding: 12, backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <Text style={{ fontSize: 13, fontWeight: 700, color: INK }}>{pdfSafe(audit.name)}</Text>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Text style={{ fontSize: 10, fontWeight: 700, color: COMPLETENESS_COLOR[audit.completeness], marginRight: 8 }}>
            {COMPLETENESS_LABEL[audit.completeness]}
          </Text>
          <Text style={{ fontSize: 12, fontWeight: 700, color: audit.score == null ? MUTED : audit.score >= 70 ? "#15803d" : audit.score >= 45 ? "#b45309" : "#b91c1c" }}>
            {audit.score == null ? "—" : `${audit.score}/100`}
          </Text>
        </View>
      </View>
      {audit.findings.slice(0, 5).map((f, i) => (
        <View key={i} style={{ marginBottom: 5 }}>
          <Text style={{ fontSize: 10.5, fontWeight: 600, color: INK }}>
            {f.severity === "critical" ? "[CRITICAL] " : f.severity === "warn" ? "[WATCH] " : ""}{pdfSafe(f.title)}
          </Text>
          <Text style={{ fontSize: 9.5, color: MUTED }}>{pdfSafe(f.detail)}</Text>
          <Text style={{ fontSize: 8.5, color: MUTED, fontStyle: "italic" }}>Source: {pdfSafe(f.dataSource)}</Text>
        </View>
      ))}
      {audit.findings.length > 5 && (
        <Text style={{ fontSize: 9, color: MUTED }}>+ {audit.findings.length - 5} more findings in the dashboard.</Text>
      )}
    </View>
  );
}

function ReportDocument(props: {
  brandName: string; domain: string | null; generatedAt: string;
  audits: AuditResult[]; opportunities: RevenueOpportunity[]; plan: GrowthPlan;
}) {
  const { brandName, domain, generatedAt, audits, opportunities, plan } = props;
  const scored = audits.filter((a) => a.score != null);
  const avg = scored.length ? Math.round(scored.reduce((s, a) => s + (a.score as number), 0) / scored.length) : null;
  const date = new Date(generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const sprints = [30, 60, 90] as const;

  return (
    <Document title="Intelligence Report">
      <Page style={{ padding: 36, fontFamily: "Helvetica, Arial, sans-serif" }}>
        <Text style={{ fontSize: 11, fontWeight: 700, color: ACCENT, letterSpacing: 2 }}>MARKETR · INTELLIGENCE REPORT</Text>
        <Text style={{ fontSize: 26, fontWeight: 800, color: INK, marginTop: 8 }}>{pdfSafe(brandName)}</Text>
        {domain && <Text style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{pdfSafe(domain)}</Text>}
        <Text style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>Generated {date} · Twelve audits, ranked opportunities, 90-day Growth Plan</Text>

        <View style={{ marginTop: 18, padding: 14, backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 6, flexDirection: "row", alignItems: "center" }}>
          <View style={{ marginRight: 16 }}>
            <Text style={{ fontSize: 34, fontWeight: 800, color: INK }}>{avg == null ? "—" : avg}</Text>
            <Text style={{ fontSize: 9, color: MUTED }}>OVERALL / 100</Text>
          </View>
          <View>
            <Text style={{ fontSize: 10.5, color: INK }}>
              {scored.length} of 12 audits scored · {audits.filter((a) => a.completeness === "full").length} full-data ·{" "}
              {audits.filter((a) => a.completeness === "partial").length} partial ·{" "}
              {audits.filter((a) => a.completeness === "unavailable").length} unavailable
            </Text>
            <Text style={{ fontSize: 9.5, color: MUTED, marginTop: 4 }}>
              Sections labeled partial or unavailable reflect missing connections or data — never fabricated numbers.
            </Text>
          </View>
        </View>

        <Text style={{ fontSize: 15, fontWeight: 800, color: INK, marginTop: 22, marginBottom: 8 }}>The twelve audits</Text>
        {audits.map((a) => <AuditSection key={a.id} audit={a} />)}

        <View break>
          <Text style={{ fontSize: 15, fontWeight: 800, color: INK, marginBottom: 8 }}>Revenue opportunities, ranked</Text>
          <Text style={{ fontSize: 9.5, color: MUTED, marginBottom: 10 }}>Impact figures are estimates for prioritization, not forecasts.</Text>
          {opportunities.slice(0, 10).map((o, i) => (
            <View key={o.id} wrap={false} style={{ marginBottom: 8, padding: 10, border: `1px solid ${LINE}`, borderRadius: 6 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 11, fontWeight: 700, color: INK }}>#{i + 1} {pdfSafe(o.title)}</Text>
                <Text style={{ fontSize: 10, fontWeight: 700, color: ACCENT }}>
                  ~${o.impactUsd.toLocaleString("en-US")}/yr
                </Text>
              </View>
              <Text style={{ fontSize: 9.5, color: MUTED, marginTop: 2 }}>{pdfSafe(o.description)}</Text>
              <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 2 }}>
                Effort {o.effort}/5 · Confidence: {o.confidence} · Executes in: {pdfSafe(o.executesIn)} · From: {AUDIT_NAMES[o.auditId]}
              </Text>
            </View>
          ))}
        </View>

        <View break>
          <Text style={{ fontSize: 15, fontWeight: 800, color: INK, marginBottom: 4 }}>90-day Growth Plan</Text>
          <Text style={{ fontSize: 9.5, color: MUTED, marginBottom: 10 }}>Priorities are adjustable — a human reviews and approves this plan before it becomes the operating baseline.</Text>
          {sprints.map((s) => (
            <View key={s} style={{ marginBottom: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: 700, color: ACCENT, marginBottom: 4 }}>Days 1–{s}</Text>
              {plan.initiatives.filter((i) => i.sprint === s).map((i) => (
                <View key={i.id} wrap={false} style={{ marginBottom: 6, padding: 8, backgroundColor: CARD, borderRadius: 4 }}>
                  <Text style={{ fontSize: 10.5, fontWeight: 600, color: INK }}>P{i.priority} · {pdfSafe(i.title)}</Text>
                  <Text style={{ fontSize: 9.5, color: MUTED }}>{pdfSafe(i.description)}</Text>
                  <Text style={{ fontSize: 8.5, color: MUTED }}>Executes in: {pdfSafe(i.module)} · Expected: {pdfSafe(i.expectedOutcome)}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>

        <Text style={{ fontSize: 8.5, color: MUTED, marginTop: 16 }}>
          Generated by Marketr Intelligence Report · Every audit cites its data source · Partial/unavailable sections reflect missing connections, never fabricated data.
        </Text>
      </Page>
    </Document>
  );
}

export async function renderIntelligencePdf(input: {
  reportId: string; brandName: string; domain: string | null;
  audits: AuditResult[]; opportunities: RevenueOpportunity[]; plan: GrowthPlan;
  generatedAt: string;
}): Promise<string> {
  const element = <ReportDocument {...input} />;
  const pdf = await renderPdf(element);
  const dir = path.join(process.cwd(), ".data", "reports");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `intelligence-${input.reportId}.pdf`);
  await fs.writeFile(filePath, pdf);
  const pdfUrl = path.relative(process.cwd(), filePath);
  await prisma.intelligenceReport.update({
    where: { id: input.reportId },
    data: { pdfUrl },
  });
  return pdfUrl;
}
