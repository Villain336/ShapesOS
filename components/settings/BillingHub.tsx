// Marketr — billing hub (Phase 13 Wave A; Phase 15.3 pricing: base fee +
// seats + credits, the Business plan, an annual toggle and extra seats).
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
  RefreshCw,
  Users,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

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
  annualPriceDisplay: string;
  annualPriceCents: number;
  includedCredits: number;
  includedSeats: number | null;
  extraSeatCents: number;
  /** The plan's lines: seats, credits, workspaces, twin, then features (from the constants). */
  features: string[];
  badge: string | null;
  purchasable: boolean;
  purchasableAnnual: boolean;
}

interface PlansData {
  configured: boolean;
  currentPlan: string;
  currentInterval: "month" | "year" | null;
  plans: PlanCard[];
}

/** Mirrors lib/billing/seats.ts SeatSummary. */
interface SeatsData {
  plan: string;
  included: number | null;
  used: number;
  extra: number;
  approvedExtra: number;
  billedExtra: number;
  targetExtra: number;
  unapprovedExtra: number;
  perSeatCents: number | null;
  interval: "month" | "year";
  billable: boolean;
  billableReason: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
}

type Interval = "month" | "year";

const usd = (cents: number) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

const segBase =
  "inline-flex h-control-sm items-center rounded-full px-4 text-sm font-semibold aos-press";

interface SubData {
  configured: boolean;
  plan: string;
  subscription: {
    planId: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    interval?: "month" | "year" | null;
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
  includes,
}: {
  workspaceId: string;
  /** Phase 4a: the plan entitlements table (server-rendered). */
  includes?: React.ReactNode;
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
  const [billingInterval, setBillingInterval] = useState<Interval>("month");
  const [seats, setSeats] = useState<SeatsData | null>(null);
  const [seatTarget, setSeatTarget] = useState("");
  const [seatBusy, setSeatBusy] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pr, sr, seatsRes] = await Promise.all([
        fetch(`/api/billing/plans?${q}`),
        fetch(`/api/billing/subscription?${q}`),
        fetch(`/api/billing/seats?${q}`),
      ]);
      if (seatsRes.ok) {
        const sj = (await seatsRes.json()) as SeatsData;
        setSeats(sj);
        setSeatTarget(String(sj.approvedExtra));
      }
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
      const pj = (await pr.json()) as PlansData;
      setPlans(pj);
      if (pj.currentInterval) setBillingInterval(pj.currentInterval);
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
        body: JSON.stringify({ workspaceId, planId, interval: billingInterval }),
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

