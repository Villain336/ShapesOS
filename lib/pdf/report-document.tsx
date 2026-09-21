// Marketr — Tiptap JSON → pdfcn React tree (milestone 12).
//
// A report template is stored as Tiptap JSON (edited with the editorcn block
// editor). This module maps the node types the editor produces onto pdfcn
// components, wrapped in the brand kit's PdfcnThemeProvider, plus document
// chrome (branded header, footer page numbers).
//
// Placeholders: a paragraph whose entire text is {{rankings_table}} becomes
// a generated rankings table; inline {{key}} tokens are string-replaced from
// the placeholder context.

import type { ReactElement, ReactNode } from "react";
import { Document, Page, View, Text as SpanText, Image as PdfImage } from "@/lib/pdf-primitives";
import { PdfcnThemeProvider } from "@/components/pdf/theme-provider";
import { Text as PdfText } from "@/components/pdf/text/text";
import { Heading as PdfHeading } from "@/components/pdf/heading/heading";
import {
  Table as PdfTable,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/pdf/table/table";
import { Divider as PdfDivider } from "@/components/pdf/divider/divider";
import { PageNumber } from "@/components/pdf/page-number/page-number";
import type { PdfcnTheme } from "@/components/pdf/theme-types";

// ---------------------------------------------------------------------------
// Tiptap JSON types (minimal surface we map)
// ---------------------------------------------------------------------------

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
}

// ---------------------------------------------------------------------------
// Placeholder context (resolved at generation time from project data)
// ---------------------------------------------------------------------------

export interface RankingRow {
  phrase: string;
  position: number | null;
  change: number | null; // vs previous check; null = new/no history
  url: string | null;
  aiOverview: boolean;
}

export interface PlaceholderContext {
  projectDomain: string;
  period: string;
  generatedAt: string;
  brandName: string;
  rankings: RankingRow[];
  summary: {
    tracked: number;
    ranked: number;
    avgPosition: number | null;
    improved: number;
    declined: number;
    aiOverviewCount: number;
  };
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function resolveInlinePlaceholders(text: string, ctx: PlaceholderContext): string {
  return text.replace(PLACEHOLDER_RE, (_m, key: string) => {
    switch (key) {
      case "project_domain":
        return ctx.projectDomain;
      case "period":
        return ctx.period;
      case "generated_at":
        return ctx.generatedAt;
      case "brand_name":
        return ctx.brandName;
      case "tracked_count":
        return String(ctx.summary.tracked);
      case "avg_position":
        return ctx.summary.avgPosition == null ? "—" : ctx.summary.avgPosition.toFixed(1);
      case "improved_count":
        return String(ctx.summary.improved);
      case "declined_count":
        return String(ctx.summary.declined);
      case "ai_overview_count":
        return String(ctx.summary.aiOverviewCount);
      default:
        return _m; // leave unknown tokens untouched
    }
  });
}

/** A paragraph that is exactly {{rankings_table}} becomes a generated table. */
function isRankingsTablePlaceholder(node: TiptapNode): boolean {
  if (node.type !== "paragraph" || !node.content || node.content.length !== 1) return false;
  const only = node.content[0];
  return only.type === "text" && (only.text ?? "").trim() === "{{rankings_table}}";
}

// ---------------------------------------------------------------------------
// Node mapping
// ---------------------------------------------------------------------------

function inlineStyleForMarks(marks: TiptapMark[] | undefined): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  for (const mark of marks ?? []) {
    if (mark.type === "bold") style.fontWeight = 700;
    else if (mark.type === "italic") style.fontStyle = "italic";
    else if (mark.type === "underline") style.textDecoration = "underline";
    else if (mark.type === "strike") style.textDecoration = "line-through";
    else if (mark.type === "code") style.fontFamily = "Courier";
  }
  return style;
}

