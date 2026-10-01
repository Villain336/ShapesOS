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

  const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
  const thCls = "px-3 py-2 font-medium";
  const tdCls = "px-3 py-2";

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <h1 className="aos-heading">Offline attribution</h1>
      <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
        Per-placement QR/pURL scans, promo redemptions, tracked calls, and branded-search lift.
        Directional indicators — never causal claims.
      </p>

      <form method="GET" className="mt-4 flex flex-wrap items-end gap-2">
        <label className="text-[13px] text-muted">
          Buy ID{" "}
          <input name="buyId" defaultValue={buyId ?? ""} placeholder="buy_…" className={inputCls} />
        </label>
        <button className="inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40" type="submit">
          Load
        </button>
      </form>

      {!buyId && (
        <p className="mt-6 text-sm text-muted">
          Enter a buy ID to load its attribution. Links, promo codes and call numbers are created
          at buy time (API: <code>/api/media/links</code>, <code>/api/media/promo-codes</code>).
        </p>
      )}

      {buyId && rollup && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">Placements — {rollup.totalScans} scans</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-white"><table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted"><th className={thCls}>Placement</th><th className={thCls}>Slug</th><th className={thCls}>Scans</th></tr>
            </thead>
            <tbody>
              {rollup.byPlacement.map((p) => (
                <tr key={p.slug} className="border-b border-line last:border-0 hover:bg-hover-paper">
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
          </div>
        </section>
      )}

      {buyId && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">Promo codes — {promoSum.totalRedemptions} redemptions</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-white"><table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted"><th className={thCls}>Channel</th><th className={thCls}>Code</th><th className={thCls}>Redemptions</th></tr>
            </thead>
            <tbody>
              {promoSum.byChannel.map((c) => (
                <tr key={c.code} className="border-b border-line last:border-0 hover:bg-hover-paper">
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
          </div>
        </section>
      )}

      {buyId && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">
            Tracked calls — {callStats.calls} calls
            {callStats.costPerCallCents !== null &&
              ` · ${"$" + (callStats.costPerCallCents / 100).toFixed(2)}/call (${callStats.basis})`}
          </h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-white"><table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted"><th className={thCls}>Station</th><th className={thCls}>Number</th><th className={thCls}>Calls</th><th className={thCls}>Talk time</th></tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
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
          </div>
        </section>
      )}

      {buyId && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink">Branded-search lift</h2>
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
            <button className="inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40" type="submit">
              Compute lift
            </button>
          </form>

          {lift && (
            <div className="mt-4 rounded-xl border border-line bg-white p-4">
              <p className="text-sm font-medium">{lift.verdict}</p>
              <div className="mt-2 overflow-x-auto rounded-xl border border-line bg-white"><table className="w-full text-left text-[13px]">
                <thead>
                  <tr><th className={thCls}>Metro</th><th className={thCls}>Kind</th><th className={thCls}>Baseline/day</th><th className={thCls}>Flight/day</th><th className={thCls}>Lift</th></tr>
                </thead>
                <tbody>
                  {lift.metros.map((m) => (
                    <tr key={m.metro} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className={tdCls}>{m.metro}</td>
                      <td className={tdCls}>{m.kind}</td>
                      <td className={tdCls}>{m.baselineDaily}</td>
                      <td className={tdCls}>{m.flightDaily}</td>
                      <td className={tdCls}>{m.liftPct !== null ? `${m.liftPct >= 0 ? "+" : ""}${m.liftPct}%` : "n/a"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <p className="mt-2 text-sm text-muted">
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
          <h2 className="text-sm font-semibold text-ink">Report card</h2>
          {card.sections.map((s) => (
            <div key={s.title} className="mt-3 rounded-xl border border-line bg-white p-4">
              <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
              <ul className="list-disc pl-5 text-sm">
                {s.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ))}
          <div className="mt-4 rounded-lg bg-needs p-4 text-ink">
            <div className="flex items-start gap-2.5">
              <span
                className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:16px]"
                style={{ color: "inherit" }}
                aria-hidden
              />
              <div>
                <h3 className="font-semibold">Honest caveats — read before acting on this card</h3>
                <ol className="list-decimal pl-5 text-sm">
                  {ATTRIBUTION_CAVEATS.map((c, i) => (
                    <li key={i} className="mt-1">{c}</li>
                  ))}
                </ol>
                <p className="mt-2 text-sm italic">Directional indicators, never causal claims.</p>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
