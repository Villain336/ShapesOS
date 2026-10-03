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
  BadgeCheck,
  Check,
  CreditCard,
  ArrowRight,
} from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const btnPrimary =
  "inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

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

// Subscription/invoice states are money states, not agent states — neutral chips.
function statusBadge(sub: SubData["subscription"]): { text: string } {
  if (!sub) return { text: "No paid subscription" };
  if (sub.cancelAtPeriodEnd) return { text: "Cancels at period end" };
  if (sub.status === "active" || sub.status === "trialing")
    return { text: sub.status === "trialing" ? "Trialing" : "Active" };
  if (sub.status === "past_due" || sub.status === "incomplete")
    return { text: "Payment issue" };
  return { text: sub.status };
}

export default function BillingHub({
  workspaceId,
  nav,
  trial,
}: {
  workspaceId: string;
  /** Phase 3: the grouped settings nav, so billing sits inside settings. */
  nav?: React.ReactNode;
  /** Phase 3: hosted trial state (null when not on the trial plan). */
  trial?: { daysLeft: number; endsOn: string | null; expired: boolean } | null;
}) {
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
      // that's an honest no-key state, not a failure. Render the needs banner.
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
    (plans?.currentPlan === "self_hosted"
      ? "Self-hosted"
      : plans?.currentPlan === "trial"
        ? "Trial"
        : (plans?.currentPlan ?? "…"));

  const badge = statusBadge(sub?.subscription ?? null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Billing &amp; plans</h1>
        <p className="mt-0.5 text-sm text-muted">
          Your subscription, plans, and invoices. Payments run through Stripe — card details never
          touch ShapesOS.
        </p>
      </div>
      {nav}

      {trial && (
        <div role="status" className="rounded-lg bg-paper px-4 py-3 shadow-hairline">
          <p className="text-base font-semibold text-ink">
            {trial.expired
              ? `Your trial ended${trial.endsOn ? ` on ${trial.endsOn}` : ""}.`
              : `${trial.daysLeft} day${trial.daysLeft === 1 ? "" : "s"} left in your trial${trial.endsOn ? ` (ends ${trial.endsOn})` : ""}.`}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {trial.expired
              ? "Credit-using actions are paused until you choose a plan below. Everything you made is still here."
              : "Choose a plan below any time; everything in the workspace carries over."}
          </p>
        </div>
      )}

      {notice && <Notice notice={notice} />}

      {/* Honest no-key state: nothing purchases, nothing crashes. */}
      {plans && !plans.configured && (
        <div className="flex items-start gap-3 rounded-md border border-line bg-needs-tint px-3 py-2.5">
          <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5" role="img" aria-label="Needs attention" />
          <p className="text-sm text-ink">
            <strong>Billing isn&rsquo;t enabled on this deployment.</strong> The Stripe keys
            (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET) aren&rsquo;t set, so plan purchases,
            top-ups, and card management are disabled. Usage is still metered locally against your
            included credits — nothing here can charge you. To enable billing, the host adds the
            keys to the environment (see .env.example).
          </p>
        </div>
      )}

      {loading || !plans || !sub ? (
        <p className="text-sm text-muted">{loading ? "Loading billing…" : "Billing unavailable."}</p>
      ) : (
        <>
          {/* Current subscription */}
          <section>
            <h2 className="text-sm font-semibold text-ink">Current subscription</h2>
            <div className={`${cardCls} mt-2`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-subtle" />
                  <div>
                    <p className="text-base font-semibold text-ink">{currentPlanName}</p>
                    <p className="text-[13px] text-muted">
                      {sub.subscription?.currentPeriodEnd
                        ? `Renews ${new Date(sub.subscription.currentPeriodEnd).toLocaleDateString()}`
                        : sub.subscription
                          ? "Period end unknown — check the billing portal"
                          : "No paid subscription — pick a plan below to upgrade"}
                    </p>
                  </div>
                  <span className={chipCls}>{badge.text}</span>
                </div>
                {sub.subscription && (
                  <button className={btnGhost} disabled={openingPortal} onClick={openPortal}>
                    {openingPortal ? "Opening…" : "Manage subscription & invoices"}
                  </button>
                )}
              </div>
              <p className="mt-3 text-xs text-muted">
                Cancellation, invoices, receipts, and card updates happen on Stripe&rsquo;s billing
                portal — Marketr never stores your card.
              </p>
            </div>
          </section>

          {/* Plans / pricing — driven by the admin-configurable catalogue */}
          <section>
            <h2 className="text-sm font-semibold text-ink">Plans</h2>
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
                    className={`relative flex flex-col rounded-xl border bg-paper p-5 ${
                      isCurrent ? "border-ink ring-1 ring-ink" : "border-line"
                    }`}
                  >
                    {p.badge && (
                      <span className="absolute -top-2.5 left-4 rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-semibold text-white">
                        {p.badge}
                      </span>
                    )}
                    <p className="text-lg font-semibold text-ink">{p.name}</p>
                    <p className="mt-0.5 text-[13px] text-muted">{p.tagline}</p>
                    <p className="mt-3">
                      <span className="text-3xl font-bold tracking-tight text-ink">{p.priceDisplay}</span>
                      <span className="text-sm text-muted"> / month</span>
                    </p>
                    <p className="mt-1 text-[13px] text-muted">
                      {p.includedCredits.toLocaleString()} included credits / month
                    </p>
                    <ul className="mt-4 flex flex-1 flex-col gap-1.5">
                      {p.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 text-[13px] text-muted">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <button
                      className={`${isCurrent || !plans.configured || !p.purchasable ? btnGhost : btnPrimary} mt-5 w-full`}
                      disabled={isCurrent || !plans.configured || !p.purchasable || buying !== null}
                      onClick={() => choose(p.id)}
                    >
                      {buying === p.id ? "Redirecting to checkout…" : actionText}
                    </button>
                    {!plans.configured ? (
                      <p className="mt-2 text-xs text-muted">
                        Plan purchases need Stripe keys on this deployment.
                      </p>
                    ) : (
                      !p.purchasable && (
                        <p className="mt-2 text-xs text-muted">
                          This plan isn&rsquo;t linked to a Stripe price yet — ask the host to
                          configure it.
                        </p>
                      )
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2 text-[13px] text-muted">
              <p>
                Switching plans uses Stripe Checkout — proration is shown before you confirm. Plan
                names, prices, and features are configured by the Marketr host in{" "}
                <code className="rounded bg-canvas px-1 font-mono text-xs">lib/billing/plans.ts</code>{" "}
                (editable defaults, not fetched from Stripe).
              </p>
            </div>
          </section>

          {/* Billing history pointer */}
          <section>
            <h2 className="text-sm font-semibold text-ink">Billing history</h2>
            <div className="mt-2 rounded-md border border-line bg-canvas px-3 py-2 text-[13px] text-muted">
              {sub.subscription ? (
                <p>
                  Subscription invoices and receipts live on Stripe&rsquo;s billing portal — use{" "}
                  <button
                    className="font-medium text-ink underline underline-offset-2"
                    onClick={openPortal}
                    disabled={openingPortal}
                  >
                    Manage subscription &amp; invoices
                  </button>{" "}
                  above. Credit top-up purchases and overage invoices are under{" "}
                  <Link href="/dashboard/settings/usage" className="font-medium text-ink underline underline-offset-2">
                    Settings → Usage
                  </Link>
                  .
                </p>
              ) : (
                <p>
                  No subscription invoices yet. Credit top-up purchases and overage invoices are
                  under{" "}
                  <Link href="/dashboard/settings/usage" className="font-medium text-ink underline underline-offset-2">
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
        className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-ink hover:underline"
      >
        <BadgeCheck className="h-3.5 w-3.5" />
        View credit usage, spend cap, and top-ups
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
