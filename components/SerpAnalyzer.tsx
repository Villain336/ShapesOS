"use client";

// Marketr — standalone SERP analysis widget (serp_analysis, 1 credit).
// Mounted on the AI Search page. Shows the credit cost before running and
// surfaces cap-denial messages verbatim (no retry, no splitting).

import { useState, type FormEvent } from "react";
import type { SerpAnalysis } from "@/lib/serp/analyze";

const inputCls =
  "rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";
const th =
  "px-3 py-2 text-left text-xs font-semibold text-muted";
const td = "px-3 py-2 text-sm";

export default function SerpAnalyzer({ projectId }: { projectId: string }) {
  const [keyword, setKeyword] = useState("");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SerpAnalysis | null>(null);

  async function onAnalyze(e: FormEvent) {
    e.preventDefault();
    if (!keyword.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/serp/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          keyword: keyword.trim(),
          device,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        // Cap-denial and validation messages are surfaced verbatim.
        setError(json.error ?? "Analysis failed.");
        return;
      }
      setResult(json.analysis as SerpAnalysis);
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg bg-paper shadow-hairline p-4">
      <h2 className="text-lg font-heading tracking-heading stretch-heading text-ink">
        SERP analysis
      </h2>
      <p className="mt-1 text-sm text-muted">
        Pull the live search results page for any keyword — top results, SERP
        features, and a deterministic breakdown.{" "}
        <span className="font-medium text-ink">Costs 1 credit</span> per
        analysis (same keyword, same day is not charged twice).
      </p>
      <form onSubmit={onAnalyze} className="mt-3 flex flex-wrap items-end gap-2">
        <input
          className={inputCls}
          placeholder="Keyword, e.g. best crm for agencies"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          maxLength={200}
        />
        <select
          className={inputCls}
          value={device}
          onChange={(e) => setDevice(e.target.value as "desktop" | "mobile")}
          aria-label="Device"
        >
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
        </select>
        <button
          type="submit"
          disabled={loading || !keyword.trim()}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-50"
        >
          {loading ? "Analyzing…" : "Analyze SERP"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-failed-text">{error}</p>}
      {result && (
        <div className="mt-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              <span className="text-muted">Results:</span>{" "}
              <span className="font-medium">{result.analysis.resultCount}</span>
            </span>
            <span>
              <span className="text-muted">Unique domains:</span>{" "}
              <span className="font-medium">
                {result.analysis.uniqueDomains}
              </span>
            </span>
            <span>
              <span className="text-muted">Domain diversity:</span>{" "}
              <span className="font-medium">
                {result.analysis.domainDiversity}
              </span>
            </span>
            <span>
              <span className="text-muted">AI Overview:</span>{" "}
              <span className="font-medium">
                {result.features.aiOverviewPresent == null
                  ? "—"
                  : result.features.aiOverviewPresent
                    ? "yes"
                    : "no"}
              </span>
            </span>
            <span>
              <span className="text-muted">People also ask:</span>{" "}
              <span className="font-medium">
                {result.features.peopleAlsoAskCount}
              </span>
            </span>
          </div>
          {result.mock && (
            <p className="mt-2 text-xs text-muted">
              Mock SERP — connect a live data source for real results.
            </p>
          )}
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left">
                <th className={th}>#</th>
                <th className={th}>Domain</th>
                <th className={th}>Title</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r) => (
                <tr key={r.position} className="border-t border-line">
                  <td className={td}>{r.position}</td>
                  <td className={td}>{r.domain}</td>
                  <td className={`${td} text-muted`}>{r.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.peopleAlsoAsk.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold text-muted">
                People also ask
              </h3>
              <ul className="mt-1 list-disc pl-5 text-sm text-ink">
                {result.peopleAlsoAsk.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
