// Marketr — billing hub (Phase 13 Wave A).
// Plans & pricing, current subscription, and Stripe Customer Portal entry —
// all admin-gated server-side by the page. Card data, keys, and Stripe
// Price ids never touch this UI: purchases happen on Stripe Checkout, and
// cancel/invoices/card updates happen on Stripe's Customer Portal.
// 503-safe: every action surfaces the API's plain-language "not enabled"
// message instead of crashing when Stripe keys are absent.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  CreditCard,
  ArrowRight,
} from "lucide-react";
import { Notice, type NoticeState } from "./ui";

interface PlanCard {
  id: string;
  name: string;
  tagline: string;
  priceDisplay: string;
  priceCents: number;
  includedCredits: number;
  features: string[];
  badge: string | null;
  purchasable: boolean;
}

interface PlansData {
  configured: boolean;
  currentPlan: string;
  plans: PlanCard[];
}

interface SubData {
  configured: boolean;
  plan: string;
  subscription: {
    planId: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  } | null;
  hasPaymentMethod: boolean;
}

const primaryBtnCls =
  "rounded-md bg-[var(--brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--brand-700)] disabled:cursor-not-allowed disabled:opacity-40";

const secondaryBtnCls =
  "rounded-md border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50";

function statusBadge(sub: SubData["subscription"]): { text: string; cls: string } {
  if (!sub) return { text: "No paid subscription", cls: "border-zinc-200 bg-zinc-100 text-zinc-600" };
  if (sub.cancelAtPeriodEnd)
    return { text: "Cancels at period end", cls: "border-amber-200 bg-amber-50 text-amber-800" };
  if (sub.status === "active" || sub.status === "trialing")
    return { text: sub.status === "trialing" ? "Trialing" : "Active", cls: "border-emerald-200 bg-emerald-50 text-emerald-800" };
  if (sub.status === "past_due" || sub.status === "incomplete")
    return { text: "Payment issue", cls: "border-red-200 bg-red-50 text-red-700" };
  return { text: sub.status, cls: "border-zinc-200 bg-zinc-100 text-zinc-600" };
}

