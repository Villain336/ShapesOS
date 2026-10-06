// Marketr — Legal/Compliance slice 1: obligation checklist view (client).
// Renders the per-tenant computed checklist grouped by category, with
// tenant-controlled status (open / done / snoozed / dismissed).
// Agentic OS: white cards radius-lg, pills for pressables, tokens only,
// Lucide icons only, sentence case. The information-not-advice label sits
// at the top of the checklist and ships on every API response too.

"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Clock,
  EyeOff,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";

export interface ObligationView {
  key: string;
  category: "license" | "filing" | "tax" | "insurance" | "permit";
  title: string;
  description: string;
  sourceRef: string;
  renewalCadence: string | null;
  needsReview: boolean;
  status: "open" | "snoozed" | "dismissed" | "done";
  snoozedUntil: string | null;
  note: string | null;
}

const CATEGORY_META: Record<
  ObligationView["category"],
  { label: string; hint: string }
> = {
  license: { label: "Licenses", hint: "Permission to operate or practice." },
  filing: { label: "Filings", hint: "Registrations and reports to file." },
  tax: { label: "Tax registrations", hint: "Tax accounts to open and keep current." },
  insurance: { label: "Insurance", hint: "Coverage to evaluate with a licensed partner." },
  permit: { label: "Permits", hint: "Location- and activity-specific permits." },
};

const STATUS_META: Record<ObligationView["status"], { label: string; icon: typeof Clock }> = {
  open: { label: "Open", icon: Clock },
  snoozed: { label: "Snoozed", icon: Clock },
  dismissed: { label: "Dismissed", icon: EyeOff },
  done: { label: "Done", icon: CheckCircle2 },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ChecklistView({
  obligations,
  disclaimer,
  onChanged,
  onEditProfile,
}: {
  obligations: ObligationView[];
  disclaimer: string;
  onChanged: () => void;
  onEditProfile: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function setStatus(
    key: string,
    status: ObligationView["status"],
    snoozedUntil: string | null = null,
  ) {
    setBusyKey(key);
    try {
      const res = await fetch(`/api/legal/obligations/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, snoozedUntil }),
      });
      if (res.ok) onChanged();
    } finally {
      setBusyKey(null);
    }
  }

  function snooze30Days(key: string) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    void setStatus(key, "snoozed", d.toISOString());
  }

  const openCount = obligations.filter((o) => o.status === "open").length;
  const verifyCount = obligations.filter((o) => o.needsReview).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Information-not-advice label — also on every API response. */}
      <div className="flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <Info size={16} className="mt-0.5 shrink-0" />
        <p className="text-[0.875rem]">{disclaimer}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[0.8125rem] text-muted">
          {obligations.length} obligations · {openCount} open
          {verifyCount > 0 && ` · ${verifyCount} to verify`}
        </p>
        <div className="ml-auto">
          <button
            type="button"
            onClick={onEditProfile}
            className="aos-press flex h-10 items-center gap-2 rounded-full bg-paper px-5 text-[0.875rem] font-semibold shadow-hairline"
          >
            <RefreshCw size={14} />
            Edit profile
          </button>
        </div>
      </div>

      {obligations.length === 0 ? (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <p className="text-[0.9375rem] font-semibold">No obligations found</p>
          <p className="mt-1 text-sm text-muted">
            Your profile did not match any obligation templates. Update your
            profile to regenerate the map.
          </p>
        </div>
      ) : (
        (Object.keys(CATEGORY_META) as ObligationView["category"][]).map((cat) => {
          const items = obligations.filter((o) => o.category === cat);
          if (items.length === 0) return null;
          return (
            <section key={cat} aria-label={CATEGORY_META[cat].label}>
              <h2 className="aos-subheading mb-2">{CATEGORY_META[cat].label}</h2>
              <p className="mb-3 text-[0.8125rem] text-muted">{CATEGORY_META[cat].hint}</p>
              <div className="flex flex-col gap-3">
                {items.map((o) => {
                  const busy = busyKey === o.key;
                  const StatusIcon = STATUS_META[o.status].icon;
                  return (
                    <article
                      key={o.key}
                      className="rounded-lg bg-paper p-4 shadow-hairline"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 flex-1 text-[0.9375rem] font-semibold">
                          {o.title}
                        </h3>
                        <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[0.8125rem] font-semibold">
                          <StatusIcon size={13} />
                          {STATUS_META[o.status].label}
                          {o.status === "snoozed" && o.snoozedUntil && (
                            <span className="font-normal text-muted">
                              until {formatDate(o.snoozedUntil)}
                            </span>
                          )}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[0.875rem] text-muted">{o.description}</p>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[0.75rem] text-subtle">
                          Source: {o.sourceRef}
                        </span>
                        {o.renewalCadence && (
                          <span className="rounded-full bg-canvas px-3 py-1 text-[0.8125rem] font-semibold">
                            Renews: {o.renewalCadence}
                          </span>
                        )}
                        {o.needsReview && (
                          <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[0.8125rem] font-semibold">
                            <TriangleAlert size={13} />
                            Verify before acting
                          </span>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {o.status !== "done" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void setStatus(o.key, "done")}
                            className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[0.875rem] font-semibold text-white disabled:opacity-50"
                          >
                            {busy ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <CheckCircle2 size={14} />
                            )}
                            Mark done
                          </button>
                        )}
                        {o.status !== "snoozed" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => snooze30Days(o.key)}
                            className="aos-press h-10 rounded-full bg-paper px-5 text-[0.875rem] font-semibold shadow-hairline disabled:opacity-50"
                          >
                            Snooze 30 days
                          </button>
                        )}
                        {o.status !== "open" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void setStatus(o.key, "open")}
                            className="aos-press flex h-10 items-center gap-1.5 rounded-full px-4 text-[0.875rem] font-semibold text-muted disabled:opacity-50"
                          >
                            <RotateCcw size={14} />
                            Reopen
                          </button>
                        )}
                        {o.status === "open" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void setStatus(o.key, "dismissed")}
                            className="aos-press h-10 rounded-full px-4 text-[0.875rem] font-semibold text-failed-text disabled:opacity-50"
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
