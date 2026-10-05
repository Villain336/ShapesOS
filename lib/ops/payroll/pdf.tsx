// ShapesOS — Phase 12 (people): the payslip PDF.
//
// Reuses the existing PDF engine (lib/pdf — the pdfcn component tree
// rendered by Takumi through renderPdf()), the same as invoices
// (lib/ops/finance/pdf.tsx). Every payslip carries the "verify with your
// accountant" banner and names the tax table and its source year.

import type { ReactElement } from "react";
import { Document, Page, View, Text as SpanText } from "@/lib/pdf-primitives";
import { PdfcnThemeProvider } from "@/components/pdf/theme-provider";
import { Heading as PdfHeading } from "@/components/pdf/heading/heading";
import { Table as PdfTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/pdf/table/table";
import { Divider as PdfDivider } from "@/components/pdf/divider/divider";
import { PageNumber } from "@/components/pdf/page-number/page-number";
import { brandKitTheme } from "@/lib/pdf/brand-theme";
import { renderPdf } from "@/lib/pdf/renderer";
import { fmtMoney } from "../finance/money";
import type { PayslipLine, PayslipLineKind } from "./rules";
import { PAYROLL_TAX_DISCLAIMER } from "./tax";

export interface PayslipDocInput {
  employer: string;
  runNumber: string | null;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  memberName: string;
  structureName: string;
  regularMinutes: number;
  overtimeMinutes: number;
  grossCents: number;
  preTaxDeductionCents: number;
  employeeTaxCents: number;
  postTaxDeductionCents: number;
  netCents: number;
  employerTaxCents: number;
  employerContribCents: number;
  lines: PayslipLine[];
  taxTable: string;
  taxSource: string;
  warnings: string[];
  currency?: string;
}

const MUTED = { fontSize: 10, color: "#5E5E5B" } as const;

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

const SECTIONS: Array<{ kinds: PayslipLineKind[]; title: string }> = [
  { kinds: ["earning"], title: "Earnings" },
  { kinds: ["pre_tax_deduction"], title: "Pre-tax deductions" },
  { kinds: ["employee_tax"], title: "Taxes withheld" },
  { kinds: ["post_tax_deduction"], title: "Post-tax deductions" },
  { kinds: ["employer_tax", "employer_contribution"], title: "Paid by the employer (not deducted)" },
];

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 4 }}>
      <SpanText style={{ width: 180, fontSize: strong ? 12 : 10, textAlign: "right", color: strong ? "#000000" : "#5E5E5B" }}>{label}</SpanText>
      <SpanText style={{ width: 110, fontSize: strong ? 12 : 10, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</SpanText>
    </View>
  );
}

export function buildPayslipDocument(d: PayslipDocInput): ReactElement {
  const money = (c: number) => fmtMoney(c, d.currency ?? "USD");
  const title = `Payslip — ${d.memberName}`;
  return (
    <Document title={title}>
      <Page>
        <PdfcnThemeProvider theme={brandKitTheme({})}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
            <View>
              <PdfHeading level={2} noMargin>
                {d.employer}
              </PdfHeading>
              <SpanText style={MUTED}>{`Payslip${d.runNumber ? ` · ${d.runNumber}` : ""}`}</SpanText>
            </View>
            <View>
              <SpanText style={MUTED}>{`Period ${fmtDate(d.periodStart)} – ${fmtDate(d.periodEnd)}`}</SpanText>
              <SpanText style={MUTED}>{`Pay date ${fmtDate(d.payDate)}`}</SpanText>
            </View>
          </View>
          <View style={{ backgroundColor: "#F3F3F1", padding: 8, marginBottom: 10 }}>
            <SpanText style={{ fontSize: 10, fontWeight: 700 }}>Verify with your accountant</SpanText>
            <SpanText style={{ fontSize: 9 }}>{PAYROLL_TAX_DISCLAIMER}</SpanText>
            <SpanText style={{ fontSize: 8, color: "#5E5E5B" }}>{`Tax table ${d.taxTable}. ${d.taxSource}`}</SpanText>
          </View>
          <PdfDivider />
          <View style={{ marginTop: 8, marginBottom: 12 }}>
            <SpanText style={MUTED}>Employee</SpanText>
            <SpanText style={{ fontSize: 12 }}>{d.memberName}</SpanText>
            <SpanText style={MUTED}>
              {`${d.structureName}${d.regularMinutes || d.overtimeMinutes ? ` · ${(d.regularMinutes / 60).toFixed(2)} h regular${d.overtimeMinutes ? `, ${(d.overtimeMinutes / 60).toFixed(2)} h overtime` : ""}` : ""}`}
            </SpanText>
          </View>
          {SECTIONS.map((sec) => {
            const rows = d.lines.filter((l) => sec.kinds.includes(l.kind));
            if (rows.length === 0) return null;
            return (
              <View key={sec.title} style={{ marginBottom: 10 }}>
                <SpanText style={{ fontSize: 10, fontWeight: 700, marginBottom: 4 }}>{sec.title}</SpanText>
                <PdfTable variant="line">
                  <TableHeader>
                    <TableRow header>
                      <TableCell header>Item</TableCell>
                      <TableCell header>Detail</TableCell>
                      <TableCell header align="right">Amount</TableCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((l, i) => (
                      <TableRow key={`${l.code}-${i}`}>
                        <TableCell>{l.label}</TableCell>
                        <TableCell>{l.detail ?? ""}</TableCell>
                        <TableCell align="right">{money(l.amountCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </PdfTable>
              </View>
            );
          })}
          <View style={{ marginTop: 6 }}>
            <Row label="Gross pay" value={money(d.grossCents)} />
            <Row label="Pre-tax deductions" value={`−${money(d.preTaxDeductionCents)}`} />
            <Row label="Taxes withheld" value={`−${money(d.employeeTaxCents)}`} />
            <Row label="Post-tax deductions" value={`−${money(d.postTaxDeductionCents)}`} />
            <Row label="Net pay" value={money(d.netCents)} strong />
            <Row label="Employer taxes" value={money(d.employerTaxCents)} />
            <Row label="Employer contributions" value={money(d.employerContribCents)} />
          </View>
          {d.warnings.length ? (
            <View style={{ marginTop: 14 }}>
              <SpanText style={MUTED}>Notes</SpanText>
              {d.warnings.map((w, i) => (
                <SpanText key={i} style={{ fontSize: 9 }}>{`• ${w}`}</SpanText>
              ))}
            </View>
          ) : null}
          <View style={{ marginTop: 24 }}>
            <PdfDivider />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
              <SpanText style={{ fontSize: 9, color: "#5E5E5B" }}>{`${d.employer} · net pay is paid outside ShapesOS`}</SpanText>
              <PageNumber format="Page {page} of {total}" align="right" />
            </View>
          </View>
        </PdfcnThemeProvider>
      </Page>
    </Document>
  );
}

export async function renderPayslipPdf(d: PayslipDocInput): Promise<Buffer> {
  return renderPdf(buildPayslipDocument(d));
}

export function payslipFilename(runNumber: string | null, memberName: string, id: string): string {
  const base = `payslip-${runNumber ?? id}-${memberName}`.toLowerCase().replace(/\s+/g, "-");
  return `${base.replace(/[^a-z0-9._-]/g, "_").slice(0, 120)}.pdf`;
}
