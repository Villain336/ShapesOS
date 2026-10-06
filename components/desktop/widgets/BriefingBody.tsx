"use client";

// ShapesOS — Phase 18.1 (WS=desk): the "Today" briefing widget body.
//
// Shows today's briefing exactly as stored (written once each morning by the
// lead agent on the background workload — never generated here). The member
// opts in or out with the switch; turning it on asks for today's briefing
// once (PUT /api/desk/briefing). Labelled "Written by your lead agent".

import { useState } from "react";
import { LogoMark } from "@/components/aos/LogoMark";
import { Switch } from "@/components/aos/Controls";
import { briefingParts } from "@/lib/desktop/briefing";
import type { BriefingData } from "@/lib/desktop/loaders.server";

function writtenAt(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return null;
  }
}

export function BriefingBody({ initial }: { initial: BriefingData }) {
  const [data, setData] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/desk/briefing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await res.json().catch(() => ({}))) as { briefing?: BriefingData; error?: string };
      if (!res.ok || !body.briefing) throw new Error(body.error ?? "The setting was not saved.");
      setData(body.briefing);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The setting was not saved.");
    } finally {
      setSaving(false);
    }
  }

  const parts = data.status === "ready" && data.body ? briefingParts(data.body) : null;
  const at = writtenAt(data.writtenAt);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-0 flex-1">
        {data.status === "off" ? (
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-ink">Get a briefing every morning</p>
            <p className="max-w-[52ch] text-sm text-muted">
              Your lead agent reads your calendar, what needs you, what ran overnight and your key numbers, then writes a short
              briefing once each morning. It uses a little of your AI credit.
            </p>
          </div>
        ) : data.status === "none" || data.status === "pending" ? (
          <p className="text-sm text-muted">{data.status === "pending" ? "Your lead agent is writing today's briefing. It appears here when it's done." : "Today's briefing will be written this morning."}</p>
        ) : data.status === "failed" ? (
          <p className="flex items-start gap-2 text-sm text-failed-text">
            <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
            {data.error ?? "Today's briefing could not be written."}
          </p>
        ) : parts ? (
          <div className="flex flex-col gap-2">
            {parts.lead.map((l) => (
              <p key={l} className="text-base font-medium text-ink">
                {l}
              </p>
            ))}
            {parts.bullets.length ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-md text-ink marker:text-subtle">
                {parts.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed-text">
          <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-2.5">
        <span className="flex items-center gap-2 text-xs text-muted">
          <LogoMark size={16} />
          {data.status === "ready" ? `Written by your lead agent${at ? ` at ${at}` : ""}` : "Written by your lead agent"}
        </span>
        <label className="flex items-center gap-2.5 text-sm font-semibold text-ink">
          Daily briefing
          <Switch checked={data.enabled} onChange={(v) => void toggle(v)} disabled={saving} label="Daily briefing" />
        </label>
      </div>
    </div>
  );
}
