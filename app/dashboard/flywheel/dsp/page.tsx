// Marketr — DSP readiness (Phase 7 F5).
// Adapter list with seat status, tripwire band, fee-schedule versions, and the
// margin ledger with its four distinct lines. Read-only preview until the
// coordinator merges prisma/fragments/phase7-dsp.prisma; rendered from the
// same lib services the API routes use (fixtures below).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Badge } from "@/components/vault/shadcn/badge";
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
import { ShieldCheck, PlugZap, Receipt, Scale, AlertTriangle, CheckCircle2 } from "lucide-react";

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
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">DSP readiness</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
            Seat-agnostic programmatic rails — adapters for TTD, DV360, Amazon, and Basis. No
            seat ships in v1: every adapter fails closed until your agency connects its own
            seat. Preview data below; live tables land when the Phase 7 schema merges.
          </p>
        </div>
        <Badge className="shrink-0">Preview</Badge>
      </div>

      {/* Zero custody */}
      <section className="flex gap-3 rounded-xl border border-stone-200 bg-white p-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-stone-700" />
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Zero custody — structural</h2>
          <p className="mt-1 text-[13px] text-stone-600">{ZERO_CUSTODY_COPY}</p>
          <p className="mt-1 text-[13px] text-stone-600">
            Seat connection requires a vault reference only — Marketr never accepts raw seat
            credentials, and no field anywhere in this track can hold a client payment
            instrument.
          </p>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Adapters */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <PlugZap className="h-4 w-4 text-stone-500" />
            <h2 className="text-sm font-semibold text-stone-900">DSP adapters</h2>
          </div>
          <div className="divide-y divide-stone-100">
            {DSP_KINDS.map((dsp) => (
              <div key={dsp} className="flex items-center justify-between py-2.5">
                <div>
                  <p className="text-sm font-medium text-stone-900">{DSP_LABELS[dsp]}</p>
                  <p className="text-xs text-stone-500">Bring your own seat</p>
                </div>
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">
                  No seat
                </Badge>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-stone-500">
            Without a seat, pause, cap, and report calls fail closed with “connect your agency
            seat” guidance — they never pretend to act on a buy Marketr cannot reach.
          </p>
        </section>

        {/* Tripwire */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <Scale className="h-4 w-4 text-stone-500" />
            <h2 className="text-sm font-semibold text-stone-900">Volume tripwire</h2>
            <Badge variant="outline">$30K/mo fixture</Badge>
          </div>
          <p className="text-sm font-medium text-stone-900">{preview.tripwire.bandLabel}</p>
          <p className="mt-1 text-[13px] text-stone-600">{preview.tripwire.recommendation}</p>
          <div className="mt-3 space-y-1.5">
            {preview.tripwire.railCostings.map((r) => (
              <div key={r.rail} className="flex items-center justify-between text-xs text-stone-600">
                <span className="font-mono">{r.rail.toUpperCase()} · effective/mo</span>
                <span className="font-mono font-semibold text-stone-900">
                  {money(r.effectiveMonthlyCents)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 flex gap-1.5 text-xs text-stone-500">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            The report recommends; a human decides. Every figure pins the fee-schedule version it
            was computed against.
          </p>
        </section>

        {/* Fee schedules */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center gap-2">
            <Receipt className="h-4 w-4 text-stone-500" />
            <h2 className="text-sm font-semibold text-stone-900">Fee schedules</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-stone-500">
                  <th className="pb-2 pr-3 font-medium">DSP</th>
                  <th className="pb-2 pr-3 font-medium">Ver</th>
                  <th className="pb-2 pr-3 font-medium">Take</th>
                  <th className="pb-2 pr-3 font-medium">Tech</th>
                  <th className="pb-2 font-medium">Min/mo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {preview.schedules.map((s) => (
                  <tr key={s.id} className="font-mono text-stone-700">
                    <td className="py-2 pr-3">{s.dsp.toUpperCase()}</td>
                    <td className="py-2 pr-3">v{s.version}</td>
                    <td className="py-2 pr-3">{(s.feeLines.takeRateBps / 100).toFixed(1)}%</td>
                    <td className="py-2 pr-3">{(s.feeLines.techFeeBps / 100).toFixed(1)}%</td>
                    <td className="py-2">{money(s.feeLines.monthlyMinimumCents)}</td>
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
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-stone-500" />
              <h2 className="text-sm font-semibold text-stone-900">Margin ledger</h2>
            </div>
            {preview.reconciliation.balanced ? (
              <Badge className="flex items-center gap-1 border-emerald-200 bg-emerald-50 text-emerald-800">
                <CheckCircle2 className="h-3 w-3" /> Lines distinct
              </Badge>
            ) : (
              <Badge className="border-red-200 bg-red-50 text-red-800">Imbalanced</Badge>
            )}
          </div>
          {preview.ledgerRows.map((r) => (
            <div key={r.id} className="rounded-lg bg-stone-50 p-3">
              <p className="text-xs font-medium text-stone-500">
                {r.period} · {r.dsp.toUpperCase()} · fee schedule v{r.feeScheduleVersion}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                {(
                  [
                    ["Client billed", r.clientBilledCents],
                    ["Platform fees", r.platformFeesCents],
                    ["Passthrough (at cost)", r.passthroughCents],
                    ["Marketr margin", r.marketrMarginCents],
                  ] as const
                ).map(([label, cents]) => (
                  <div key={label} className="flex items-center justify-between">
                    <dt className="text-stone-500">{label}</dt>
                    <dd className="font-mono font-semibold text-stone-900">{money(cents)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <p className="mt-3 text-xs text-stone-500">
            Four distinct lines — never commingled. A row cannot post unless client-billed equals
            fees + passthrough + margin, so the margin can never hide inside another line.
          </p>
        </section>
      </div>
    </div>
  );
}