export default function BillingHub({ workspaceId }: { workspaceId: string }) {
  const [plans, setPlans] = useState<PlansData | null>(null);
  const [sub, setSub] = useState<SubData | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pr, sr] = await Promise.all([
        fetch(`/api/billing/plans?${q}`),
        fetch(`/api/billing/subscription?${q}`),
      ]);
      if (!pr.ok) throw new Error("Failed to load plans");
      // A 503 from the subscription endpoint means Stripe isn't configured —
      // that's an honest no-key state, not a failure. Render the amber banner.
      let subJson: SubData;
      if (sr.status === 503) {
        subJson = { configured: false, plan: "free", subscription: null, hasPaymentMethod: false };
      } else {
        if (!sr.ok) throw new Error("Failed to load subscription");
        subJson = await sr.json();
      }
      setPlans(await pr.json());
      setSub(subJson);
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to load billing" });
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  // Surface Stripe Checkout's redirect results (?sub=…).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("sub");
    if (s === "success") {
      setNotice({
        kind: "ok",
        message:
          "Subscription confirmed — your plan is updating now. It can take a few seconds to appear below.",
      });
    } else if (s === "cancelled") {
      setNotice({ kind: "info", message: "Checkout was cancelled — no charge was made, your plan is unchanged." });
    }
  }, []);

  const choose = async (planId: string) => {
    setBuying(planId);
    setNotice(null);
    try {
      const r = await fetch(`/api/billing/subscription?${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, planId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed to start checkout");
      window.location.href = j.url;
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to start checkout" });
      setBuying(null);
    }
  };

  const openPortal = async () => {
    setOpeningPortal(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/billing/portal?${q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed to open the billing portal");
      window.location.href = j.url;
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to open the billing portal" });
    } finally {
      setOpeningPortal(false);
    }
  };

  const currentPlanName =
    plans?.plans.find((p) => p.id === plans.currentPlan)?.name ??
    (plans?.currentPlan === "self_hosted" ? "Self-hosted" : (plans?.currentPlan ?? "…"));

  const badge = statusBadge(sub?.subscription ?? null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Billing &amp; plans</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Your subscription, plans, and invoices. Payments run through Stripe — card details never
          touch Marketr.
        </p>
      </div>

      {notice && <Notice notice={notice} />}

      {/* Honest no-key state: nothing purchases, nothing crashes. */}
      {plans && !plans.configured && (
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <p className="text-sm text-amber-800">
            <strong>Billing isn&rsquo;t enabled on this deployment.</strong> The Stripe keys
            (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET) aren&rsquo;t set, so plan purchases,
            top-ups, and card management are disabled. Usage is still metered locally against your
            included credits — nothing here can charge you. To enable billing, the host adds the
            keys to the environment (see .env.example).
          </p>
        </div>
      )}

      {loading || !plans || !sub ? (
        <p className="text-sm text-stone-500">{loading ? "Loading billing…" : "Billing unavailable."}</p>
      ) : (
        <>
          {/* Current subscription */}
          <section>
            <h2 className="text-sm font-semibold text-stone-900">Current subscription</h2>
            <div className="mt-2 rounded-xl border border-zinc-200 bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-stone-400" />
                  <div>
                    <p className="text-base font-semibold text-stone-900">{currentPlanName}</p>
                    <p className="text-[13px] text-stone-500">
                      {sub.subscription?.currentPeriodEnd
                        ? `Renews ${new Date(sub.subscription.currentPeriodEnd).toLocaleDateString()}`
                        : sub.subscription
                          ? "Period end unknown — check the billing portal"
                          : "No paid subscription — pick a plan below to upgrade"}
                    </p>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                    {badge.text}
                  </span>
                </div>
                {sub.subscription && (
                  <button className={secondaryBtnCls} disabled={openingPortal} onClick={openPortal}>
                    {openingPortal ? "Opening…" : "Manage subscription & invoices"}
                  </button>
                )}
              </div>
              <p className="mt-3 text-xs text-stone-500">
                Cancellation, invoices, receipts, and card updates happen on Stripe&rsquo;s billing
                portal — Marketr never stores your card.
              </p>
            </div>
          </section>

          {/* Plans / pricing — driven by the admin-configurable catalogue */}
          <section>
            <h2 className="text-sm font-semibold text-stone-900">Plans</h2>
            <div className="mt-2 grid gap-4 md:grid-cols-3">
              {plans.plans.map((p) => {
                const isCurrent = p.id === plans.currentPlan;
                const actionText = !plans.configured
                  ? "Billing not enabled"
                  : !p.purchasable
                    ? "Not purchasable yet"
                    : isCurrent
                      ? "Current plan"
                      : "Choose plan";
                return (
                  <div
                    key={p.id}
                    className={`relative flex flex-col rounded-xl border bg-white p-5 ${
                      isCurrent ? "border-[var(--brand-600)] ring-1 ring-[var(--brand-600)]" : "border-zinc-200"
                    }`}
                  >
                    {p.badge && (
                      <span className="absolute -top-2.5 left-4 rounded-full bg-[var(--brand-600)] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                        {p.badge}
                      </span>
                    )}
                    <p className="text-lg font-semibold text-stone-900">{p.name}</p>
                    <p className="mt-0.5 text-[13px] text-stone-500">{p.tagline}</p>
                    <p className="mt-3">
                      <span className="text-3xl font-bold tracking-tight text-stone-900">{p.priceDisplay}</span>
                      <span className="text-sm text-stone-500"> / month</span>
                    </p>
                    <p className="mt-1 text-[13px] text-stone-600">
                      {p.includedCredits.toLocaleString()} included credits / month
                    </p>
                    <ul className="mt-4 flex flex-1 flex-col gap-1.5">
                      {p.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 text-[13px] text-stone-600">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--brand-600)]" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <button
                      className={`${isCurrent || !plans.configured || !p.purchasable ? secondaryBtnCls : primaryBtnCls} mt-5 w-full`}
                      disabled={isCurrent || !plans.configured || !p.purchasable || buying !== null}
                      onClick={() => choose(p.id)}
                    >
                      {buying === p.id ? "Redirecting to checkout…" : actionText}
                    </button>
                    {!plans.configured ? (
                      <p className="mt-2 text-xs text-stone-500">
                        Plan purchases need Stripe keys on this deployment.
                      </p>
                    ) : (
                      !p.purchasable && (
                        <p className="mt-2 text-xs text-stone-500">
                          This plan isn&rsquo;t linked to a Stripe price yet — ask the host to
                          configure it.
                        </p>
                      )
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-600">
              <p>
                Switching plans uses Stripe Checkout — proration is shown before you confirm. Plan
                names, prices, and features are configured by the Marketr host in{" "}
                <code className="rounded bg-stone-100 px-1 font-mono text-xs">lib/billing/plans.ts</code>{" "}
                (editable defaults, not fetched from Stripe).
              </p>
            </div>
          </section>

          {/* Billing history pointer */}
          <section>
            <h2 className="text-sm font-semibold text-stone-900">Billing history</h2>
            <div className="mt-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-600">
              {sub.subscription ? (
                <p>
                  Subscription invoices and receipts live on Stripe&rsquo;s billing portal — use{" "}
                  <button
                    className="font-medium text-[var(--brand-700)] underline underline-offset-2"
                    onClick={openPortal}
                    disabled={openingPortal}
                  >
                    Manage subscription &amp; invoices
                  </button>{" "}
                  above. Credit top-up purchases and overage invoices are under{" "}
                  <Link href="/dashboard/settings/usage" className="font-medium text-[var(--brand-700)] underline underline-offset-2">
                    Settings → Usage
                  </Link>
                  .
                </p>
              ) : (
                <p>
                  No subscription invoices yet. Credit top-up purchases and overage invoices are
                  under{" "}
                  <Link href="/dashboard/settings/usage" className="font-medium text-[var(--brand-700)] underline underline-offset-2">
                    Settings → Usage
                  </Link>
                  .
                </p>
              )}
            </div>
          </section>
        </>
      )}

      {/* Billing summary link for admins who land here directly */}
      <Link
        href="/dashboard/settings/usage"
        className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-[var(--brand-700)] hover:underline"
      >
        <BadgeCheck className="h-3.5 w-3.5" />
        View credit usage, spend cap, and top-ups
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