  const postSeats = async (payload: Record<string, unknown>) => {
    const r = await fetch(`/api/billing/seats?${q}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, ...payload }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.seats) {
      setSeats(j.seats);
      setSeatTarget(String(j.seats.approvedExtra));
    }
    return { r, j };
  };

  // Raising the approved extra seats is a money decision: the confirm dialog
  // shows the price, and only then is confirmSeatCharge sent.
  const approveSeats = async () => {
    if (!seats || seats.perSeatCents === null) return;
    const next = Number(seatTarget);
    if (!Number.isInteger(next) || next < 0) {
      setNotice({ kind: "error", message: "Approved extra seats must be a whole number." });
      return;
    }
    const more = next - seats.approvedExtra;
    if (more > 0) {
      const ok = await confirmAction({
        title: `Approve ${more} more extra seat${more === 1 ? "" : "s"}?`,
        description:
          `Each extra seat costs ${usd(seats.perSeatCents)} per ${seats.interval}, billed only while a member uses it ` +
          `(up to ${usd(seats.perSeatCents * more)} more per ${seats.interval}, prorated). Admins, SCIM and SSO can then add ` +
          `members up to ${(seats.included ?? 0) + next} without asking again.`,
        confirmLabel: "Approve and bill when used",
      });
      if (!ok) return;
    }
    setSeatBusy(true);
    setNotice(null);
    try {
      const { r, j } = await postSeats({ approvedExtraSeats: next, confirmSeatCharge: more > 0 });
      if (!r.ok) throw new Error(j.error ?? "Couldn't change the approved seats");
      setNotice({ kind: "ok", message: `Approved extra seats: ${next}.` });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Couldn't change the approved seats" });
    } finally {
      setSeatBusy(false);
    }
  };

  const resyncSeats = async () => {
    setSeatBusy(true);
    setNotice(null);
    try {
      const { r, j } = await postSeats({ action: "sync" });
      if (!r.ok) throw new Error(j.sync?.error ?? j.error ?? "Seat sync failed");
      setNotice({ kind: "ok", message: "Seats are in sync with Stripe." });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Seat sync failed" });
    } finally {
      setSeatBusy(false);
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
                portal — ShapesOS never stores your card.
              </p>
            </div>
          </section>

          {/* Seats (Phase 15.3): included, extra, approved ceiling, Stripe sync */}
          {seats && seats.included !== null && (
            <section>
              <h2 className="text-sm font-semibold text-ink">Seats</h2>
              <div className={`${cardCls} mt-2`}>
                <div className="flex flex-wrap items-center gap-3">
                  <Users className="h-5 w-5 text-subtle" aria-hidden />
                  <p className="text-base font-semibold text-ink">
                    {seats.used} used of {seats.included} included
                  </p>
                  {seats.extra > 0 && (
                    <span className={chipCls}>
                      {seats.extra} extra
                      {seats.perSeatCents !== null ? ` at ${usd(seats.perSeatCents)} / ${seats.interval}` : ""}
                    </span>
                  )}
                </div>
                <table className="mt-3 w-full text-left text-sm">
                  <tbody>
                    <tr className="border-b border-line">
                      <th scope="row" className="py-2 pr-3 font-medium text-ink">Extra seats billed on Stripe</th>
                      <td className="py-2 text-ink">{seats.billedExtra}</td>
                    </tr>
                    <tr className="border-b border-line">
                      <th scope="row" className="py-2 pr-3 font-medium text-ink">Extra seats you approved</th>
                      <td className="py-2 text-ink">{seats.approvedExtra}</td>
                    </tr>
                    <tr>
                      <th scope="row" className="py-2 pr-3 font-medium text-ink">Last synced</th>
                      <td className="py-2 text-muted">
                        {seats.lastSyncedAt ? new Date(seats.lastSyncedAt).toLocaleString() : "Not yet"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                {seats.unapprovedExtra > 0 && (
                  <p className="mt-3 text-[13px] text-ink">
                    {seats.unapprovedExtra} member{seats.unapprovedExtra === 1 ? " is" : "s are"} past your approved
                    seats (for example after a plan change) and {seats.unapprovedExtra === 1 ? "isn't" : "aren't"} billed.
                    Approve more extra seats below, or remove members.
                  </p>
                )}
                {seats.syncError && (
                  <div className="mt-3">
                    <Notice notice={{ kind: "error", message: `Seat sync with Stripe failed: ${seats.syncError}` }} />
                  </div>
                )}
                {seats.billable ? (
                  <div className="mt-4 flex flex-wrap items-end gap-2">
                    <div>
                      <label htmlFor="seat-target" className="block text-xs font-semibold text-muted">
                        Approved extra seats
                      </label>
                      <input
                        id="seat-target"
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={seatTarget}
                        onChange={(e) => setSeatTarget(e.target.value)}
                        className="mt-1 h-control-sm w-28 rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink focus:border-focus focus:outline-none"
                      />
                    </div>
                    <button className={btnPrimary} disabled={seatBusy || seatTarget === String(seats.approvedExtra)} onClick={approveSeats}>
                      {seatBusy ? "Saving…" : "Save approved seats"}
                    </button>
                    <button className={btnGhost} disabled={seatBusy} onClick={resyncSeats}>
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                      Sync with Stripe
                    </button>
                  </div>
                ) : (
                  <p className="mt-3 text-[13px] text-muted">{seats.billableReason}</p>
                )}
                <p className="mt-3 text-xs text-muted">
                  Extra seats are only charged after an admin confirms the price — when adding a member past
                  your seats, or by approving seats here (needed for SCIM and SSO, which can&rsquo;t ask).
                  Removing members lowers the bill automatically. A plan change resets the approval, since
                  the per-seat price changes with the plan.
                </p>
              </div>
            </section>
          )}

          {/* Plans / pricing — driven by the plan constants (lib/billing/plans.ts) */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">Plans</h2>
              <div role="group" aria-label="Billing interval" className="inline-flex gap-1 rounded-full bg-hover p-1">
                {(["month", "year"] as const).map((i) => (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={billingInterval === i}
                    onClick={() => setBillingInterval(i)}
                    className={`${segBase} ${billingInterval === i ? "bg-ink text-white" : "text-ink hover:bg-paper"}`}
                  >
                    {i === "month" ? "Monthly" : "Annual, 2 months free"}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {plans.plans.map((p) => {
                const isCurrent =
                  p.id === plans.currentPlan && (plans.currentInterval ?? "month") === billingInterval;
                const purchasable = billingInterval === "year" ? p.purchasableAnnual : p.purchasable;
                const actionText = !plans.configured
                  ? "Billing not enabled"
                  : !purchasable
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
                      <span className="text-3xl font-bold tracking-tight text-ink">
                        {billingInterval === "year" ? p.annualPriceDisplay : p.priceDisplay}
                      </span>
                      <span className="text-sm text-muted"> / {billingInterval === "year" ? "year" : "month"}</span>
                    </p>
                    {billingInterval === "year" && (
                      <p className="mt-1 text-[13px] text-muted">
                        {usd(Math.round(p.annualPriceCents / 12))} / month, billed yearly
                      </p>
                    )}
                    <ul className="mt-4 flex flex-1 flex-col gap-1.5">
                      {p.features.map((f) => (
                        <li key={f} className="flex items-start gap-2 text-[13px] text-muted">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <button
                      className={`${isCurrent || !plans.configured || !purchasable ? btnGhost : btnPrimary} mt-5 w-full`}
                      disabled={isCurrent || !plans.configured || !purchasable || buying !== null}
                      onClick={() => choose(p.id)}
                    >
                      {buying === p.id ? "Redirecting to checkout…" : actionText}
                    </button>
                    {!plans.configured ? (
                      <p className="mt-2 text-xs text-muted">
                        Plan purchases need Stripe keys on this deployment.
                      </p>
                    ) : (
                      !purchasable && (
                        <p className="mt-2 text-xs text-muted">
                          This plan{billingInterval === "year" ? "'s annual option" : ""} isn&rsquo;t linked to a Stripe
                          price yet — ask the host to configure it.
                        </p>
                      )
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2 text-[13px] text-muted">
              <p>
                Every plan is a base fee with seats and AI credits included; extra seats are billed per seat
                once you confirm them. Switching plans uses Stripe Checkout — proration is shown before you confirm. Plan
                prices, seats and credits are configured by the ShapesOS host in{" "}
                <code className="rounded bg-canvas px-1 font-mono text-xs">lib/billing/plans.ts</code>{" "}
                (not fetched from Stripe). See the public{" "}
                <Link href="/pricing" className="font-medium text-ink underline underline-offset-2">
                  pricing page
                </Link>
                .
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

      {includes}

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
