// Marketr — EDDM mailhouse handoff brief (Phase 4, Track T3).
//
// Builds the PDF content for the mailhouse handoff brief and renders it
// through the shared pdfcn pipeline (lib/pdf/renderer.ts → Takumi).
// Storage mirrors the report pattern: EDDM_BRIEF_STORAGE_DIR env, default
// <repo>/.data/eddm-briefs, one file per order.
//
// The brief is a PLANNING document — estimates only, no spend authorized,
// no API send path. Copy never implies Marketr mailed anything.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { Document, Page, View, Text as SpanText, Image as PdfImage } from "@/lib/pdf-primitives";
import { PdfcnThemeProvider } from "@/components/pdf/theme-provider";
import { professionalTheme } from "@/components/pdf/theme-professional";
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
import { prisma } from "@/lib/prisma";
import { renderPdf } from "@/lib/pdf/renderer";
import { qrPngDataUrl } from "@/lib/physical/qr";
// NOTE: FileChangeLog's FileChangeAction is a closed DB enum with no eddm_*
// actions (extending it needs a schema migration), so brief lifecycle events
// are recorded on the EddmOrder row itself (briefPdfUrl, status).
import {
  coerceEddmRoutes,
  eddmDropUrl,
  eddmInHomeWindow,
  estimateEddmCost,
  fmtCents,
  fmtDate,
  mintEddmQrSlug,
  type EddmEstimate,
  type EddmPostageTier,
  type EddmRouteRow,
} from "@/lib/mail/eddm";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/api/errors";

export function eddmBriefStorageDir(): string {
  const override = (process.env.EDDM_BRIEF_STORAGE_DIR ?? "").trim();
  if (override) return override;
  return path.join(process.cwd(), ".data", "eddm-briefs");
}

export interface EddmBriefCreative {
  name: string;
  formatTrack: string;
  size: string;
  version: number;
  creativeHash: string | null;
  pdfUrl: string | null;
}

export interface EddmBriefInput {
  orderName: string;
  status: string;
  mailhouse: string | null;
  pieceCount: number;
  dropDate: Date | null;
  inHomeStart: Date | null;
  inHomeEnd: Date | null;
  routes: EddmRouteRow[];
  creative: EddmBriefCreative;
  estimate: EddmEstimate;
  qrSlug: string;
  dropUrl: string;
  qrDataUrl: string;
  generatedAt: string;
  workspaceName: string;
}

const POSTAGE_TIER_LABEL: Record<EddmPostageTier, string> = {
  retail: "EDDM Retail (post office acceptance)",
  bmeu: "BMEU entry",
};

const FACING_SLIP_NOTES = [
  "Bundle pieces by carrier route: 50–100 pieces per bundle, secured so they stay together in transit.",
  "Place a facing slip on top of EVERY bundle showing: mailer name and address, piece count, carrier route (e.g. C001), and 5-digit ZIP.",
  "EDDM Retail: present at the post office with PS Form 3580 (postage statement) and pay postage at acceptance — minimum 200 pieces per mailing per ZIP.",
  "BMEU entry: coordinate entry facility and appointment with the mailhouse; postage is paid through the mailer's permit imprint account.",
  "Verify carrier-route counts against current USPS EDDM data before print — route counts in this brief are planning figures.",
  "In-home window is a USPS transit estimate (drop + 3–7 days). USPS does not guarantee EDDM delivery dates.",
  "Creative is an EDDM flat — finished size must be at least 6.125\u2033 × 11.5\u2033. A 4×6 postcard does not qualify for EDDM postage.",
];

function SectionTitle({ children }: { children: string }) {
  return (
    <PdfHeading level={3} noMargin>
      {children}
    </PdfHeading>
  );
}

function Labeled({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", marginBottom: 3 }}>
      <SpanText style={{ fontSize: 10, color: "#71717a", width: 130 }}>{label}</SpanText>
      <SpanText style={{ fontSize: 10, color: "#18181b", flex: 1 }}>{value}</SpanText>
    </View>
  );
}

