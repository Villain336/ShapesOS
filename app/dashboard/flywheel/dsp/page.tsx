// Marketr — DSP readiness (Phase 7 F5).
// Adapter list with seat status, tripwire band, fee-schedule versions, and the
// margin ledger with its four distinct lines. Read-only preview until the
// coordinator merges prisma/fragments/phase7-dsp.prisma; rendered from the
// same lib services the API routes use (fixtures below).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}

import {
  DSP_LABELS,
  DSP_KINDS,
  createMemoryFeeScheduleStore,
  seedPlaceholderSchedules,
  createMemoryMarginLedgerStore,
  postDerivedLedgerRow,
  reconcileLedgerRow,
  buildTripwireReport,
  feeMathsForTripwire,
  liveSchedulesFor,
  ZERO_CUSTODY_COPY,
  type TripwireReport,
} from "@/lib/flywheel/dsp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "DSP Readiness — Marketr",
  description: "DSP adapter seats, volume tripwire, fee schedules, and margin ledger.",
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

async function loadPreview() {
  const feeStore = createMemoryFeeScheduleStore();
  const ledgerStore = createMemoryMarginLedgerStore();
  const effectiveFrom = new Date("2026-01-01");
  await seedPlaceholderSchedules(feeStore, "preview", "system", effectiveFrom);
  const at = new Date("2026-09-01");
  const live = await liveSchedulesFor(feeStore, "preview", at);
  const spendCents = 30_000_00; // $30K/mo fixture → self-serve band
  const feeMaths = await feeMathsForTripwire(spendCents, live);
  const tripwire: TripwireReport = buildTripwireReport("preview", {
    aggregateMonthlySpendCents: spendCents,
    sustainedMonthsAbove250k: 0,
    feeMaths,
  });
  const { row } = await postDerivedLedgerRow(ledgerStore, live.find((s) => s.dsp === "ttd")!, {
    workspaceId: "preview",
    period: "2026-08",
    dspAdapterId: "adapter_ttd_preview",
    mediaSpendCents: 12_000_00,
    marketrMarginCents: 180_00,
    postedBy: "preview",
    note: "August TTD partner-routed fixture",
  });
  return {
    schedules: await feeStore.list("preview"),
    ledgerRows: await ledgerStore.list("preview"),
    reconciliation: reconcileLedgerRow(row),
    tripwire,
  };
}

export default async function DspPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const preview = await loadPreview();

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">DSP readiness</h1>
          <p className="mt-0.5 max-w-3xl text-[13px] text-stone-500">
            Seat-agnostic programmatic rails — adapters for TTD, DV360, Amazon, and Basis. No
            seat ships in v1: every adapter fails closed until your agency connects its own
            seat. Preview data below; live tables land when the Phase 7 schema merges.
          </p>
        </div>
        {chip("Preview", "border-stone-200 bg-stone-100 text-stone-600")}
      </header>

      {/* Zero custody — stone note */}
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
        <h2 className="text-sm font-semibold tracking-tight text-stone-900">Zero custody — structural</h2>
        <p className="mt-1 text-[13px] text-stone-600">{ZERO_CUSTODY_COPY}</p>
        <p className="mt-2 text-[13px] text-stone-600">
          Seat connection requires a vault reference only — Marketr never accepts raw seat
          credentials, and no field anywhere in this track can hold a client payment
          instrument.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Adapters */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="text-sm font-semibold tracking-tight text-stone-900">DSP adapters</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Adapter</th>
                  <th className="px-3 py-2 font-medium">Seat</th>
                </tr>
              </thead>
              <tbody>
                {DSP_KINDS.map((dsp) => (
                  <tr key={dsp} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2">
                      <span className="font-medium text-stone-900">{DSP_LABELS[dsp]}</span>
                      <span className="block text-[12px] text-stone-500">Bring your own seat</span>
                    </td>
                    <td className="px-3 py-2">
                      {chip("No seat", "border-amber-200 bg-amber-50 text-amber-700")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Without a seat, pause, cap, and report calls fail closed with “connect your agency
            seat” guidance — they never pretend to act on a buy Marketr cannot reach.
          </p>
        </section>

        {/* Tripwire */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-stone-900">Volume tripwire</h2>
            {chip("$30K/mo fixture", "border-stone-200 bg-stone-100 text-stone-600")}
          </div>
          <p className="mt-2 text-[13px] font-medium text-stone-900">{preview.tripwire.bandLabel}</p>
          <p className="mt-1 text-[13px] text-stone-600">{preview.tripwire.recommendation}</p>
          <div className="mt-2 overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Rail</th>
                  <th className="px-3 py-2 font-medium text-right">Effective / mo</th>
                </tr>
              </thead>
              <tbody>
                {preview.tripwire.railCostings.map((r) => (
                  <tr key={r.rail} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-mono text-stone-700">{r.rail.toUpperCase()}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-stone-900">
                      {money(r.effectiveMonthlyCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-stone-500">
            The report recommends; a human decides. Every figure pins the fee-schedule version it
            was computed against.
          </p>
        </section>

        {/* Fee schedules */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="text-sm font-semibold tracking-tight text-stone-900">Fee schedules</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">DSP</th>
                  <th className="px-3 py-2 font-medium">Ver</th>
                  <th className="px-3 py-2 font-medium">Take</th>
                  <th className="px-3 py-2 font-medium">Tech</th>
                  <th className="px-3 py-2 font-medium text-right">Min / mo</th>
                </tr>
              </thead>
              <tbody>
                {preview.schedules.map((s) => (
                  <tr key={s.id} className="border-b border-stone-100 font-mono text-stone-700 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2">{s.dsp.toUpperCase()}</td>
                    <td className="px-3 py-2">v{s.version}</td>
                    <td className="px-3 py-2">{(s.feeLines.takeRateBps / 100).toFixed(1)}%</td>
                    <td className="px-3 py-2">{(s.feeLines.techFeeBps / 100).toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right">{money(s.feeLines.monthlyMinimumCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Placeholder v1 — replace with your agency’s signed rate cards. Margin math always
            audits against the schedule live when the spend happened.
          </p>
        </section>

        {/* Margin ledger */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-stone-900">Margin ledger</h2>
            {chip(
              preview.reconciliation.balanced ? "Lines distinct" : "Imbalanced",
              preview.reconciliation.balanced ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
            )}
          </div>
          <div className="mt-2 overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Line</th>
                  <th className="px-3 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.ledgerRows.flatMap((r) => (
                  [
                    ["Client billed", r.clientBilledCents],
                    ["Platform fees", r.platformFeesCents],
                    ["Passthrough (at cost)", r.passthroughCents],
                    ["Marketr margin", r.marketrMarginCents],
                  ] as const
                ).map(([label, cents]) => (
                  <tr key={`${r.id}-${label}`} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 text-stone-700">
                      {label}
                      <span className="block text-[11px] text-stone-400">{r.period} · {r.dsp.toUpperCase()} · fee schedule v{r.feeScheduleVersion}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-stone-900">{money(cents)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Four distinct lines — never commingled. A row cannot post unless client-billed equals
            fees + passthrough + margin, so the margin can never hide inside another line.
          </p>
        </section>
      </div>
    </div>
  );
}
