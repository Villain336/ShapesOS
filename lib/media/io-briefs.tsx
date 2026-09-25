// Marketr — Phase 5 B3: IO-brief generator (IAB/AAAA template).
//
// Broadcast radio and print are rep-driven (docs/phase5-research.md §Track 3
// — the honest-model question is CONFIRMED): Marketr plans, briefs, and
// measures; it does not intermediate. The IO brief is generated on the
// IAB/AAAA standard-terms template (v3.0): an IO must bind (a) deliverables,
// (b) prices, (c) MAXIMUM amount to be spent, (d) start/end dates,
// (e) third-party ad server identity. The REP keeps the signature —
// signature_status tracks draft → sent_to_rep → signed, and proof-of-run
// capture closes the loop. Magazines are planning-only (6–8 week lead
// times, heaviest rep dependence).

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ReactElement } from "react";
import { Document, Page, View, Text as SpanText } from "@/lib/pdf-primitives";
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
import { renderPdf } from "@/lib/pdf/renderer";
import { fmtCents } from "./launch-packet";

export type IoChannel = "radio" | "newspaper" | "magazine";

export type IoSignatureStatus =
  | "draft"
  | "sent_to_rep"
  | "signed"
  | "proof_received"
  | "cancelled";

export const IO_SIGNATURE_FLOW: IoSignatureStatus[] = [
  "draft",
  "sent_to_rep",
  "signed",
  "proof_received",
];

/** One deliverable line on the IO. */
export interface IoDeliverable {
  /** e.g. "WXYZ-FM 30s drive spot", "Full-page 4C, Oct issue". */
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  /** Daypart / position / section notes. */
  notes?: string;
}

export interface IoRepContact {
  name: string;
  company: string;
  email?: string;
  phone?: string;
  rateCardRef?: string;
}

/** IAB/AAAA-templated IO terms. maximumSpendCents is THE binding term. */
export interface IoTerms {
  deliverables: IoDeliverable[];
  /** Sum of deliverable totals — must equal maximumSpendCents' schedule base. */
  scheduledCents: number;
  /** THE binding max: no invoice may exceed this without re-approval. */
  maximumSpendCents: number;
  currency: string;
  flightStart: string; // ISO date
  flightEnd: string; // ISO date
  /** Third-party ad server identity (IAB/AAAA required term). */
  thirdPartyAdServer: string;
  cancelTerms: string;
  paymentTerms: string;
  /** Publisher must notify within 2 business days if inventory is unavailable. */
  inventoryUnavailableNotice: string;
  notes?: string;
}

export interface IoBriefInput {
  name: string;
  channel: IoChannel;
  inventory: {
    name: string;
    market: string;
    callSign?: string;
    daypartMix?: string;
    placement?: string;
  }[];
  terms: Omit<IoTerms, "scheduledCents" | "maximumSpendCents"> & {
    maximumSpendCents: number;
  };
  repContact?: IoRepContact;
  creativeIds?: string[];
  creativeHashes?: string[];
  /** Per-publication/station promo codes (attribution track). */
  promoCodes?: { channelRef: string; code: string }[];
}

/**
 * Build validated IO terms. The scheduled total may not exceed the
 * maximum — the IO's "maximum amount to be spent" is the controlling cap
 * and is printed verbatim on the brief (never silent).
 */
export function buildIoTerms(input: IoBriefInput["terms"]): IoTerms {
  if (input.deliverables.length === 0) throw new Error("Add at least one deliverable.");
  if (!Number.isInteger(input.maximumSpendCents) || input.maximumSpendCents <= 0) {
    throw new Error("maximumSpendCents must be a positive integer — the IO always states a maximum.");
  }
  const scheduledCents = input.deliverables.reduce((a, d) => {
    if (d.totalCents !== d.quantity * d.unitPriceCents) {
      throw new Error(`Deliverable "${d.description}" total does not equal quantity × unit price.`);
    }
    return a + d.totalCents;
  }, 0);
  if (scheduledCents > input.maximumSpendCents) {
    throw new Error(
      `Scheduled total ${fmtCents(scheduledCents)} exceeds the maximum amount to be spent ${fmtCents(input.maximumSpendCents)} — lower the schedule or raise the maximum (re-approval required).`,
    );
  }
  if (new Date(input.flightEnd) < new Date(input.flightStart)) {
    throw new Error("flightEnd must be on or after flightStart.");
  }
  if (!input.thirdPartyAdServer.trim()) {
    throw new Error("thirdPartyAdServer is required (IAB/AAAA template term).");
  }
  return { ...input, scheduledCents };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export function ioBriefStorageDir(): string {
  const override = (process.env.IO_BRIEF_STORAGE_DIR ?? "").trim();
  if (override) return override;
  return path.join(process.cwd(), ".data", "io-briefs");
}

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
      <SpanText style={{ fontSize: 10, color: "#71717a", width: 170 }}>{label}</SpanText>
      <SpanText style={{ fontSize: 10, color: "#18181b", flex: 1 }}>{value}</SpanText>
    </View>
  );
}

