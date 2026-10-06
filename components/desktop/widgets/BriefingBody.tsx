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
// Phase 18.1 (integration): the widget's chrome in the person's language and
// time zone (the briefing text itself is the agent's, as written).
import { useI18n } from "@/components/i18n/I18nProvider";

export function BriefingBody({ initial }: { initial: BriefingData }) {
  const { t, format } = useI18n();
  const writtenAt = (iso: string | null) => (iso ? format.date(iso, "time") || null : null);
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
      if (!res.ok || !body.briefing) throw new Error(body.error ?? t("desk.briefing.notSaved"));
      setData(body.briefing);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("desk.briefing.notSaved"));
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
            <p className="text-base font-semibold text-ink">{t("desk.briefing.offTitle")}</p>
            <p className="max-w-[52ch] text-sm text-muted">{t("desk.briefing.offBody")}</p>
          </div>
        ) : data.status === "none" || data.status === "pending" ? (
          <p className="text-sm text-muted">{data.status === "pending" ? t("desk.briefing.pending") : t("desk.briefing.none")}</p>
        ) : data.status === "failed" ? (
          <p className="flex items-start gap-2 text-sm text-failed-text">
            <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
            {data.error ?? t("desk.briefing.failed")}
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
          {data.status === "ready" && at ? t("desk.briefing.writtenAt", { time: at }) : t("desk.briefing.writtenBy")}
        </span>
        <label className="flex items-center gap-2.5 text-sm font-semibold text-ink">
          {t("desk.briefing.toggle")}
          <Switch checked={data.enabled} onChange={(v) => void toggle(v)} disabled={saving} label={t("desk.briefing.toggle")} />
        </label>
      </div>
    </div>
  );
}
