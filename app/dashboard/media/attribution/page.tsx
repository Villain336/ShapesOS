// Marketr — /dashboard/media/attribution: offline attribution command surface.
//
// Per-placement scans/calls/redemptions, branded-search lift with holdouts,
// and the report card WITH the printed honesty caveats (non-negotiable).
// Server-rendered from lib/media (fake-mode store); the lift panel computes
// against the fake-data provider default.

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getOrCreateWorkspace } from "@/lib/session";
import { getMediaStore } from "@/lib/media/store";
import { MarketrLinkEngine } from "@/lib/media/links";
import { createPromoService, promoRollup } from "@/lib/media/promo";
import { createCallRailService, FakeCallRailProvider } from "@/lib/media/callrail";
import {
  FakeLiftProvider,
  computeLift,
  computeDirectTrafficLift,
  computeGbpLift,
} from "@/lib/media/lift";
import { FakePlatformSpendFeed, reconcileBuy } from "@/lib/media/reconciliation";
import { buildReportCard, ATTRIBUTION_CAVEATS } from "@/lib/media/report";

export const metadata = { title: "Offline Attribution — Marketr" };
export const dynamic = "force-dynamic";

type Params = {
  buyId?: string;
  brandQuery?: string;
  baselineStart?: string;
  baselineEnd?: string;
  flightStart?: string;
  flightEnd?: string;
  boardMetros?: string;
  holdoutMetros?: string;
};

