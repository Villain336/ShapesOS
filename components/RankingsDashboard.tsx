"use client";

// Marketr — rank tracking dashboard (milestone 5, spec §5 flow 4):
// toggle tracked keywords → run rank checks (on demand) → see positions,
// winners/losers, the unified visibility score, AI Overview presence,
// and movement alerts.

import { useEffect, useState } from "react";

type KeywordRow = {
  id: string;
  phrase: string;
  volume: number | null;
  difficulty: number | null;
  intent: string;
  list: string | null;
  tracked: boolean;
  latest: {
    position: number | null;
    url: string | null;
    aiOverviewPresent: boolean;
    checkedAt: string;
  } | null;
  previous: { position: number | null } | null;
};

type Alert = {
  keywordId: string;
  phrase: string;
  kind: string;
  from: number | null;
  to: number | null;
  checkedAt: string;
};

type DashboardData = {
  keywords: KeywordRow[];
  trackedCount: number;
  visibilityScore: number;
  alerts: Alert[];
  lastCheck: string | null;
  provider: { name: string; isLive: boolean; configured: boolean };
};

const th =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-widest text-zinc-500";
const td = "px-3 py-2 text-sm";

const ALERT_LABEL: Record<string, string> = {
  entered_top_10: "Entered top 10",
  left_top_10: "Left top 10",
  big_gain: "Big gain",
  big_loss: "Big loss",
  newly_ranking: "Now ranking",
  dropped_out: "Dropped out",
};

function fmtPos(p: number | null): string {
  return p == null ? "—" : `#${p}`;
}

function Delta({ row }: { row: KeywordRow }) {
  const prev = row.previous?.position ?? null;
  const curr = row.latest?.position ?? null;
  if (prev == null || curr == null) return null;
  const d = prev - curr; // positive = moved up
  if (d === 0)
    return <span className="ml-1 text-xs text-zinc-500">=</span>;
  const cls = d > 0 ? "text-emerald-400" : "text-red-400";
  const arrow = d > 0 ? "▲" : "▼";
  return (
    <span className={`ml-1 text-xs ${cls}`}>
      {arrow} {Math.abs(d)}
    </span>
  );
}