const CHANNEL_LABEL: Record<IoChannel, string> = {
  radio: "Broadcast Radio",
  newspaper: "Newspaper Print",
  magazine: "Magazine (planning only)",
};

export interface IoBriefDocInput {
  name: string;
  channel: IoChannel;
  terms: IoTerms;
  inventory: IoBriefInput["inventory"];
  repContact?: IoRepContact;
  creativeIds: string[];
  creativeHashes: string[];
  promoCodes: { channelRef: string; code: string }[];
  signatureStatus: IoSignatureStatus;
  generatedAt: string;
  workspaceName: string;
  generatedBy: string | null;
}

export function buildIoBriefDocument(d: IoBriefDocInput): ReactElement {
  const t = d.terms;
  return (
    <Document title={`Insertion Order Brief — ${d.name}`}>
      <Page>
        <PdfcnThemeProvider theme={professionalTheme}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            <View style={{ flex: 1 }}>
              <PdfHeading level={2} noMargin>
                Insertion Order Brief
              </PdfHeading>
              <SpanText style={{ fontSize: 10, color: "#71717a" }}>
                {d.name} · {CHANNEL_LABEL[d.channel]} · {d.workspaceName} · {d.generatedAt}
              </SpanText>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <SpanText style={{ fontSize: 10, fontWeight: 700, color: "#4c1d95" }}>
                MAXIMUM {fmtCents(t.maximumSpendCents, t.currency)}
              </SpanText>
              <SpanText style={{ fontSize: 9, color: "#71717a" }}>
                IAB/AAAA template · rep executes the signature
              </SpanText>
            </View>
          </View>
          <PdfDivider />

          <View style={{ marginTop: 10, marginBottom: 10 }}>
            <SectionTitle>IO terms (binding)</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <Labeled label="Channel" value={CHANNEL_LABEL[d.channel]} />
              <Labeled label="Flight" value={`${t.flightStart} -> ${t.flightEnd}`} />
              <Labeled
                label="Maximum amount to be spent"
                value={fmtCents(t.maximumSpendCents, t.currency)}
              />
              <Labeled label="Scheduled total" value={fmtCents(t.scheduledCents, t.currency)} />
              <Labeled label="Third-party ad server" value={t.thirdPartyAdServer} />
              <Labeled label="Cancel terms" value={t.cancelTerms} />
              <Labeled label="Payment terms" value={t.paymentTerms} />
              <Labeled label="Inventory unavailable" value={t.inventoryUnavailableNotice} />
              {t.notes ? <Labeled label="Notes" value={t.notes} /> : null}
            </View>
          </View>

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Deliverables &amp; prices</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <PdfTable variant="line" zebraStripe>
                <TableHeader>
                  <TableRow header>
                    <TableCell header>Deliverable</TableCell>
                    <TableCell header align="right">
                      Qty
                    </TableCell>
                    <TableCell header align="right">
                      Unit
                    </TableCell>
                    <TableCell header align="right">
                      Total
                    </TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.deliverables.map((dl, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        {dl.description}
                        {dl.notes ? ` — ${dl.notes}` : ""}
                      </TableCell>
                      <TableCell align="right">{dl.quantity}</TableCell>
                      <TableCell align="right">{fmtCents(dl.unitPriceCents, t.currency)}</TableCell>
                      <TableCell align="right">{fmtCents(dl.totalCents, t.currency)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell>Scheduled total</TableCell>
                    <TableCell align="right">—</TableCell>
                    <TableCell align="right">—</TableCell>
                    <TableCell align="right">{fmtCents(t.scheduledCents, t.currency)}</TableCell>
                  </TableRow>
                </TableBody>
              </PdfTable>
            </View>
            <PdfText variant="xs" color="#71717a">
              Any change to deliverables, prices, or dates requires both-party written
              confirmation (IAB/AAAA) — a changed IO re-enters approval.
            </PdfText>
          </View>

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Station / publication selection</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <PdfTable variant="line" zebraStripe>
                <TableHeader>
                  <TableRow header>
                    <TableCell header>Station / publication</TableCell>
                    <TableCell header>Market</TableCell>
                    <TableCell header>Daypart / position</TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.inventory.map((inv, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        {inv.name}
                        {inv.callSign ? ` (${inv.callSign})` : ""}
                      </TableCell>
                      <TableCell>{inv.market}</TableCell>
                      <TableCell>{inv.daypartMix ?? inv.placement ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </PdfTable>
            </View>
          </View>

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Rep contact &amp; signature</SectionTitle>
            <View style={{ marginTop: 6 }}>
              {d.repContact ? (
                <>
                  <Labeled label="Rep" value={`${d.repContact.name} — ${d.repContact.company}`} />
                  {d.repContact.email ? <Labeled label="Email" value={d.repContact.email} /> : null}
                  {d.repContact.phone ? <Labeled label="Phone" value={d.repContact.phone} /> : null}
                  {d.repContact.rateCardRef ? (
                    <Labeled label="Rate card" value={d.repContact.rateCardRef} />
                  ) : null}
                </>
              ) : (
                <PdfText variant="xs" color="#71717a">
                  No rep assigned yet — attach the sales-rep contact before sending.
                </PdfText>
              )}
              <Labeled
                label="Signature status"
                value={d.signatureStatus.replace(/_/g, " ").toUpperCase()}
              />
            </View>
            <PdfText variant="xs" color="#71717a">
              The REP keeps the signature — Marketr plans and briefs. Capture the signed IO and
              proof-of-run in the signature tracker.
            </PdfText>
          </View>

          {d.channel === "magazine" ? (
            <View style={{ marginBottom: 10 }}>
              <PdfText variant="xs" color="#71717a">
                Magazines are planning-only in v1: 6–8 week lead times, materials deadlines ~6
                weeks pre-issue, heaviest rep dependence — this brief is a planning artifact, not
                an executable order.
              </PdfText>
            </View>
          ) : null}

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Creative &amp; tracking</SectionTitle>
            <View style={{ marginTop: 6 }}>
              {d.creativeIds.map((id, i) => (
                <Labeled
                  key={i}
                  label={`Creative ${i + 1}`}
                  value={`${id} — sha256 ${d.creativeHashes[i] ? d.creativeHashes[i].slice(0, 24) + "…" : "MISSING"}`}
                />
              ))}
              {d.promoCodes.length > 0 ? (
                <View style={{ marginTop: 6 }}>
                  <PdfTable variant="line" zebraStripe>
                    <TableHeader>
                      <TableRow header>
                        <TableCell header>Station / publication</TableCell>
                        <TableCell header>Promo code</TableCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.promoCodes.map((p, i) => (
                        <TableRow key={i}>
                          <TableCell>{p.channelRef}</TableCell>
                          <TableCell>{p.code}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </PdfTable>
                </View>
              ) : (
                <PdfText variant="xs" color="#71717a">
                  Assign unique promo codes per station/publication via the attribution track
                  (the classic and still recommended method for radio/print).
                </PdfText>
              )}
            </View>
          </View>

          <View style={{ marginTop: 16 }}>
            <PdfDivider />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
              <SpanText style={{ fontSize: 9, color: "#71717a" }}>
                Generated {d.generatedAt} · {d.workspaceName} · Marketr IO-brief concierge
              </SpanText>
              <PageNumber format="Page {page} of {total}" align="right" />
            </View>
          </View>
        </PdfcnThemeProvider>
      </Page>
    </Document>
  );
}

export interface IoBriefRecord {
  id: string;
  workspaceId: string;
}

export async function generateIoBriefPdf(opts: {
  brief: IoBriefRecord;
  input: IoBriefInput;
  terms: IoTerms;
  signatureStatus: IoSignatureStatus;
  workspaceName: string;
  generatedBy: string | null;
}): Promise<{ pdfBytes: Buffer; pdfPath: string; pdfUrl: string; briefSha256: string }> {
  const element = buildIoBriefDocument({
    name: opts.input.name,
    channel: opts.input.channel,
    terms: opts.terms,
    inventory: opts.input.inventory,
    repContact: opts.input.repContact,
    creativeIds: opts.input.creativeIds ?? [],
    creativeHashes: opts.input.creativeHashes ?? [],
    promoCodes: opts.input.promoCodes ?? [],
    signatureStatus: opts.signatureStatus,
    generatedAt: new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    workspaceName: opts.workspaceName,
    generatedBy: opts.generatedBy,
  });
  const pdf = await renderPdf(element);
  const briefSha256 = createHash("sha256").update(pdf).digest("hex");
  const dir = ioBriefStorageDir();
  await fs.mkdir(dir, { recursive: true });
  const pdfPath = path.join(dir, `${opts.brief.id}.pdf`);
  await fs.writeFile(pdfPath, pdf);
  const pdfUrl = `/api/media/io-briefs/${opts.brief.id}/pdf`;
  return { pdfBytes: Buffer.from(pdf), pdfPath, pdfUrl, briefSha256 };
}
