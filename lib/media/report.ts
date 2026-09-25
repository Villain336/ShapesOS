// Marketr — Phase 5 A1: offline report cards.
//
// NON-NEGOTIABLE (spec §A1): every offline report card carries the honesty
// caveats. They are printed on the card in every rendering (HTML + text),
// not hidden behind a tooltip. Directional indicators, never causal claims.

import type { CampaignRollup } from "./links";
import type { promoRollup } from "./promo";
import type { CallCostStats } from "./callrail";
import type { LiftResult, DirectTrafficLift, GbpLift } from "./lift";
import type { ReconciliationReport } from "./reconciliation";

export const ATTRIBUTION_CAVEATS: string[] = [
  "Scan rates are tiny and selection-biased — QR codes measure engaged responders, not reach. (Vendor blogs cite 1–5% of impressions scanned; treat even that as optimistic.)",
  "Attribution ≠ incrementality. Without a geo-holdout you cannot claim the OOH caused the response — and SMB budgets rarely buy enough geography for holdouts. Report directional indicators, never causal claims.",
  "Branded-search lift conflates all concurrent marketing. If anything else ran during the flight (paid search, social, PR), it is in this number too.",
  "AI search is breaking the click trail. 2026 analyses estimate AI-attributable sessions are under-counted ~3× and land as “direct” — branded-search and direct-traffic reads both skew low.",
  "QR scans are a thin slice of total response: 52–67% of OOH viewers take some smartphone action after seeing an ad, but only a fraction of them scan. Branded-search lift captures the rest of the response the QR misses.",
];

export interface ReportCardInput {
  buyId: string;
  buyLabel: string;
  flightStart: string;
  flightEnd: string;
  links: CampaignRollup;
  promo: ReturnType<typeof promoRollup>;
  calls: CallCostStats;
  lift: LiftResult;
  direct: DirectTrafficLift;
  gbp: GbpLift;
  recon: ReconciliationReport;
}

export interface ReportCard {
  buyId: string;
  buyLabel: string;
  generatedAt: string;
  sections: { title: string; lines: string[] }[];
  caveats: string[];
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function buildReportCard(input: ReportCardInput): ReportCard {
  const { links, promo, calls, lift, direct, gbp, recon } = input;

  const totalResponses = links.totalScans + promo.totalRedemptions + calls.calls;
  const spend = recon.ledger.spendCents;
  const costPerResponse =
    totalResponses > 0 ? fmtCents(Math.round(spend / totalResponses)) : "n/a";

  const sections = [
    {
      title: "Per-placement response (QR/pURL scans)",
      lines: [
        `${links.links} tracked placement(s), ${links.totalScans} scans recorded.`,
        ...links.byPlacement.slice(0, 10).map(
          (p) => `${p.placementRef} (${p.slug}): ${p.scans} scans`,
        ),
      ],
    },
    {
      title: "Promo / vanity code redemptions",
      lines: [
        `${promo.codes} code(s) issued, ${promo.totalRedemptions} redemptions.`,
        ...promo.byChannel.slice(0, 10).map(
          (c) => `${c.channelRef} (${c.code}): ${c.redemptions} redemptions`,
        ),
      ],
    },
    {
      title: "Tracked calls",
      lines: [
        `${calls.numbers} tracking number(s), ${calls.calls} call(s), ${calls.totalDurationSec}s total talk time.`,
        calls.costPerCallCents !== null
          ? `Documented-estimate cost per call: ${fmtCents(calls.costPerCallCents)} (basis: ${calls.basis}).`
          : "No calls yet — cost per call unavailable.",
      ],
    },
    {
      title: "Branded-search lift",
      lines: [
        lift.verdict,
        `Device split (board metros): mobile ${lift.devices.find((d) => d.device === "mobile")?.liftPct ?? "n/a"}% vs desktop ${lift.devices.find((d) => d.device === "desktop")?.liftPct ?? "n/a"}%.`,
      ],
    },
    {
      title: "Direct traffic + Google Business Profile",
      lines: [
        `Direct sessions: ${direct.liftPct !== null ? `${direct.liftPct >= 0 ? "+" : ""}${direct.liftPct}%` : "n/a"} vs baseline (${direct.baselineDaily.toFixed(1)} → ${direct.flightDaily.toFixed(1)}/day).`,
        `GBP direction requests ${gbp.liftPct.directionRequests !== null ? `${gbp.liftPct.directionRequests >= 0 ? "+" : ""}${gbp.liftPct.directionRequests}%` : "n/a"}, calls ${gbp.liftPct.calls !== null ? `${gbp.liftPct.calls >= 0 ? "+" : ""}${gbp.liftPct.calls}%` : "n/a"}, website clicks ${gbp.liftPct.websiteClicks !== null ? `${gbp.liftPct.websiteClicks >= 0 ? "+" : ""}${gbp.liftPct.websiteClicks}%` : "n/a"}.`,
      ],
    },
    {
      title: "Spend vs response (directional)",
      lines: [
        `Ledger realized spend: ${fmtCents(spend)}; platform actuals: ${fmtCents(recon.actual.totalCents)}; variance ${fmtCents(recon.varianceCents)}.`,
        `Directional cost per response (scans + redemptions + calls): ${costPerResponse} — a directional indicator, NOT a measured CAC.`,
        ...recon.flags.map((f) => `[${f.severity.toUpperCase()}] ${f.message}`),
      ],
    },
  ];

  return {
    buyId: input.buyId,
    buyLabel: input.buyLabel,
    generatedAt: new Date().toISOString(),
    sections,
    caveats: [...ATTRIBUTION_CAVEATS],
  };
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderReportCardHtml(card: ReportCard): string {
  const sections = card.sections
    .map(
      (s) => `<section style="margin:1.5rem 0">
  <h2 style="font-size:1.1rem;margin-bottom:.5rem">${escHtml(s.title)}</h2>
  <ul>${s.lines.map((l) => `<li>${escHtml(l)}</li>`).join("")}</ul>
</section>`,
    )
    .join("\n");
  const caveats = card.caveats
    .map((c) => `<li>${escHtml(c)}</li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Offline attribution report — ${escHtml(card.buyLabel)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:72ch;margin:2rem auto;padding:0 1rem;line-height:1.5">
<h1>Offline attribution report</h1>
<p><strong>${escHtml(card.buyLabel)}</strong> · generated ${escHtml(card.generatedAt)}</p>
${sections}
<section style="margin:2rem 0;padding:1rem;border:2px solid #b45309;background:#fffbeb">
<h2 style="font-size:1.1rem;margin-top:0">Honest caveats — read before acting on this card</h2>
<ol>${caveats}</ol>
<p><em>Directional indicators, never causal claims.</em></p>
</section>
</body></html>`;
}

export function renderReportCardText(card: ReportCard): string {
  const out: string[] = [
    `OFFLINE ATTRIBUTION REPORT — ${card.buyLabel}`,
    `Generated ${card.generatedAt}`,
    "",
  ];
  for (const s of card.sections) {
    out.push(`## ${s.title}`);
    for (const l of s.lines) out.push(`- ${l}`);
    out.push("");
  }
  out.push("## HONEST CAVEATS — READ BEFORE ACTING ON THIS CARD");
  card.caveats.forEach((c, i) => out.push(`${i + 1}. ${c}`));
  out.push("", "Directional indicators, never causal claims.");
  return out.join("\n");
}
