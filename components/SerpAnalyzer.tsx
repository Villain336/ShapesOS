"use client";

// Marketr — standalone SERP analysis widget (serp_analysis, 1 credit).
// Mounted on the AI Search page. Shows the credit cost before running and
// surfaces cap-denial messages verbatim (no retry, no splitting).

import { useState, type FormEvent } from "react";
import type { SerpAnalysis } from "@/lib/serp/analyze";

const inputCls =
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-accent focus:outline-none";
const th =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-widest text-zinc-500";
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
    <div className="rounded-lg border border-zinc-300 bg-white p-4">
      <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">
        SERP analysis
      </h2>
      <p className="mt-1 text-sm text-zinc-500">
        Pull the live search results page for any keyword — top results, SERP
        features, and a deterministic breakdown.{" "}
        <span className="font-medium text-zinc-700">Costs 1 credit</span> per
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
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Analyzing…" : "Analyze SERP"}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {result && (
        <div className="mt-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              <span className="text-zinc-500">Results:</span>{" "}
              <span className="font-medium">{result.analysis.resultCount}</span>
            </span>
            <span>
              <span className="text-zinc-500">Unique domains:</span>{" "}
              <span className="font-medium">
                {result.analysis.uniqueDomains}
              </span>
            </span>
            <span>
              <span className="text-zinc-500">Domain diversity:</span>{" "}
              <span className="font-medium">
                {result.analysis.domainDiversity}
              </span>
            </span>
            <span>
              <span className="text-zinc-500">AI Overview:</span>{" "}
              <span className="font-medium">
                {result.features.aiOverviewPresent == null
                  ? "—"
                  : result.features.aiOverviewPresent
                    ? "yes"
                    : "no"}
              </span>
            </span>
            <span>
              <span className="text-zinc-500">People also ask:</span>{" "}
              <span className="font-medium">
                {result.features.peopleAlsoAskCount}
              </span>
            </span>
          </div>
          {result.mock && (
            <p className="mt-2 text-xs text-amber-700">
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
                <tr key={r.position} className="border-t border-zinc-200">
                  <td className={td}>{r.position}</td>
                  <td className={td}>{r.domain}</td>
                  <td className={`${td} text-zinc-600`}>{r.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.peopleAlsoAsk.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
                People also ask
              </h3>
              <ul className="mt-1 list-disc pl-5 text-sm text-zinc-700">
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
