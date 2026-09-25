// Marketr — Phase 5 B2: streaming-audio planner + generated brief.
//
// Concierge planning + self-serve execution in the CLIENT's own account:
// Spotify Ads Manager, Acast, AudioGo. This is the "executable leg" — the
// brief hands the client a budget and a spot plan; Marketr never touches
// the spend. Approval + binding + sweeper coverage are identical to B1
// (the safety track owns those); this module plans and briefs.
//
// Vendor minimums (docs/phase5-research.md §Track 3, Sep-2026 sources):
// - Spotify Ads Manager: min €15/day, €250 lifetime
// - Acast self-serve: from $250 (managed $10k–15k)
// - AudioGo: $250 minimum (reaches iHeart/SiriusXM/Cumulus/Audacy streaming)

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

export type AudioVendorName = "fake" | "spotify" | "acast" | "audiogo";

export interface AudioVendorMinimum {
  /** Minimum daily budget in cents (null = no daily minimum). */
  dailyMinCents: number | null;
  /** Minimum lifetime/campaign budget in cents. */
  lifetimeMinCents: number;
  currency: string;
  note: string;
}

export const AUDIO_VENDOR_MINIMUMS: Record<AudioVendorName, AudioVendorMinimum> = {
  spotify: {
    dailyMinCents: 1500,
    lifetimeMinCents: 25000,
    currency: "EUR",
    note: "Spotify Ads Manager (rebranded Ad Studio): min €15/day, €250 lifetime. US/UK/CA/AU/DE/FR/ES/IT.",
  },
  acast: {
    dailyMinCents: null,
    lifetimeMinCents: 25000,
    currency: "USD",
    note: "Acast self-serve from $250 (managed needs $10k–15k).",
  },
  audiogo: {
    dailyMinCents: null,
    lifetimeMinCents: 25000,
    currency: "USD",
    note: "AudioGo $250 minimum — reaches iHeart/SiriusXM/Cumulus/Audacy streaming inventory.",
  },
  fake: {
    dailyMinCents: null,
    lifetimeMinCents: 0,
    currency: "USD",
    note: "Fake vendor — planning figures only.",
  },
};

export interface AudioStation {
  name: string;
  /** streaming | podcast */
  type: "streaming" | "podcast";
  market: string;
  dayparts?: string[];
}

export interface AudioSpotMix {
  /** 15 | 30 | 60 */
  lengthSec: number;
  /** Spots per day across selected stations. */
  spotsPerDay: number;
  label: string;
}

export interface AudioPlanInput {
  vendor: AudioVendorName;
  name: string;
  stations: AudioStation[];
  spotMix: AudioSpotMix[];
  flightStart: string; // ISO date
  flightEnd: string; // ISO date
  /** Target daily media budget in cents (before minimums). */
  dailyBudgetCents: number;
  /** Creative production cost in cents (client cost, typical $500–2,000+). */
  productionCents?: number;
  /** Per-station promo code assignments (minted by the attribution track). */
  promoCodes?: { stationRef: string; code: string; vanityUrl: string }[];
  creativeIds?: string[];
  creativeHashes?: string[];
}

export interface AudioBudget {
  vendor: AudioVendorName;
  currency: string;
  flightDays: number;
  spotMix: AudioSpotMix[];
  dailyBudgetCents: number;
  lifetimeMediaCents: number;
  productionCents: number;
  totalCents: number;
  minimums: AudioVendorMinimum;
  minimumsMet: boolean;
  notes: string[];
}

function flightDays(start: string, end: string): number {
  const days = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1;
  if (!Number.isFinite(days) || days < 1) throw new Error("flightEnd must be on or after flightStart.");
  return days;
}

/**
 * Plan the audio buy: validates vendor minimums, computes the budget
 * envelope the approval binding will cap. The max_total_spend the approver
 * signs is `totalCents` — the media envelope, never exceeded.
 */
