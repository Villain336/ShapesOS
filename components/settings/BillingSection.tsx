// Marketr — billing section for Settings → Usage (Phase C gap-fill, track G2).
// Top-up pack cards (Stripe Checkout), auto-overage opt-in toggle with
// plain-language pricing, and purchase history. Admin-only (server-gated
// by the page). Never displays keys, secrets, or card data — Stripe
// Checkout/Elements only, card data never touches Marketr.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice, btnCls, cardCls, primaryBtnCls, type NoticeState } from "./ui";
import OverageBillingSection, { type OverageState } from "./OverageBillingSection";

interface Pack {
  id: string;
  priceCents: number;
  credits: number;
  label: string;
}

interface Purchase {
  sessionId: string;
  credits: number;
  amountCents: number;
  appliedAt: string;
  source: string;
}

interface StatusData {
  configured: boolean;
  autoOverage: boolean;
  overageRate: string;
  packs: Pack[];
  purchases: Purchase[];
  overage: OverageState;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function BillingSection({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<StatusData | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/billing/status?${q}`);
      if (!r.ok) throw new Error("Failed to load billing status");
      setData(await r.json());
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to load billing" });
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  // Surface Stripe's redirect results (?topup=… / ?setup=…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("topup");
    if (t === "success") {
      setNotice({ kind: "ok", message: "Payment received — your credits were added. It can take a few seconds to appear below." });
    } else if (t === "cancelled") {
      setNotice({ kind: "info", message: "Checkout was cancelled — no charge was made." });
    }
    const s = params.get("setup");
    if (s === "success") {
      setNotice({ kind: "ok", message: "Card saved — it will be charged automatically for monthly overage invoices." });
    } else if (s === "cancelled") {
      setNotice({ kind: "info", message: "Card setup was cancelled — no card was saved." });
    }
  }, []);

  const buy = async (packId: string) => {
    setBuying(packId);
    setNotice(null);
    try {
      const r = await fetch(`/api/billing/topup?${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, packId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed to start checkout");
      window.location.href = j.url;
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to start checkout" });
      setBuying(null);
    }
  };

  const toggleOverage = async () => {
    if (!data) return;
    setToggling(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/billing/overage?${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, enabled: !data.autoOverage }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed to update auto-overage");
      setData({ ...data, autoOverage: j.autoOverage });
      setNotice({
        kind: "ok",
        message: j.autoOverage
          ? "Auto-overage is ON — usage past your cap accrues at the overage rate instead of blocking."
          : "Auto-overage is OFF — the hard cap blocks usage at the limit.",
      });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to update auto-overage" });
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className={cardCls}>
      <h2 className="text-lg font-semibold">Billing</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Buy credit top-ups and control what happens when you hit your spend cap. 1 credit = $0.01.
      </p>
      {notice && (
        <div className="mt-3">
          <Notice notice={notice} />
        </div>
      )}

      {loading || !data ? (
        <p className="mt-4 text-sm text-zinc-500">{loading ? "Loading billing…" : "Billing unavailable."}</p>
      ) : !data.configured ? (
        <p className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
          Top-up purchases aren&rsquo;t enabled on this deployment yet — usage is still metered locally
          against your included credits. Contact your Marketr host to enable billing.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {/* Top-up packs */}
          <div>
            <h3 className="text-sm font-medium text-zinc-800">Buy credits</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {data.packs.map((p) => (
                <div key={p.id} className="rounded-lg border border-zinc-200 p-4">
                  <p className="text-base font-semibold">{p.label}</p>
                  <p className="mt-1 text-sm text-zinc-500">
                    {money(p.priceCents)} one-time · never expires for 12 months · raises your cap by{" "}
                    {p.credits.toLocaleString()} credits
                  </p>
                  <button
                    className={`${primaryBtnCls} mt-3`}
                    disabled={buying !== null}
                    onClick={() => buy(p.id)}
                  >
                    {buying === p.id ? "Redirecting to checkout…" : `Buy for ${money(p.priceCents)}`}
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Secure checkout by Stripe. Card details never touch Marketr.
            </p>
          </div>

          {/* Auto-overage */}
          <div>
            <h3 className="text-sm font-medium text-zinc-800">When you hit your spend cap</h3>
            <div className="mt-2 flex items-start justify-between gap-4 rounded-lg border border-zinc-200 p-4">
              <div className="text-sm text-zinc-600">
                <p>
                  <strong className="text-zinc-800">Hard cap (default):</strong> usage stops at the
                  limit — nothing is ever charged beyond it.
                </p>
                <p className="mt-1">
                  <strong className="text-zinc-800">Auto-overage (opt-in):</strong> usage continues
                  past the cap at <strong>{data.overageRate}</strong> per credit (about 20% above
                  face value). Overage usage is recorded in the ledger like normal usage; the
                  invoice is billed separately.
                </p>
              </div>
              <button className={btnCls} disabled={toggling} onClick={toggleOverage}>
                {toggling ? "Saving…" : data.autoOverage ? "Turn off auto-overage" : "Turn on auto-overage"}
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Status: {data.autoOverage ? "auto-overage ON" : "hard cap ON"} · changing this is
              recorded in the audit log.
            </p>
          </div>

          {/* Overage billing: card on file, accrued overage, invoices */}
          <OverageBillingSection workspaceId={workspaceId} overage={data.overage} onChanged={load} />

          {/* Purchase history */}
          <div>
            <h3 className="text-sm font-medium text-zinc-800">Purchase history</h3>
            {data.purchases.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">No top-up purchases yet.</p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500">
                    <th className="py-1 pr-3 font-medium">Date</th>
                    <th className="py-1 pr-3 font-medium">Credits</th>
                    <th className="py-1 pr-3 font-medium">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {data.purchases.map((p) => (
                    <tr key={p.sessionId} className="border-t border-zinc-100">
                      <td className="py-1.5 pr-3 text-zinc-600">
                        {new Date(p.appliedAt).toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-3">+{p.credits.toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-zinc-600">{money(p.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
