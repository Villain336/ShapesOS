// Marketr — Phase 18 slice 5: guided checklist with persisted checkmarks.
//
// Purely local progress tracking (localStorage per workspace): the Ads
// Manager account setup happens outside Marketr, this just remembers where
// the user got to.

"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import type { SpotifyGuidedStep } from "@/lib/adplatforms/spotify/planning";

const STORAGE_PREFIX = "marketr-spotify-guided-checklist:";

export default function GuidedChecklist({ steps }: { steps: SpotifyGuidedStep[] }) {
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + "default");
      if (raw) setDone(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // Corrupt storage is not worth an error UI.
    }
  }, []);

  function toggle(id: string) {
    setDone((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(STORAGE_PREFIX + "default", JSON.stringify(next));
      } catch {
        // Storage may be unavailable; the toggle still renders.
      }
      return next;
    });
  }

  return (
    <ol className="flex flex-col gap-2">
      {steps.map((s, i) => {
        const checked = !!done[s.id];
        return (
          <li
            key={s.id}
            className={`rounded-lg border bg-white px-3 py-2.5 ${checked ? "border-stone-200 opacity-70" : "border-stone-200"}`}
          >
            <div className="flex items-start gap-2.5">
              <button
                type="button"
                onClick={() => toggle(s.id)}
                aria-pressed={checked}
                title={checked ? "Mark as not done" : "Mark as done"}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                  checked
                    ? "border-[var(--brand-600)] bg-[var(--brand-600)] text-white"
                    : "border-stone-300 bg-white text-transparent hover:border-[var(--brand-600)]"
                }`}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <div className="min-w-0 flex-1">
                <p className={`text-[13px] font-medium ${checked ? "text-stone-500 line-through" : "text-stone-900"}`}>
                  <span className="mr-1.5 text-stone-400">{i + 1}.</span>
                  {s.title}
                </p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-stone-500">{s.detail}</p>
                {s.link && (
                  <a
                    href={s.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-[12px] font-medium text-[var(--brand-700)] underline"
                  >
                    {s.link.label} ↗
                  </a>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
