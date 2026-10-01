// Marketr — Legal/Compliance slice 4: change radar view (client).
// Regulation changes triaged per tenant ("does this affect me"), in plain
// English, informational only. v1 = illustrative seed feed — the seed-data
// banner is always visible so the feed is never mistaken for live tracking.
// Agentic OS: white cards radius-lg, pills for pressables, tokens only,
// Lucide icons only, sentence case. Relevance is NOT a genuine agent state,
// so it gets neutral pills — never the status color+shape language.

"use client";

import { useState } from "react";
import {
  CheckCircle2,
  EyeOff,
  FlaskConical,
  Info,
  Loader2,
  Plus,
  Radar,
  TriangleAlert,
} from "lucide-react";

export interface RadarItemView {
  key: string;
  title: string;
  plainEnglishSummary: string;
  industries: string[];
  jurisdictions: string[];
  category: string;
  sourceRef: string;
  effectiveDate: string | null;
  publishedAt: string;
  seedFlag: boolean;
  relevance: "relevant" | "not_relevant";
  triage: "new" | "reviewed" | "dismissed";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function TriagePill({ item }: { item: RadarItemView }) {
  if (item.triage === "reviewed") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
        <CheckCircle2 size={13} />
        Reviewed
      </span>
    );
  }
  if (item.triage === "dismissed") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
        <EyeOff size={13} />
        Dismissed
      </span>
    );
  }
  return (
    <span className="rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
      New
    </span>
  );
}

function ChangeCard({
  item,
  onTriage,
  onToObligation,
  busyKey,
}: {
  item: RadarItemView;
  onTriage: (key: string, status: "reviewed" | "dismissed") => void;
  onToObligation: (key: string) => void;
  busyKey: string | null;
}) {
  const busy = busyKey === item.key;
  return (
    <article className="rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-[15px] font-semibold">{item.title}</h3>
        {item.relevance === "relevant" ? (
          <span className="rounded-full bg-black px-3 py-1 text-[13px] font-semibold text-white">
            May affect you
          </span>
        ) : (
          <span className="rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
            Unlikely to affect you
          </span>
        )}
        <TriagePill item={item} />
      </div>
      <p className="mt-1.5 text-[14px] text-muted">{item.plainEnglishSummary}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] text-subtle">
          Source: {item.sourceRef}
        </span>
        <span className="rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
          {item.effectiveDate
            ? `Effective: ${formatDate(item.effectiveDate)}`
            : "Effective date not verified"}
        </span>
        <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
          <TriangleAlert size={13} />
          Verify before acting
        </span>
        {item.seedFlag && (
          <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
            <FlaskConical size={13} />
            Example entry
          </span>
        )}
      </div>
      {item.triage === "new" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {item.relevance === "relevant" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onToObligation(item.key)}
              className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              Add to my obligations
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onTriage(item.key, "reviewed")}
            className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline disabled:opacity-50"
          >
            <CheckCircle2 size={14} />
            Mark reviewed
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onTriage(item.key, "dismissed")}
            className="aos-press h-10 rounded-full px-4 text-[14px] font-semibold text-muted disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      )}
    </article>
  );
}

export function RadarView({
  items,
  seedFeedNotice,
  disclaimer,
  onChanged,
}: {
  items: RadarItemView[];
  seedFeedNotice: string;
  disclaimer: string;
  onChanged: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showNotRelevant, setShowNotRelevant] = useState(false);

  async function triage(key: string, status: "reviewed" | "dismissed") {
    setBusyKey(key);
    try {
      const res = await fetch(`/api/legal/radar/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) onChanged();
    } finally {
      setBusyKey(null);
    }
  }

  async function toObligation(key: string) {
    setBusyKey(key);
    try {
      const res = await fetch(
        `/api/legal/radar/${encodeURIComponent(key)}/to-obligation`,
        { method: "POST" },
      );
      if (res.ok) onChanged();
    } finally {
      setBusyKey(null);
    }
  }

  const relevant = items.filter(
    (i) => i.relevance === "relevant" && i.triage !== "dismissed",
  );
  const reviewed = relevant.filter((i) => i.triage === "reviewed");
  const actionable = relevant.filter((i) => i.triage === "new");
  const dismissed = items.filter((i) => i.triage === "dismissed");
  const notRelevant = items.filter((i) => i.relevance === "not_relevant");

  return (
    <div className="flex flex-col gap-4">
      {/* Information-not-advice label — also on every API response. */}
      <div className="flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <Info size={16} className="mt-0.5 shrink-0" />
        <p className="text-[14px]">{disclaimer}</p>
      </div>

      {/* Seed-feed label: v1 is illustrative example content, never a live feed. */}
      <div className="flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <FlaskConical size={16} className="mt-0.5 shrink-0" />
        <div>
          <p className="text-[14px] font-semibold">Illustrative seed data</p>
          <p className="mt-0.5 text-[14px] text-muted">{seedFeedNotice}</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <Radar size={20} className="mx-auto text-muted" />
          <p className="mt-2 text-[15px] font-semibold">No changes in the feed yet</p>
          <p className="mt-1 text-sm text-muted">
            Seed the legal data to load the example change feed.
          </p>
        </div>
      ) : (
        <>
          <section aria-label="Changes that may affect you">
            <h2 className="aos-subheading mb-2">May affect you</h2>
            <p className="mb-3 text-[13px] text-muted">
              {actionable.length} to triage
              {reviewed.length > 0 && ` · ${reviewed.length} reviewed`}
            </p>
            {relevant.length === 0 ? (
              <div className="rounded-lg bg-paper p-6 text-center shadow-hairline">
                <p className="text-[14px] text-muted">
                  Nothing in the example feed matches your industry and
                  jurisdictions.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {relevant.map((item) => (
                  <ChangeCard
                    key={item.key}
                    item={item}
                    onTriage={triage}
                    onToObligation={toObligation}
                    busyKey={busyKey}
                  />
                ))}
              </div>
            )}
          </section>

          {notRelevant.length > 0 && (
            <section aria-label="Changes unlikely to affect you">
              <button
                type="button"
                onClick={() => setShowNotRelevant((v) => !v)}
                className="aos-press mb-2 flex h-10 items-center gap-2 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline"
                aria-expanded={showNotRelevant}
              >
                Unlikely to affect you ({notRelevant.length})
              </button>
              {showNotRelevant && (
                <div className="flex flex-col gap-3">
                  {notRelevant.map((item) => (
                    <ChangeCard
                      key={item.key}
                      item={item}
                      onTriage={triage}
                      onToObligation={toObligation}
                      busyKey={busyKey}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {dismissed.length > 0 && (
            <section aria-label="Dismissed changes">
              <button
                type="button"
                onClick={() => setShowDismissed((v) => !v)}
                className="aos-press mb-2 flex h-10 items-center gap-2 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline"
                aria-expanded={showDismissed}
              >
                Dismissed ({dismissed.length})
              </button>
              {showDismissed && (
                <div className="flex flex-col gap-3">
                  {dismissed.map((item) => (
                    <ChangeCard
                      key={item.key}
                      item={item}
                      onTriage={triage}
                      onToObligation={toObligation}
                      busyKey={busyKey}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
