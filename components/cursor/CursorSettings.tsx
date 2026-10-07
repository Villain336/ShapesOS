"use client";

// ShapesOS — Phase 19A (WS=server): Settings → You → Cursor.
// The voice (from the TTS provider's own list — GET/PUT /api/cursor/voices;
// never an invented id), talk minutes used / included this month, what the
// cursor runs on (neutral pills: these are not agent states), and the
// ShapesOS Desktop download. House style: white cards with a hairline,
// 44px controls, black primary pill, tokens only, sentence case.

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Download } from "lucide-react";
import { NeutralBadge } from "@/components/aos/StatusBadge";
import { aosButton } from "@/components/aos/button";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";

const selectCls =
  "h-control w-full min-w-[16rem] rounded-md border-[1.5px] border-control bg-paper px-3 text-base text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] disabled:bg-disabled disabled:text-disabled-fg sm:w-auto";

export interface CursorSettingsProps {
  talk: { used: number; included: number | null };
  providers: { stt: string; tts: string; vision: string };
}

const PROVIDER_NAMES: Record<string, string> = {
  assemblyai: "AssemblyAI",
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
  voicestudio: "VoiceStudio",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

function Card({ children, labelledBy }: { children: React.ReactNode; labelledBy: string }) {
  return (
    <section aria-labelledby={labelledBy} className="rounded-lg bg-paper p-5 shadow-hairline">
      {children}
    </section>
  );
}

export function CursorSettings({ talk, providers }: CursorSettingsProps) {
  const { t } = useI18n();
  const ids = { voice: useId(), talk: useId(), prov: useId(), desk: useId(), select: useId(), help: useId() };
  const [voices, setVoices] = useState<Array<{ id: string; label: string }> | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [listError, setListError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (providers.tts === "none") return;
    let live = true;
    fetch("/api/cursor/voices")
      .then(async (r) => {
        const b = (await r.json().catch(() => ({}))) as { voices?: Array<{ id: string; label: string }>; selected?: { id: string } | null; error?: string | null };
        if (!live) return;
        if (!r.ok) throw new Error("list");
        setVoices(b.voices ?? []);
        setSelected(b.selected?.id ?? "");
        if (b.error) setListError(t("cursor.voice.listFailed"));
      })
      .catch(() => {
        if (live) {
          setVoices([]);
          setListError(t("cursor.voice.listFailed"));
        }
      });
    return () => {
      live = false;
    };
  }, [providers.tts, t]);

  async function choose(id: string) {
    const before = selected;
    setSelected(id);
    if (!id) return;
    setSaving(true);
    try {
      const r = await fetch("/api/cursor/voices", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: id }) });
      const b = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!r.ok) throw new Error(b.error?.message ?? `HTTP ${r.status}`);
      toast({ title: t("cursor.voice.saved"), status: "done" });
    } catch (e) {
      setSelected(before);
      toastError(t("cursor.voice.saveFailed"), e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  const status = (p: string) => (p === "none" ? t("cursor.providers.notSet") : p === "mock" ? t("cursor.providers.test") : `${t("cursor.providers.ready")} · ${PROVIDER_NAMES[p] ?? p}`);

  return (
    <>
      <Card labelledBy={ids.voice}>
        <h2 id={ids.voice} className="aos-subheading text-ink">
          {t("cursor.voice.title")}
        </h2>
        <p id={ids.help} className="mt-1 text-sm text-muted">
          {t("cursor.voice.help")}
        </p>
        <div className="mt-4">
          {providers.tts === "none" ? (
            <p className="text-sm text-muted">{t("cursor.voice.notConfigured")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.select} className="text-sm font-semibold text-ink">
                {t("cursor.voice.label")}
              </label>
              <select
                id={ids.select}
                aria-describedby={ids.help}
                className={selectCls}
                value={selected}
                disabled={voices === null || saving || (voices?.length ?? 0) === 0}
                onChange={(e) => void choose(e.target.value)}
              >
                <option value="">{voices === null ? t("cursor.voice.loading") : t("cursor.voice.default")}</option>
                {(voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <p className="text-sm text-muted">
                {providers.tts === "mock" ? t("cursor.voice.mock") : t("cursor.voice.provider", { name: PROVIDER_NAMES[providers.tts] ?? providers.tts })}
              </p>
              {listError ? <p className="text-sm text-muted">{listError}</p> : null}
            </div>
          )}
        </div>
      </Card>

      <Card labelledBy={ids.talk}>
        <h2 id={ids.talk} className="aos-subheading text-ink">
          {t("cursor.talk.title")}
        </h2>
        <p className="mt-1 text-sm text-muted">{t("cursor.talk.help")}</p>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-base font-semibold text-ink tabular-nums">{t("cursor.talk.used", { used: talk.used })}</p>
          <p className="text-sm text-muted tabular-nums">{talk.included === null ? t("cursor.talk.unlimited") : t("cursor.talk.included", { included: talk.included })}</p>
        </div>
        <Link href="/dashboard/settings/usage" className={aosButton({ variant: "quiet", size: "sm", className: "mt-3 -ml-3" })}>
          {t("cursor.talk.usage")}
        </Link>
      </Card>

      <Card labelledBy={ids.prov}>
        <h2 id={ids.prov} className="aos-subheading text-ink">
          {t("cursor.providers.title")}
        </h2>
        <ul className="mt-3 divide-y divide-line">
          {(
            [
              ["speechIn", providers.stt],
              ["speechOut", providers.tts],
              ["brain", providers.vision],
            ] as const
          ).map(([k, p]) => (
            <li key={k} className="flex min-h-row items-center justify-between gap-3 py-2">
              <span className="text-base text-ink">{t(`cursor.providers.${k}`)}</span>
              <NeutralBadge label={status(p)} size="sm" />
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">{t("cursor.safety")}</p>
      </Card>

      <Card labelledBy={ids.desk}>
        <h2 id={ids.desk} className="aos-subheading text-ink">
          {t("cursor.desktop.title")}
        </h2>
        <p className="mt-1 text-sm text-muted">{t("cursor.desktop.body")}</p>
        <Link href="/download" className={aosButton({ variant: "primary", size: "md", className: "mt-4" })} data-cursor-id="kit:cursor-settings:download" data-cursor-label={t("cursor.desktop.download")} data-cursor-role="link">
          <Download className="size-4" aria-hidden />
          {t("cursor.desktop.download")}
        </Link>
      </Card>
    </>
  );
}

export default CursorSettings;