function mapInline(node: TiptapNode, ctx: PlaceholderContext, key: string): ReactNode {
  if (node.type === "text") {
    const text = resolveInlinePlaceholders(node.text ?? "", ctx);
    const link = node.marks?.find((m) => m.type === "link");
    const href = typeof link?.attrs?.href === "string" ? link.attrs.href : undefined;
    return (
      <SpanText key={key} style={inlineStyleForMarks(node.marks)} href={href}>
        {text}
      </SpanText>
    );
  }
  if (node.type === "hardBreak") {
    return <br key={key} />;
  }
  return null;
}

function mapChildren(
  nodes: TiptapNode[] | undefined,
  ctx: PlaceholderContext,
  keyPrefix: string,
): ReactNode[] {
  return (nodes ?? []).map((n, i) => mapBlock(n, ctx, `${keyPrefix}-${i}`));
}

function mapBlock(node: TiptapNode, ctx: PlaceholderContext, key: string): ReactNode {
  // Dynamic table placeholder
  if (isRankingsTablePlaceholder(node)) {
    return <RankingsTable key={key} rows={ctx.rankings} />;
  }

  switch (node.type) {
    case "paragraph": {
      const align = node.attrs?.textAlign as "left" | "center" | "right" | undefined;
      const inlines = (node.content ?? []).map((n, i) => mapInline(n, ctx, `${key}-i${i}`));
      return (
        <PdfText key={key} align={align}>
          {inlines}
        </PdfText>
      );
    }
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
      const align = node.attrs?.textAlign as "left" | "center" | "right" | undefined;
      const inlines = (node.content ?? []).map((n, i) => mapInline(n, ctx, `${key}-i${i}`));
      return (
        <PdfHeading key={key} level={level} align={align}>
          {inlines}
        </PdfHeading>
      );
    }
    case "bulletList":
      return (
        <View key={key} style={{ marginBottom: 10 }}>
          {(node.content ?? []).map((item, i) => (
            <View key={`${key}-li${i}`} style={{ flexDirection: "row", marginBottom: 4 }}>
              <SpanText style={{ width: 16 }}>•</SpanText>
              <View style={{ flex: 1 }}>
                {(item.content ?? []).map((n, j) => mapBlock(n, ctx, `${key}-li${i}-${j}`))}
              </View>
            </View>
          ))}
        </View>
      );
    case "orderedList":
      return (
        <View key={key} style={{ marginBottom: 10 }}>
          {(node.content ?? []).map((item, i) => (
            <View key={`${key}-li${i}`} style={{ flexDirection: "row", marginBottom: 4 }}>
              <SpanText style={{ width: 20 }}>{`${i + 1}.`}</SpanText>
              <View style={{ flex: 1 }}>
                {(item.content ?? []).map((n, j) => mapBlock(n, ctx, `${key}-li${i}-${j}`))}
              </View>
            </View>
          ))}
        </View>
      );
    case "blockquote": {
      const inlines = (node.content ?? []).flatMap((n) => n.content ?? []);
      return (
        <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: "#d4d4d8", paddingLeft: 12, marginBottom: 10 }}>
          {inlines.map((n, i) => mapInline(n, ctx, `${key}-q${i}`))}
        </View>
      );
    }
    case "codeBlock": {
      const code = (node.content ?? []).map((n) => n.text ?? "").join("");
      return (
        <View key={key} style={{ backgroundColor: "#f4f4f5", padding: 10, marginBottom: 10 }}>
          <SpanText style={{ fontFamily: "Courier", fontSize: 10 }}>{code}</SpanText>
        </View>
      );
    }
    case "horizontalRule":
      return <PdfDivider key={key} />;
    case "table": {
      const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
      const headerRows = rows.filter((r) =>
        (r.content ?? []).some((c) => c.type === "tableHeader"),
      );
      const bodyRows = rows.filter((r) => !headerRows.includes(r));
      const renderRow = (row: TiptapNode, ri: number, header: boolean) => (
        <TableRow key={`${key}-r${ri}`} header={header}>
          {(row.content ?? []).map((cell, ci) => (
            <TableCell key={`${key}-r${ri}-c${ci}`} header={header || cell.type === "tableHeader"}>
              {(cell.content ?? []).map((n, ni) =>
                n.type === "paragraph"
                  ? (n.content ?? []).map((t, ti) => mapInline(t, ctx, `${key}-r${ri}-c${ci}-t${ti}`))
                  : mapBlock(n, ctx, `${key}-r${ri}-c${ci}-${ni}`),
              )}
            </TableCell>
          ))}
        </TableRow>
      );
      return (
        <PdfTable key={key} variant="line" zebraStripe>
          {headerRows.length > 0 && (
            <TableHeader>{headerRows.map((r, i) => renderRow(r, i, true))}</TableHeader>
          )}
          <TableBody>{bodyRows.map((r, i) => renderRow(r, i, false))}</TableBody>
        </PdfTable>
      );
    }
    case "image": {
      const src = node.attrs?.src;
      if (typeof src !== "string" || !src) return null;
      return <PdfImage key={key} src={src} style={{ marginBottom: 10 }} />;
    }
    default:
      // Unknown node: descend if it has block children, else ignore.
      if (node.content?.length) {
        return <View key={key}>{mapChildren(node.content, ctx, key)}</View>;
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Generated rankings table ({{rankings_table}})
// ---------------------------------------------------------------------------

function formatChange(change: number | null): string {
  if (change == null) return "new";
  if (change > 0) return `+${change}`;
  if (change < 0) return `${change}`;
  return "–";
}

function RankingsTable({ rows }: { rows: RankingRow[] }) {
  return (
    <PdfTable variant="line" zebraStripe>
      <TableHeader>
        <TableRow header>
          <TableCell header>Keyword</TableCell>
          <TableCell header align="center">
            Position
          </TableCell>
          <TableCell header align="center">
            Change
          </TableCell>
          <TableCell header align="center">
            AI Overview
          </TableCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell>No tracked keywords with ranking data yet.</TableCell>
            <TableCell align="center">—</TableCell>
            <TableCell align="center">—</TableCell>
            <TableCell align="center">—</TableCell>
          </TableRow>
        )}
        {rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell>{r.phrase}</TableCell>
            <TableCell align="center">{r.position == null ? "—" : String(r.position)}</TableCell>
            <TableCell align="center">{formatChange(r.change)}</TableCell>
            <TableCell align="center">{r.aiOverview ? "Yes" : "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </PdfTable>
  );
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

export interface ReportDocumentInput {
  template: TiptapNode;
  theme: PdfcnTheme;
  title: string;
  brandName: string;
  logoSrc?: string;
  ctx: PlaceholderContext;
}

export function buildReportDocument(input: ReportDocumentInput): ReactElement {
  const { template, theme, title, brandName, logoSrc, ctx } = input;
  return (
    <Document title={title}>
      <Page>
        <PdfcnThemeProvider theme={theme}>
          {/* Branded header */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            {logoSrc && <PdfImage src={logoSrc} style={{ height: 28, marginRight: 10 }} />}
            <View>
              <PdfHeading level={2} noMargin>
                {brandName}
              </PdfHeading>
              <SpanText style={{ fontSize: 10, color: "#71717a" }}>
                {title} · {ctx.period}
              </SpanText>
            </View>
          </View>
          <PdfDivider />
          {/* Template body */}
          {mapChildren(template.content, ctx, "body")}
          {/* Footer */}
          <View style={{ marginTop: 24 }}>
            <PdfDivider />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
              <SpanText style={{ fontSize: 9, color: "#71717a" }}>
                Generated {ctx.generatedAt} · {brandName}
              </SpanText>
              <PageNumber format="Page {page} of {total}" align="right" />
            </View>
          </View>
        </PdfcnThemeProvider>
      </Page>
    </Document>
  );
}