export default async function MediaAttributionPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const sp = await searchParams;
  const workspace = await getOrCreateWorkspace(session.user.id, session.user.email);
  const ws = workspace.id;
  const store = getMediaStore();
  const buyId = (sp.buyId ?? "").trim() || null;

  const engine = new MarketrLinkEngine(store);
  const promoSvc = createPromoService(store);
  const callSvc = createCallRailService(store, new FakeCallRailProvider());

  const rollup = buyId ? await engine.rollup(ws, buyId) : null;
  const promos = buyId ? await promoSvc.list(ws, buyId) : [];
  const promoSum = promoRollup(promos);
  const numbers = buyId ? await store.listCallNumbers(ws, buyId) : [];
  const callStats = await callSvc.pollCallStats(ws, buyId ?? undefined);

  const liftReady =
    buyId && sp.brandQuery && sp.baselineStart && sp.baselineEnd && sp.flightStart && sp.flightEnd && sp.boardMetros;
  let lift = null;
  let direct = null;
  let gbp = null;
  if (liftReady) {
    const provider = new FakeLiftProvider();
    const query = {
      brandQuery: sp.brandQuery!,
      baselineStart: sp.baselineStart!,
      baselineEnd: sp.baselineEnd!,
      flightStart: sp.flightStart!,
      flightEnd: sp.flightEnd!,
      boardMetros: sp.boardMetros!.split(",").map((s) => s.trim()).filter(Boolean),
      holdoutMetros: (sp.holdoutMetros ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    };
    [lift, direct, gbp] = await Promise.all([
      computeLift(provider, query),
      computeDirectTrafficLift(provider, query),
      computeGbpLift(provider, query),
    ]);
  }

  const recon = buyId
    ? await reconcileBuy(store, new FakePlatformSpendFeed(), ws, buyId)
    : null;

  const card =
    buyId && rollup && lift && direct && gbp && recon
      ? buildReportCard({
          buyId,
          buyLabel: `Buy ${buyId}`,
          flightStart: sp.flightStart!,
          flightEnd: sp.flightEnd!,
          links: rollup,
          promo: promoSum,
          calls: callStats,
          lift,
          direct,
          gbp,
          recon,
        })
      : null;

  const inputCls = "border rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900";
  const thCls = "text-left text-xs uppercase tracking-wide px-3 py-2 text-neutral-500";
  const tdCls = "px-3 py-2 text-sm border-t";

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold">Offline attribution</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Per-placement QR/pURL scans, promo redemptions, tracked calls, and branded-search lift.
        Directional indicators — never causal claims.
      </p>

      <form method="GET" className="mt-4 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          Buy ID{" "}
          <input name="buyId" defaultValue={buyId ?? ""} placeholder="buy_…" className={inputCls} />
        </label>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white" type="submit">
          Load
        </button>
      </form>

      {!buyId && (
        <p className="mt-6 text-sm text-neutral-500">
          Enter a buy ID to load its attribution. Links, promo codes and call numbers are created
          at buy time (API: <code>/api/media/links</code>, <code>/api/media/promo-codes</code>).
        </p>
      )}

      {buyId && rollup && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Placements — {rollup.totalScans} scans</h2>
          <table className="mt-2 w-full">
            <thead>
              <tr><th className={thCls}>Placement</th><th className={thCls}>Slug</th><th className={thCls}>Scans</th></tr>
            </thead>
            <tbody>
              {rollup.byPlacement.map((p) => (
                <tr key={p.slug}>
                  <td className={tdCls}>{p.placementRef}</td>
                  <td className={tdCls}><code>/{p.slug}</code></td>
                  <td className={tdCls}>{p.scans}</td>
                </tr>
              ))}
              {rollup.byPlacement.length === 0 && (
                <tr><td className={tdCls} colSpan={3}>No tracked placements yet.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {buyId && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Promo codes — {promoSum.totalRedemptions} redemptions</h2>
          <table className="mt-2 w-full">
            <thead>
              <tr><th className={thCls}>Channel</th><th className={thCls}>Code</th><th className={thCls}>Redemptions</th></tr>
            </thead>
            <tbody>
              {promoSum.byChannel.map((c) => (
                <tr key={c.code}>
                  <td className={tdCls}>{c.channelRef}</td>
                  <td className={tdCls}><code>{c.code}</code></td>
                  <td className={tdCls}>{c.redemptions}</td>
                </tr>
              ))}
              {promoSum.byChannel.length === 0 && (
                <tr><td className={tdCls} colSpan={3}>No promo codes yet.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {buyId && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">
            Tracked calls — {callStats.calls} calls
            {callStats.costPerCallCents !== null &&
              ` · ${"$" + (callStats.costPerCallCents / 100).toFixed(2)}/call (${callStats.basis})`}
          </h2>
          <table className="mt-2 w-full">
            <thead>
              <tr><th className={thCls}>Station</th><th className={thCls}>Number</th><th className={thCls}>Calls</th><th className={thCls}>Talk time</th></tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id}>
                  <td className={tdCls}>{n.stationRef}</td>
                  <td className={tdCls}><code>{n.numberE164}</code></td>
                  <td className={tdCls}>{n.callsCount}</td>
                  <td className={tdCls}>{n.totalDurationSec}s</td>
                </tr>
              ))}
              {numbers.length === 0 && (
                <tr><td className={tdCls} colSpan={4}>No tracking numbers yet (CallRail fake provider).</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {buyId && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Branded-search lift</h2>
          <form method="GET" className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="buyId" value={buyId} />
            {(
              [
                ["brandQuery", "Brand query", sp.brandQuery],
                ["baselineStart", "Baseline start", sp.baselineStart],
                ["baselineEnd", "Baseline end", sp.baselineEnd],
                ["flightStart", "Flight start", sp.flightStart],
                ["flightEnd", "Flight end", sp.flightEnd],
                ["boardMetros", "Board metros (comma)", sp.boardMetros],
                ["holdoutMetros", "Holdout metros (comma)", sp.holdoutMetros],
              ] as const
            ).map(([name, label, val]) => (
              <label key={name} className="text-sm">
                {label}{" "}
                <input name={name} defaultValue={val ?? ""} placeholder={name === "brandQuery" ? "acme plumbing" : name.includes("Start") || name.includes("End") ? "2026-09-01" : "raleigh"} className={inputCls} />
              </label>
            ))}
            <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white" type="submit">
              Compute lift
            </button>
          </form>

          {lift && (
            <div className="mt-4 rounded border p-4">
              <p className="text-sm font-medium">{lift.verdict}</p>
              <table className="mt-2 w-full">
                <thead>
                  <tr><th className={thCls}>Metro</th><th className={thCls}>Kind</th><th className={thCls}>Baseline/day</th><th className={thCls}>Flight/day</th><th className={thCls}>Lift</th></tr>
                </thead>
                <tbody>
                  {lift.metros.map((m) => (
                    <tr key={m.metro}>
                      <td className={tdCls}>{m.metro}</td>
                      <td className={tdCls}>{m.kind}</td>
                      <td className={tdCls}>{m.baselineDaily}</td>
                      <td className={tdCls}>{m.flightDaily}</td>
                      <td className={tdCls}>{m.liftPct !== null ? `${m.liftPct >= 0 ? "+" : ""}${m.liftPct}%` : "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-sm text-neutral-500">
                Device split (board metros): mobile{" "}
                {lift.devices.find((d) => d.device === "mobile")?.liftPct}% · desktop{" "}
                {lift.devices.find((d) => d.device === "desktop")?.liftPct}%.
                {direct && ` Direct sessions ${direct.liftPct !== null ? `${direct.liftPct >= 0 ? "+" : ""}${direct.liftPct}%` : "n/a"}.`}
                {gbp && ` GBP direction requests ${gbp.liftPct.directionRequests !== null ? `${gbp.liftPct.directionRequests >= 0 ? "+" : ""}${gbp.liftPct.directionRequests}%` : "n/a"}.`}
              </p>
            </div>
          )}
        </section>
      )}

      {card && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Report card</h2>
          {card.sections.map((s) => (
            <div key={s.title} className="mt-3">
              <h3 className="font-medium">{s.title}</h3>
              <ul className="list-disc pl-5 text-sm">
                {s.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ))}
          <div className="mt-4 rounded border-2 border-amber-600 bg-amber-50 p-4 dark:bg-amber-950">
            <h3 className="font-semibold">Honest caveats — read before acting on this card</h3>
            <ol className="list-decimal pl-5 text-sm">
              {ATTRIBUTION_CAVEATS.map((c, i) => (
                <li key={i} className="mt-1">{c}</li>
              ))}
            </ol>
            <p className="mt-2 text-sm italic">Directional indicators, never causal claims.</p>
          </div>
        </section>
      )}
    </main>
  );
}