export default function RankingsDashboard({
  projectId,
  domain,
}: {
  projectId: string;
  domain: string;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [checking, setChecking] = useState(false);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  async function load() {
    const res = await fetch(
      `/api/rankings?projectId=${encodeURIComponent(projectId)}`,
    );
    if (res.ok) setData(await res.json());
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function toggleTracked(kw: KeywordRow) {
    setToggling((s) => new Set(s).add(kw.id));
    setError(null);
    try {
      const res = await fetch("/api/keywords/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywordId: kw.id, tracked: !kw.tracked }),
      });
      if (!res.ok) {
        const json = await res.json();
        setError(json.error ?? "Could not update tracking.");
        return;
      }
      setData((d) =>
        d
          ? {
              ...d,
              keywords: d.keywords.map((k) =>
                k.id === kw.id ? { ...k, tracked: !k.tracked } : k,
              ),
              trackedCount: d.trackedCount + (kw.tracked ? -1 : 1),
            }
          : d,
      );
    } finally {
      setToggling((s) => {
        const n = new Set(s);
        n.delete(kw.id);
        return n;
      });
    }
  }

  async function runCheck() {
    setChecking(true);
    setError(null);
    setCheckMsg(null);
    try {
      const res = await fetch("/api/rankings/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Rank check failed.");
        return;
      }
      const parts = [
        `Checked ${json.checked} keyword${json.checked === 1 ? "" : "s"}`,
      ];
      if (json.skipped > 0) parts.push(`${json.skipped} skipped`);
      if (json.alerts?.length > 0)
        parts.push(`${json.alerts.length} movement alert${json.alerts.length === 1 ? "" : "s"}`);
      if (json.mock) parts.push("(mock data)");
      setCheckMsg(parts.join(" · "));
      await load();
    } finally {
      setChecking(false);
    }
  }

  const tracked = (data?.keywords ?? []).filter((k) => k.tracked);
  const provider = data?.provider;

  return (
    <div className="flex flex-col gap-6">
      {provider && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            provider.isLive
              ? "border-emerald-900 bg-emerald-950/40 text-emerald-300"
              : "border-amber-900 bg-amber-950/40 text-amber-300"
          }`}
        >
          {provider.isLive ? (
            <>Live rank data from DataForSEO.</>
          ) : (
            <>
              Showing <strong>mock rank data</strong> — add{" "}
              <span className="font-mono">DATAFORSEO_LOGIN</span> and{" "}
              <span className="font-mono">DATAFORSEO_PASSWORD</span> to{" "}
              <span className="font-mono">.env</span> for live rank checks.
              AI Overview flags are simulated, not real detection.
            </>
          )}
        </div>
      )}

      {/* Score + check controls */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-xs font-medium uppercase tracking-widest text-zinc-500">
              Visibility score
            </div>
            <div className="mt-1 text-4xl font-bold tracking-tight">
              {data ? data.visibilityScore : "—"}
              <span className="text-lg text-zinc-500">/100</span>
            </div>
          </div>
          <div className="text-sm text-zinc-400">
            <div>
              <strong className="text-zinc-200">{data?.trackedCount ?? 0}</strong>{" "}
              tracked keywords
            </div>
            <div className="mt-1">
              {data?.lastCheck
                ? `Last check: ${new Date(data.lastCheck).toLocaleString()}`
                : "No checks yet"}
            </div>
          </div>
        </div>
        <button
          onClick={runCheck}
          disabled={checking || tracked.length === 0}
          className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {checking ? "Checking…" : "Run rank check"}
        </button>
      </div>
      {tracked.length === 0 && (
        <p className="text-sm text-zinc-500">
          Nothing is tracked yet — flip the toggle on keywords below, then run
          a check.
        </p>
      )}
      {error && (
        <div className="rounded-xl border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {checkMsg && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300">
          {checkMsg}
        </div>
      )}

      {/* Movement alerts */}
      {data && data.alerts.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
            Movement alerts
          </h2>
          <ul className="flex flex-col gap-2">
            {data.alerts.map((a, i) => (
              <li
                key={`${a.keywordId}-${a.kind}-${a.checkedAt}-${i}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-sm"
              >
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    a.kind === "entered_top_10" ||
                    a.kind === "big_gain" ||
                    a.kind === "newly_ranking"
                      ? "bg-emerald-950 text-emerald-300"
                      : "bg-red-950 text-red-300"
                  }`}
                >
                  {ALERT_LABEL[a.kind] ?? a.kind}
                </span>
                <span className="font-medium">{a.phrase}</span>
                <span className="text-zinc-500">
                  {fmtPos(a.from)} → {fmtPos(a.to)}
                </span>
                <span className="ml-auto text-xs text-zinc-600">
                  {new Date(a.checkedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Positions table */}
      {tracked.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
            Tracked positions
          </h2>
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full border-collapse">
              <thead className="bg-zinc-900/80">
                <tr>
                  <th className={th}>Keyword</th>
                  <th className={th}>Position</th>
                  <th className={th}>AI Overview</th>
                  <th className={th}>Volume</th>
                  <th className={th}>Ranking URL</th>
                </tr>
              </thead>
              <tbody>
                {tracked.map((k) => (
                  <tr key={k.id} className="border-t border-zinc-800/60">
                    <td className={td}>
                      <span className="font-medium">{k.phrase}</span>
                    </td>
                    <td className={td}>
                      <span className="font-mono">
                        {fmtPos(k.latest?.position ?? null)}
                      </span>
                      <Delta row={k} />
                    </td>
                    <td className={td}>
                      {k.latest ? (
                        k.latest.aiOverviewPresent ? (
                          <span className="rounded-full bg-violet-950 px-2.5 py-0.5 text-xs text-violet-300">
                            Present
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-600">Absent</span>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={td}>
                      {k.volume != null ? k.volume.toLocaleString("en-US") : "—"}
                    </td>
                    <td className={`${td} max-w-64 truncate`}>
                      {k.latest?.url ? (
                        <span className="font-mono text-xs text-zinc-400">
                          {k.latest.url.replace(/^https?:\/\//, "")}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-zinc-600">
            {domain} matched by apex domain or subdomain. "—" means not found in
            the checked depth.
          </p>
        </div>
      )}

      {/* Track toggles */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
          Saved keywords — track for ranking
        </h2>
        {(data?.keywords ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            No saved keywords yet. Run keyword research or the gap analysis and
            save keywords to a list first.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(data?.keywords ?? []).map((k) => (
              <li
                key={k.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{k.phrase}</div>
                  <div className="text-xs text-zinc-500">
                    {k.list ?? "Saved keywords"}
                    {k.latest?.position != null &&
                      ` · ${fmtPos(k.latest.position)}`}
                  </div>
                </div>
                <button
                  onClick={() => toggleTracked(k)}
                  disabled={toggling.has(k.id)}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                    k.tracked
                      ? "bg-emerald-950 text-emerald-300"
                      : "border border-zinc-700 text-zinc-400 hover:border-zinc-500"
                  } disabled:opacity-40`}
                >
                  {toggling.has(k.id)
                    ? "…"
                    : k.tracked
                      ? "Tracking ✓"
                      : "Track"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
