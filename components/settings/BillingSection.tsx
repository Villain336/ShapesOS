// Marketr — billing section for Settings → Usage (Phase C gap-fill, track G2).
// Top-up pack cards (Stripe Checkout), auto-overage opt-in toggle with
// plain-language pricing, and purchase history. Admin-only (server-gated
// by the page). Never displays keys, secrets, or card data — Stripe
// Checkout/Elements only, card data never touches Marketr.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import OverageBillingSection, { type OverageState } from "./OverageBillingSection";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const btnPrimary =
  "inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <Check size={14} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-ink" : "bg-disabled-fg"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[21px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

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

interface CatalogPlan {
  id: string;
  name: string;
  includedCredits: number;
}

interface PlanInfo {
  currentPlan: string;
  plans: CatalogPlan[];
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function BillingSection({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<StatusData | null>(null);
  const [planInfo, setPlanInfo] = useState<PlanInfo | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, pr] = await Promise.all([
        fetch(`/api/billing/status?${q}`),
        fetch(`/api/billing/plans?${q}`),
      ]);
      if (!r.ok) throw new Error("Failed to load billing status");
      setData(await r.json());
      if (pr.ok) setPlanInfo(await pr.json());
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

  const toggleOverage = async (enabled: boolean) => {
    if (!data) return;
    setToggling(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/billing/overage?${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, enabled }),
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
      <h2 className="text-lg font-semibold text-ink">Billing</h2>
      <p className="mt-1 text-sm text-muted">
        Buy credit top-ups and control what happens when you hit your spend cap. 1 credit = $0.01.
      </p>
      {/* Plan & subscription: wires the plan catalogue (lib/billing/plans.ts)
          into the usage drawer without duplicating the billing hub. */}
      {planInfo && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-4 py-3">
          <p className="text-sm">
            <span className="text-muted">Current plan:</span>{" "}
            <strong className="text-ink">
              {planInfo.plans.find((p) => p.id === planInfo.currentPlan)?.name ??
                (planInfo.currentPlan === "self_hosted" ? "Self-hosted" : planInfo.currentPlan === "trial" ? "Trial" : planInfo.currentPlan)}
            </strong>
            <span className="text-muted">
              {" · "}
              {(() => {
                const p = planInfo.plans.find((x) => x.id === planInfo.currentPlan);
                return p
                  ? `${p.includedCredits.toLocaleString()} credits / month included`
                  : "BYO keys — no included pool";
              })()}
            </span>
          </p>
          <Link
            href="/dashboard/billing"
            className="inline-flex items-center gap-1 text-sm font-medium text-ink hover:underline"
          >
            Plans &amp; subscription
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
      {notice && (
        <div className="mt-3">
          <Notice notice={notice} />
        </div>
      )}

      {loading || !data ? (
        <p className="mt-4 text-sm text-muted">{loading ? "Loading billing…" : "Billing unavailable."}</p>
      ) : !data.configured ? (
        <p className="mt-4 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
          Top-up purchases aren&rsquo;t enabled on this deployment yet — usage is still metered locally
          against your included credits. Contact your Marketr host to enable billing.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {/* Top-up packs */}
          <div>
            <h3 className="text-sm font-medium text-ink">Buy credits</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {data.packs.map((p) => (
                <div key={p.id} className="rounded-lg border border-line bg-paper p-4">
                  <p className="text-base font-semibold text-ink">{p.label}</p>
                  <p className="mt-1 text-sm text-muted">
                    {money(p.priceCents)} one-time · never expires for 12 months · raises your cap by{" "}
                    {p.credits.toLocaleString()} credits
                  </p>
                  <button
                    className={`${btnPrimary} mt-3`}
                    disabled={buying !== null}
                    onClick={() => buy(p.id)}
                  >
                    {buying === p.id ? "Redirecting to checkout…" : `Buy for ${money(p.priceCents)}`}
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              Secure checkout by Stripe. Card details never touch Marketr.
            </p>
          </div>

          {/* Auto-overage */}
          <div>
            <h3 className="text-sm font-medium text-ink">When you hit your spend cap</h3>
            <div className="mt-2 flex items-start justify-between gap-4 rounded-lg border border-line p-4">
              <div className="text-sm text-muted">
                <p>
                  <strong className="text-ink">Hard cap (default):</strong> usage stops at the
                  limit — nothing is ever charged beyond it.
                </p>
                <p className="mt-1">
                  <strong className="text-ink">Auto-overage (opt-in):</strong> usage continues
                  past the cap at <strong>{data.overageRate}</strong> per credit (about 20% above
                  face value). Overage usage is recorded in the ledger like normal usage; the
                  invoice is billed separately.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Status: {data.autoOverage ? "auto-overage ON" : "hard cap ON"} · changing this is
                  recorded in the audit log.
                </p>
              </div>
              <Switch
                checked={data.autoOverage}
                onChange={toggleOverage}
                disabled={toggling}
                label="Auto-overage: bill overage instead of blocking at the spend cap"
              />
            </div>
          </div>

          {/* Overage billing: card on file, accrued overage, invoices */}
          <OverageBillingSection workspaceId={workspaceId} overage={data.overage} onChanged={load} />

          {/* Purchase history */}
          <div>
            <h3 className="text-sm font-medium text-ink">Purchase history</h3>
            {data.purchases.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No top-up purchases yet.</p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 pr-3 font-medium">Date</th>
                    <th className="py-1 pr-3 font-medium">Credits</th>
                    <th className="py-1 pr-3 font-medium">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {data.purchases.map((p) => (
                    <tr key={p.sessionId} className="border-t border-line hover:bg-hover-paper">
                      <td className="py-1.5 pr-3 text-muted">
                        {new Date(p.appliedAt).toLocaleString()}
                      </td>
                      <td className="py-1.5 pr-3 text-ink">+{p.credits.toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-muted">{money(p.amountCents)}</td>
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
