// ShapesOS — Phase 10 (finance): invoice / credit note / quote PDFs.
//
// Reuses the existing PDF engine (lib/pdf): the pdfcn component tree rendered
// by Takumi through renderPdf(). Pure document assembly here; the routes load
// the record and stream the bytes.

import type { ReactElement } from "react";
import { Document, Page, View, Text as SpanText } from "@/lib/pdf-primitives";
import { PdfcnThemeProvider } from "@/components/pdf/theme-provider";
import { Heading as PdfHeading } from "@/components/pdf/heading/heading";
import { Table as PdfTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/pdf/table/table";
import { Divider as PdfDivider } from "@/components/pdf/divider/divider";
import { PageNumber } from "@/components/pdf/page-number/page-number";
import { brandKitTheme } from "@/lib/pdf/brand-theme";
import { renderPdf } from "@/lib/pdf/renderer";
import { fmtMoney } from "./money";

export interface FinanceDocLine {
  description: string;
  qty: number;
  priceCents: number;
  taxCents?: number | null;
}

export interface FinanceDocInput {
  kind: "Invoice" | "Credit note" | "Quote";
  number: string | null;
  issuedAt: Date | null;
  dueAt?: Date | null;
  validUntil?: Date | null;
  fromName: string;
  toName: string;
  toDetail?: string | null;
  lines: FinanceDocLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents?: number;
  creditedCents?: number;
  balanceCents?: number;
  notes?: string | null;
  footer?: string | null;
  paymentLinkUrl?: string | null;
  currency?: string;
}

const MUTED = { fontSize: 10, color: "#5E5E5B" } as const;

function fmtDate(d: Date | null | undefined): string {
  return d ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—";
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 4 }}>
      <SpanText style={{ width: 140, fontSize: strong ? 12 : 10, textAlign: "right", color: strong ? "#000000" : "#5E5E5B" }}>{label}</SpanText>
      <SpanText style={{ width: 110, fontSize: strong ? 12 : 10, textAlign: "right", fontWeight: strong ? 700 : 400 }}>{value}</SpanText>
    </View>
  );
}

export function buildFinanceDocument(d: FinanceDocInput): ReactElement {
  const money = (c: number) => fmtMoney(c, d.currency ?? "USD");
  const title = `${d.kind}${d.number ? ` ${d.number}` : " (draft)"}`;
  return (
    <Document title={title}>
      <Page>
        <PdfcnThemeProvider theme={brandKitTheme({})}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
            <View>
              <PdfHeading level={2} noMargin>
                {d.fromName}
              </PdfHeading>
              <SpanText style={MUTED}>{title}</SpanText>
            </View>
            <View>
              <SpanText style={MUTED}>{`Issued ${fmtDate(d.issuedAt)}`}</SpanText>
              {d.dueAt ? <SpanText style={MUTED}>{`Due ${fmtDate(d.dueAt)}`}</SpanText> : null}
              {d.validUntil ? <SpanText style={MUTED}>{`Valid until ${fmtDate(d.validUntil)}`}</SpanText> : null}
            </View>
          </View>
          <PdfDivider />
          <View style={{ marginTop: 8, marginBottom: 12 }}>
            <SpanText style={MUTED}>{d.kind === "Quote" ? "Prepared for" : "Billed to"}</SpanText>
            <SpanText style={{ fontSize: 12 }}>{d.toName}</SpanText>
            {d.toDetail ? <SpanText style={MUTED}>{d.toDetail}</SpanText> : null}
          </View>
          <PdfTable variant="line" zebraStripe>
            <TableHeader>
              <TableRow header>
                <TableCell header>Description</TableCell>
                <TableCell header align="right">Qty</TableCell>
                <TableCell header align="right">Unit price</TableCell>
                <TableCell header align="right">Tax</TableCell>
                <TableCell header align="right">Amount</TableCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell>{l.description}</TableCell>
                  <TableCell align="right">{String(l.qty)}</TableCell>
                  <TableCell align="right">{money(l.priceCents)}</TableCell>
                  <TableCell align="right">{l.taxCents ? money(l.taxCents) : "—"}</TableCell>
                  <TableCell align="right">{money(l.qty * l.priceCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </PdfTable>
          <View style={{ marginTop: 10 }}>
            <TotalRow label="Subtotal" value={money(d.subtotalCents)} />
            <TotalRow label="Tax" value={money(d.taxCents)} />
            <TotalRow label="Total" value={money(d.totalCents)} strong />
            {d.paidCents ? <TotalRow label="Paid" value={`−${money(d.paidCents)}`} /> : null}
            {d.creditedCents ? <TotalRow label="Credited" value={`−${money(d.creditedCents)}`} /> : null}
            {d.balanceCents !== undefined && d.kind === "Invoice" ? (
              <TotalRow label="Balance due" value={money(d.balanceCents)} strong />
            ) : null}
          </View>
          {d.paymentLinkUrl && d.kind === "Invoice" && (d.balanceCents ?? 0) > 0 ? (
            <View style={{ marginTop: 14 }}>
              <SpanText style={{ fontSize: 10 }}>Pay online:</SpanText>
              <SpanText style={{ fontSize: 10 }} href={d.paymentLinkUrl}>
                {d.paymentLinkUrl}
              </SpanText>
            </View>
          ) : null}
          {d.notes ? (
            <View style={{ marginTop: 14 }}>
              <SpanText style={MUTED}>Notes</SpanText>
              <SpanText style={{ fontSize: 10 }}>{d.notes}</SpanText>
            </View>
          ) : null}
          <View style={{ marginTop: 24 }}>
            <PdfDivider />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
              <SpanText style={{ fontSize: 9, color: "#5E5E5B" }}>{d.footer ?? d.fromName}</SpanText>
              <PageNumber format="Page {page} of {total}" align="right" />
            </View>
          </View>
        </PdfcnThemeProvider>
      </Page>
    </Document>
  );
}

export async function renderFinancePdf(d: FinanceDocInput): Promise<Buffer> {
  return renderPdf(buildFinanceDocument(d));
}

export function pdfFilename(kind: FinanceDocInput["kind"], number: string | null, id: string): string {
  const base = `${kind.toLowerCase().replace(/\s+/g, "-")}-${number ?? id}`;
  return `${base.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}