export function planAudioBuy(input: AudioPlanInput): AudioBudget {
  if (input.stations.length === 0) throw new Error("Select at least one station/podcast.");
  if (input.spotMix.length === 0) throw new Error("Add at least one spot mix entry.");
  for (const s of input.spotMix) {
    if (![15, 30, 60].includes(s.lengthSec)) throw new Error(`Unsupported spot length: ${s.lengthSec}s (15/30/60 only).`);
    if (s.spotsPerDay <= 0) throw new Error("spotsPerDay must be positive.");
  }
  const days = flightDays(input.flightStart, input.flightEnd);
  const minimums = AUDIO_VENDOR_MINIMUMS[input.vendor];

  const notes: string[] = [];
  let dailyBudgetCents = Math.round(input.dailyBudgetCents);
  if (minimums.dailyMinCents && dailyBudgetCents < minimums.dailyMinCents) {
    notes.push(
      `Daily budget raised to the ${input.vendor} minimum (${fmtCents(minimums.dailyMinCents, minimums.currency)}/day).`,
    );
    dailyBudgetCents = minimums.dailyMinCents;
  }
  let lifetimeMediaCents = dailyBudgetCents * days;
  if (lifetimeMediaCents < minimums.lifetimeMinCents) {
    notes.push(
      `Lifetime media raised to the ${input.vendor} minimum (${fmtCents(minimums.lifetimeMinCents, minimums.currency)}).`,
    );
    lifetimeMediaCents = minimums.lifetimeMinCents;
  }
  const productionCents = Math.round(input.productionCents ?? 0);
  if (productionCents > 0) {
    notes.push(
      `Production (${fmtCents(productionCents, minimums.currency)}) is a client cost, tracked in the buy's cost ledger — not media spend.`,
    );
  }
  notes.push(minimums.note);
  notes.push(
    "Execute in the client's own account (Spotify Ads Manager / Acast / AudioGo self-serve) — Marketr plans and briefs; it never holds or moves client money.",
  );

  return {
    vendor: input.vendor,
    currency: minimums.currency,
    flightDays: days,
    spotMix: input.spotMix,
    dailyBudgetCents,
    lifetimeMediaCents,
    productionCents,
    totalCents: lifetimeMediaCents + productionCents,
    minimums,
    minimumsMet: true,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Generated brief (PDF) — the handoff artifact for self-serve execution.
// ---------------------------------------------------------------------------

export function audioBriefStorageDir(): string {
  const override = (process.env.AUDIO_BRIEF_STORAGE_DIR ?? "").trim();
  if (override) return override;
  return path.join(process.cwd(), ".data", "audio-briefs");
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
      <SpanText style={{ fontSize: 10, color: "#71717a", width: 150 }}>{label}</SpanText>
      <SpanText style={{ fontSize: 10, color: "#18181b", flex: 1 }}>{value}</SpanText>
    </View>
  );
}

export interface AudioBriefDocInput {
  name: string;
  vendor: AudioVendorName;
  budget: AudioBudget;
  stations: AudioStation[];
  flightStart: string;
  flightEnd: string;
  promoCodes: { stationRef: string; code: string; vanityUrl: string }[];
  creativeIds: string[];
  creativeHashes: string[];
  generatedAt: string;
  workspaceName: string;
  generatedBy: string | null;
}

export function buildAudioBriefDocument(d: AudioBriefDocInput): ReactElement {
  const b = d.budget;
  return (
    <Document title={`Streaming Audio Brief — ${d.name}`}>
      <Page>
        <PdfcnThemeProvider theme={professionalTheme}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            <View style={{ flex: 1 }}>
              <PdfHeading level={2} noMargin>
                Streaming Audio Brief
              </PdfHeading>
              <SpanText style={{ fontSize: 10, color: "#71717a" }}>
                {d.name} · {d.vendor} · {d.workspaceName} · {d.generatedAt}
              </SpanText>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <SpanText style={{ fontSize: 10, fontWeight: 700, color: "#4c1d95" }}>
                MAX SPEND {fmtCents(b.totalCents, b.currency)}
              </SpanText>
              <SpanText style={{ fontSize: 9, color: "#71717a" }}>
                Self-serve execution in the client&apos;s account
              </SpanText>
            </View>
          </View>
          <PdfDivider />

          <View style={{ marginTop: 10, marginBottom: 10 }}>
            <SectionTitle>Flight &amp; budget</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <Labeled label="Vendor" value={d.vendor} />
              <Labeled label="Flight" value={`${d.flightStart} -> ${d.flightEnd} (${b.flightDays} days)`} />
              <Labeled label="Daily media budget" value={fmtCents(b.dailyBudgetCents, b.currency)} />
              <Labeled label="Lifetime media" value={fmtCents(b.lifetimeMediaCents, b.currency)} />
              <Labeled label="Production (client cost)" value={fmtCents(b.productionCents, b.currency)} />
              <Labeled label="Total envelope" value={fmtCents(b.totalCents, b.currency)} />
            </View>
            {b.notes.map((n, i) => (
              <PdfText key={i} variant="xs" color="#71717a">
                • {n}
              </PdfText>
            ))}
          </View>

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Stations / podcasts</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <PdfTable variant="line" zebraStripe>
                <TableHeader>
                  <TableRow header>
                    <TableCell header>Station / podcast</TableCell>
                    <TableCell header>Type</TableCell>
                    <TableCell header>Market</TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.stations.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell>{s.name}</TableCell>
                      <TableCell>{s.type}</TableCell>
                      <TableCell>{s.market}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </PdfTable>
            </View>
          </View>

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Spot mix</SectionTitle>
            <View style={{ marginTop: 6 }}>
              <PdfTable variant="line" zebraStripe>
                <TableHeader>
                  <TableRow header>
                    <TableCell header>Spot</TableCell>
                    <TableCell header align="right">
                      Length
                    </TableCell>
                    <TableCell header align="right">
                      Spots/day
                    </TableCell>
                    <TableCell header align="right">
                      Flight total
                    </TableCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {b.spotMix.map((s, i) => (
                    <TableRow key={i}>
                      <TableCell>{s.label}</TableCell>
                      <TableCell align="right">:{s.lengthSec}s</TableCell>
                      <TableCell align="right">{s.spotsPerDay}</TableCell>
                      <TableCell align="right">{s.spotsPerDay * b.flightDays}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </PdfTable>
            </View>
          </View>

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Per-station tracking</SectionTitle>
            <View style={{ marginTop: 6 }}>
              {d.promoCodes.length > 0 ? (
                <PdfTable variant="line" zebraStripe>
                  <TableHeader>
                    <TableRow header>
                      <TableCell header>Station</TableCell>
                      <TableCell header>Promo code</TableCell>
                      <TableCell header>Vanity URL</TableCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.promoCodes.map((p, i) => (
                      <TableRow key={i}>
                        <TableCell>{p.stationRef}</TableCell>
                        <TableCell>{p.code}</TableCell>
                        <TableCell>{p.vanityUrl}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </PdfTable>
              ) : (
                <PdfText variant="xs" color="#71717a">
                  No per-station codes assigned yet — mint unique promo codes + vanity URLs per
                  station via the attribution track before launch (audio&apos;s last-click layer is
                  the classic station/code method).
                </PdfText>
              )}
            </View>
            <PdfText variant="xs" color="#71717a">
              Spot scripts ship via the content engine → approval queue; production ($500–2,000+
              typical) is a client cost tracked in the buy&apos;s cost ledger.
            </PdfText>
          </View>

          <View style={{ marginBottom: 10 }}>
            <SectionTitle>Execution steps (client self-serve)</SectionTitle>
            <View style={{ marginTop: 6 }}>
              {[
                "Open the CLIENT's own account on the vendor (Spotify Ads Manager / Acast / AudioGo).",
                "Create the campaign with the flight dates, daily budget, and spot mix above — do not exceed the approved max spend.",
                "Upload the approved creative assets (re-hash at upload; mismatch = halt).",
                "Set the account/campaign spending limit at the approved envelope before launch.",
                "Attach the promo codes / vanity URLs per station as listed; confirm scan/call tracking resolves.",
                "Capture the order confirmation / invoice and upload it to the buy record for reconciliation.",
              ].map((step, i) => (
                <View key={i} style={{ flexDirection: "row", marginBottom: 4 }}>
                  <SpanText style={{ width: 22, fontSize: 10, fontWeight: 700 }}>{i + 1}.</SpanText>
                  <SpanText style={{ fontSize: 10, flex: 1, color: "#27272a" }}>{step}</SpanText>
                </View>
              ))}
            </View>
          </View>

          <View style={{ marginTop: 16 }}>
            <PdfDivider />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
              <SpanText style={{ fontSize: 9, color: "#71717a" }}>
                Generated {d.generatedAt} · {d.workspaceName} · Marketr streaming-audio concierge
              </SpanText>
              <PageNumber format="Page {page} of {total}" align="right" />
            </View>
          </View>
        </PdfcnThemeProvider>
      </Page>
    </Document>
  );
}

export interface AudioBriefRecord {
  id: string;
  workspaceId: string;
  name: string;
  vendor: string;
}

export async function generateAudioBriefPdf(opts: {
  buy: AudioBriefRecord;
  input: AudioPlanInput;
  budget: AudioBudget;
  workspaceName: string;
  generatedBy: string | null;
}): Promise<{ pdfBytes: Buffer; pdfPath: string; pdfUrl: string; briefSha256: string }> {
  const { buy, input, budget } = opts;
  const element = buildAudioBriefDocument({
    name: input.name,
    vendor: input.vendor,
    budget,
    stations: input.stations,
    flightStart: input.flightStart,
    flightEnd: input.flightEnd,
    promoCodes: input.promoCodes ?? [],
    creativeIds: input.creativeIds ?? [],
    creativeHashes: input.creativeHashes ?? [],
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
  const dir = audioBriefStorageDir();
  await fs.mkdir(dir, { recursive: true });
  const pdfPath = path.join(dir, `${buy.id}.pdf`);
  await fs.writeFile(pdfPath, pdf);
  const pdfUrl = `/api/media/audio/briefs/${buy.id}/pdf`;
  return { pdfBytes: Buffer.from(pdf), pdfPath, pdfUrl, briefSha256 };
}
