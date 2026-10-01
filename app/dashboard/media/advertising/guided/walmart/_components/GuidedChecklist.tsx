// Marketr — Phase 18 slice 4: guided checklist with persisted checkmarks.
//
// Purely local progress tracking (localStorage per workspace): the WCPN
// partner application happens outside Marketr, this just remembers where
// the user got to.

"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { WalmartGuidedStep } from "@/lib/adplatforms/walmart/guided";

const STORAGE_PREFIX = "marketr-walmart-guided-checklist:";
const iconBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper text-muted shadow-outline aos-press hover:bg-hover-paper hover:text-ink";

export default function GuidedChecklist({ steps }: { steps: WalmartGuidedStep[] }) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<string | null>(null);

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

  async function copyCommand(id: string, cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(id + cmd);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard may be blocked; the command text is still visible.
    }
  }

  return (
    <ol className="flex flex-col gap-2">
      {steps.map((s, i) => {
        const checked = !!done[s.id];
        return (
          <li
            key={s.id}
            className={`rounded-lg bg-paper px-3 py-2.5 shadow-hairline ${checked ? "opacity-70" : ""}`}
          >
            <div className="flex items-start gap-2.5">
              <button
                type="button"
                onClick={() => toggle(s.id)}
                aria-pressed={checked}
                title={checked ? "Mark as not done" : "Mark as done"}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-[1.5px] ${
                  checked
                    ? "border-ink bg-ink text-white"
                    : "border-control bg-paper text-transparent hover:border-ink"
                }`}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold ${checked ? "text-muted line-through" : "text-ink"}`}>
                  <span className="mr-1.5 text-subtle">{i + 1}.</span>
                  {s.title}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">{s.detail}</p>
                {s.link && (
                  <a
                    href={s.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-sm font-semibold text-ink underline underline-offset-2"
                  >
                    {s.link.label} ↗
                  </a>
                )}
                {s.commands?.map((cmd) => (
                  <div key={cmd} className="mt-1.5 flex items-center gap-1.5">
                    <code className="flex-1 overflow-x-auto rounded-md bg-night px-2.5 py-1.5 font-mono text-xs text-night-text">
                      {cmd}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyCommand(s.id, cmd)}
                      title="Copy command"
                      className={iconBtn}
                    >
                      {copied === s.id + cmd ? <Check className="h-3.5 w-3.5 text-ink" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