export function buildEddmBriefDocument(input: EddmBriefInput): ReactElement {
  const selected = input.routes.filter((r) => r.selected !== false);
  const est = input.estimate;
  return (
    <Document title={`EDDM Handoff Brief — ${input.orderName}`}>
      <Page>
        <PdfcnThemeProvider theme={professionalTheme}>
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            <View style={{ flex: 1 }}>
              <PdfHeading level={2} noMargin>
                EDDM Mailhouse Handoff Brief
              </PdfHeading>
              <SpanText style={{ fontSize: 10, color: "#71717a" }}>
                {input.orderName} · {input.workspaceName} · Generated {input.generatedAt}
              </SpanText>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <SpanText style={{ fontSize: 10, fontWeight: 700, color: "#4c1d95" }}>
                {input.status.toUpperCase().replace(/_/g, " ")}
              </SpanText>
              <SpanText style={{ fontSize: 9, color: "#71717a" }}>
                Planning document — estimates only
              </SpanText>
            </View>
          </View>
          <PdfDivider />

          {/* Drop summary */}
          <View style={{ marginTop: 10, marginBottom: 10 }}>
            <SectionTitle>Drop summary</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <Labeled label="Mailhouse" value={input.mailhouse || "— (assign before drop)"} />
              <Labeled label="Total pieces" value={input.pieceCount.toLocaleString("en-US")} />
              <Labeled label="Carrier routes" value={`${selected.length} selected`} />
              <Labeled label="Drop date" value={fmtDate(input.dropDate)} />
              <Labeled
                label="In-home target"
                value={`${fmtDate(input.inHomeStart)} – ${fmtDate(input.inHomeEnd)}`}
              />
            </View>
          </View>

          {/* Routes */}
          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Carrier routes</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <PdfTable variant="line" zebraStripe>
                <TableHeader>
                  <TableRow header>
                    <TableCell header>ZIP</TableCell>
                    <TableCell header>Route</TableCell>
                    <TableCell header align="right">
                      Households
                    </TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell>{r.zip}</TableCell>
                      <TableCell>{r.routeId}</TableCell>
                      <TableCell align="right">{r.households.toLocaleString("en-US")}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell>{selected.length} routes</TableCell>
                    <TableCell align="right">{input.pieceCount.toLocaleString("en-US")}</TableCell>
                  </TableRow>
                </TableBody>
              </PdfTable>
            </View>
            <PdfText variant="xs" color="#71717a">
              Route counts are planning figures — verify against current USPS EDDM data with the
              mailhouse before print.
            </PdfText>
          </View>

          {/* Creative spec */}
          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Creative spec</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <Labeled label="Creative" value={`${input.creative.name} (v${input.creative.version})`} />
              <Labeled label="Format track" value={`EDDM flat — ${input.creative.size}`} />
              <Labeled
                label="Creative hash"
                value={input.creative.creativeHash ? input.creative.creativeHash.slice(0, 24) + "…" : "—"}
              />
              <Labeled label="Print file" value={input.creative.pdfUrl || "— (attach before handoff)"} />
            </View>
          </View>

          {/* Cost estimate */}
          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Cost estimate</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <PdfTable variant="line" zebraStripe>
                <TableHeader>
                  <TableRow header>
                    <TableCell header>Line</TableCell>
                    <TableCell header align="right">
                      Per piece
                    </TableCell>
                    <TableCell header align="right">
                      Total
                    </TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>Postage — {POSTAGE_TIER_LABEL[est.postageTier]}</TableCell>
                    <TableCell align="right">{fmtCents(est.postageCentsPerPiece)}</TableCell>
                    <TableCell align="right">{fmtCents(est.postageCents)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Print + prep</TableCell>
                    <TableCell align="right">{fmtCents(est.printCentsPerPiece)}</TableCell>
                    <TableCell align="right">{fmtCents(est.printCents)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Estimated total</TableCell>
                    <TableCell align="right">{fmtCents(est.perPieceCents)}</TableCell>
                    <TableCell align="right">{fmtCents(est.totalCents)}</TableCell>
                  </TableRow>
                </TableBody>
              </PdfTable>
            </View>
            <PdfText variant="xs" color="#71717a">
              Estimate only — postage is paid at acceptance (EDDM Retail) or via permit imprint
              (BMEU). No spend is authorized by this brief.
            </PdfText>
          </View>

          {/* QR / pURL */}
          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Tracking — QR / pURL</SectionTitle>
            <View style={{ flexDirection: "row", marginTop: 6 }}>
              <PdfImage src={input.qrDataUrl} style={{ width: 110, height: 110, marginRight: 12 }} />
              <View style={{ flex: 1 }}>
                <Labeled label="Drop slug" value={input.qrSlug} />
                <Labeled label="pURL" value={input.dropUrl} />
                <PdfText variant="xs" color="#71717a">
                  Print this QR on the piece. Confirm the scan target resolves before print — the
                  drop pURL is reserved for this drop&apos;s attribution.
                </PdfText>
              </View>
            </View>
          </View>

          {/* Facing-slip prep notes */}
          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Mailhouse prep notes</SectionTitle>
            <View style={{ marginTop: 6 }}>
              {FACING_SLIP_NOTES.map((note, i) => (
                <View key={i} style={{ flexDirection: "row", marginBottom: 4 }}>
                  <SpanText style={{ width: 16, fontSize: 10 }}>•</SpanText>
                  <SpanText style={{ fontSize: 10, flex: 1, color: "#27272a" }}>{note}</SpanText>
                </View>
              ))}
            </View>
          </View>

          {/* Footer */}
          <View style={{ marginTop: 16 }}>
            <PdfDivider />
            <View
              style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}
            >
              <SpanText style={{ fontSize: 9, color: "#71717a" }}>
                Generated {input.generatedAt} · {input.workspaceName} · Marketr EDDM concierge
              </SpanText>
              <PageNumber format="Page {page} of {total}" align="right" />
            </View>
          </View>
        </PdfcnThemeProvider>
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// Generation orchestration
// ---------------------------------------------------------------------------

export interface GenerateEddmBriefInput {
  workspaceId: string;
  orderId: string;
  postageTier?: EddmPostageTier;
  printCentsPerPiece?: number;
  origin: string;
  actorUserId?: string | null;
}

export interface GenerateEddmBriefResult {
  pdfPath: string;
  briefPdfUrl: string;
  qrSlug: string;
  dropUrl: string;
}

/**
 * Render the mailhouse handoff brief for an order and store the PDF on disk.
 * Requires bound EDDM-track creative + selected routes. Does NOT change the
 * order's status (the API layer advances draft → briefed).
 */
export async function generateEddmBriefPdf(
  input: GenerateEddmBriefInput,
): Promise<GenerateEddmBriefResult> {
  const orderRow = await prisma.eddmOrder.findFirst({
    where: { id: input.orderId, workspaceId: input.workspaceId },
    include: { workspace: { select: { name: true } } },
  });
  if (!orderRow) throw new NotFoundError("EDDM order not found");
  if (orderRow.status !== "draft" && orderRow.status !== "briefed") {
    throw new ConflictError(`Cannot generate a brief for a ${orderRow.status} order.`);
  }
  // creativeId is a scalar (no Prisma relation) — fetch the creative directly.
  const creative = orderRow.creativeId
    ? await prisma.mailCreative.findFirst({
        where: { id: orderRow.creativeId, workspaceId: input.workspaceId },
      })
    : null;
  const order = { ...orderRow, creative };
  if (!order.creative) throw new ConflictError("Bind a creative before generating the brief.");
  if (order.creative.formatTrack !== "eddm") {
    throw new BadRequestError("Bound creative is not on the EDDM format track.");
  }
  const routes = coerceEddmRoutes(order.routes).filter((r) => r.selected !== false);
  if (routes.length === 0 || order.pieceCount <= 0) {
    throw new ConflictError("Add carrier routes before generating the brief.");
  }

  const estimate = estimateEddmCost({
    routes: coerceEddmRoutes(order.routes),
    postageTier: input.postageTier,
    printCentsPerPiece: input.printCentsPerPiece,
  });

  let qrSlug = order.qrSlug;
  if (!qrSlug) {
    qrSlug = await mintEddmQrSlug();
  }
  const dropUrl = eddmDropUrl(qrSlug, input.origin);
  const qrDataUrl = await qrPngDataUrl(dropUrl);

  // The in-home window is stamped at the "dropped" transition; before that,
  // preview it from the scheduled drop date (drop + 3–7 days) so the
  // mailhouse sees the target window on the handoff brief.
  const inHome =
    order.inHomeStart && order.inHomeEnd
      ? { start: order.inHomeStart, end: order.inHomeEnd }
      : order.dropDate
        ? eddmInHomeWindow(order.dropDate)
        : null;

  const element = buildEddmBriefDocument({
    orderName: order.name,
    status: order.status,
    mailhouse: order.mailhouse,
    pieceCount: order.pieceCount,
    dropDate: order.dropDate,
    inHomeStart: inHome?.start ?? null,
    inHomeEnd: inHome?.end ?? null,
    routes: coerceEddmRoutes(order.routes),
    creative: {
      name: order.creative.name,
      formatTrack: order.creative.formatTrack,
      size: order.creative.size,
      version: order.creative.version,
      creativeHash: order.creative.creativeHash,
      pdfUrl: order.creative.pdfUrl,
    },
    estimate,
    qrSlug,
    dropUrl,
    qrDataUrl,
    generatedAt: new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    workspaceName: order.workspace.name,
  });
  const pdf = await renderPdf(element);

  const dir = eddmBriefStorageDir();
  await fs.mkdir(dir, { recursive: true });
  const pdfPath = path.join(dir, `${order.id}.pdf`);
  await fs.writeFile(pdfPath, pdf);

  const briefPdfUrl = `/api/eddm/orders/${order.id}/brief-pdf`;
  await prisma.eddmOrder.update({
    where: { id: order.id },
    data: { briefPdfUrl, qrSlug },
  });

  // FileChangeLog cannot represent eddm_* actions until the FileChangeAction
  // enum is extended (schema change, owned by the coordinator); the brief
  // generation is recorded on the order row (briefPdfUrl) itself.

  return { pdfPath, briefPdfUrl, qrSlug, dropUrl };
}
