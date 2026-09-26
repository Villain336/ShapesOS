// Marketr — content engine: citation-gap handoff banner (M3 → Phase 2).
// Rendered when an M3 citation-gap deep link arrives (?gapKeyword=…).
// Read-only: it surfaces the handoff (suggested keyword, engines, competitor
// domains, missing structured facts) and copies the brief inputs — the brief
// itself is still built by the normal flow (save keyword → Create brief).

"use client";

import { useState } from "react";
import { Link2, Copy, Check } from "lucide-react";

interface GapHandoff {
  keyword: string;
  engines: string;
  competitors: string;
  facts: string;
}

export default function GapHandoffBanner({ handoff }: { handoff: GapHandoff }) {
  const [copied, setCopied] = useState(false);

  const briefInputs = [
    `Keyword: ${handoff.keyword}`,
    `Engines where competitors are cited: ${handoff.engines}`,
    `Cited instead of you: ${handoff.competitors}`,
    `Structured facts the owned page likely lacks: ${handoff.facts}`,
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(briefInputs);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — the text is visible above
    }
  }

  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-violet-900">
            <Link2 className="h-4 w-4" />
            Citation-gap handoff from AI visibility
          </h2>
          <p className="mt-1 text-[13px] text-violet-900/80">
            Engines cite competitors for this buyer question but never your domain. Save{" "}
            <strong>“{handoff.keyword}”</strong> as a keyword, then build the brief from it —
            feed it the sources so the page carries the structured facts engines quote.
          </p>
          <dl className="mt-2 space-y-1 text-[13px]">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 font-medium text-violet-900">Engines</dt>
              <dd className="text-violet-900/80">{handoff.engines || "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 font-medium text-violet-900">Cited instead</dt>
              <dd className="font-mono text-xs text-violet-900/80">{handoff.competitors || "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 font-medium text-violet-900">Missing facts</dt>
              <dd className="text-violet-900/80">{handoff.facts || "—"}</dd>
            </div>
          </dl>
        </div>
        <button
          onClick={copy}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy brief inputs"}
        </button>
      </div>
    </div>
  );
}
