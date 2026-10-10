"use client";

// ShapesOS — Phase 21A round 2 (WS=agentweb): your browsing memory.
// Off until you turn it on; yours alone; never the part of an address after the question mark;
// per-item forget; the excluded-sites list; retention. Not an agent state, so neutral badges only.

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, Trash2, X } from "lucide-react";
import { aosButton } from "@/components/aos";
import { SwitchRow } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { MemoryItem, MemorySettings } from "@/lib/agentweb/memory/store";

const RETENTION_CHOICES = [7, 30, 90, 180, 365];

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch("/api/agentweb/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export function MemoryPanel({ initialSettings, initialItems, focusItem }: { initialSettings: MemorySettings; initialItems: MemoryItem[]; focusItem?: string | null }) {
  const { t, format } = useI18n();
  const [settings, setSettings] = useState(initialSettings);
  const [items, setItems] = useState(initialItems);
  const [q, setQ] = useState("");
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const focusRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center" });
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((i) => `${i.title} ${i.url} ${i.excerpt}`.toLowerCase().includes(needle)) : items;
  }, [items, q]);

  async function save(patch: Partial<MemorySettings>) {
    setBusy("settings");
    try {
      const { ok, json } = await post({ op: "settings", patch });
      if (!ok) return toastError(t("memoryApp.failed"), String(json.error ?? ""));
      setSettings(json.settings as MemorySettings);
      const n = Number(json.forgotten ?? 0);
      if (n > 0) {
        // The server removed them; refresh the list from it.
        const res = await fetch("/api/agentweb/memory", { cache: "no-store" });
        if (res.ok) setItems(((await res.json()) as { items: MemoryItem[] }).items);
      }
      toast({ title: n > 0 ? t("memoryApp.forgottenOnExclude", { n }) : t("memoryApp.savedSettings"), status: "done" });
    } finally {
      setBusy(null);
    }
  }

  async function forget(item: MemoryItem) {
    setBusy(`forget:${item.id}`);
    try {
      const { ok, json } = await post({ op: "forget", id: item.id });
      if (!ok) return toastError(t("memoryApp.failed"), String(json.error ?? ""));
      setItems((all) => all.filter((i) => i.id !== item.id));
      toast({ title: t("memoryApp.forgotten"), status: "done" });
    } finally {
      setBusy(null);
    }
  }

  async function forgetEverything() {
    if (!(await confirmAction({ title: t("memoryApp.forgetAllConfirm"), confirmLabel: t("memoryApp.forgetAll"), destructive: true }))) return;
    setBusy("all");
    try {
      const { ok, json } = await post({ op: "forget_all" });
      if (!ok) return toastError(t("memoryApp.failed"), String(json.error ?? ""));
      setItems([]);
      toast({ title: t("memoryApp.forgotAll", { n: Number(json.forgotten ?? 0) }), status: "done" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="mem-title" className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 id="mem-title" className="aos-subheading">{t("memoryApp.title")}</h2>
        <p className="mt-1 max-w-[72ch] text-sm text-muted">{t("memoryApp.help")}</p>
      </div>

      <div className="flex flex-col divide-y divide-line rounded-lg bg-paper shadow-hairline">
        <SwitchRow title={t("memoryApp.enable")} description={t("memoryApp.enableHelp")} checked={settings.enabled} disabled={busy !== null} onChange={(v) => void save({ enabled: v })} />
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <label htmlFor="mem-retention" className="text-md leading-5 font-semibold text-ink">{t("memoryApp.retention")}</label>
            <p className="text-xs text-muted">{t("memoryApp.retentionHelp")}</p>
          </div>
          <select
            id="mem-retention"
            value={settings.retentionDays}
            disabled={busy !== null}
            onChange={(e) => void save({ retentionDays: Number(e.target.value) })}
            className="h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
          >
            {[...new Set([...RETENTION_CHOICES, settings.retentionDays])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>{t("memoryApp.retentionDays", { n })}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <div>
            <p className="text-md leading-5 font-semibold text-ink" id="mem-excl-l">{t("memoryApp.excluded")}</p>
            <p className="text-xs text-muted">{t("memoryApp.excludedHelp")}</p>
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const s = site.trim();
              if (!s) return;
              setSite("");
              void save({ excludedSites: [...settings.excludedSites, s] });
            }}
          >
            <label className="sr-only" htmlFor="mem-site">{t("memoryApp.excluded")}</label>
            <input id="mem-site" value={site} onChange={(e) => setSite(e.target.value)} placeholder={t("memoryApp.excludedPlaceholder")} maxLength={200} className="h-control min-w-[14rem] flex-1 rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
            <button type="submit" disabled={busy !== null || !site.trim()} className={aosButton({ variant: "secondary", size: "md" })}>{t("memoryApp.excludedAdd")}</button>
          </form>
          {settings.excludedSites.length === 0 ? (
            <p className="text-sm text-muted">{t("memoryApp.excludedNone")}</p>
          ) : (
            <ul aria-labelledby="mem-excl-l" className="flex flex-wrap gap-1.5">
              {settings.excludedSites.map((s) => (
                <li key={s} className="inline-flex items-center gap-1 rounded-full bg-canvas py-1 pr-1 pl-3 text-sm text-ink">
                  <span className="font-mono text-xs">{s}</span>
                  <button type="button" aria-label={t("memoryApp.excludedRemove", { site: s })} disabled={busy !== null} onClick={() => void save({ excludedSites: settings.excludedSites.filter((x) => x !== s) })} className="inline-flex size-6 items-center justify-center rounded-full hover:bg-hover">
                    <X className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="aos-subheading">{t("memoryApp.items")}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative block">
              <span className="sr-only">{t("memoryApp.search")}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("memoryApp.search")} className="h-control w-56 rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
            </label>
            <button type="button" disabled={busy !== null || items.length === 0} onClick={() => void forgetEverything()} className={aosButton({ variant: "deny", size: "md" })}>
              {busy === "all" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
              {t("memoryApp.forgetAll")}
            </button>
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
            <p className="text-md font-semibold text-ink">{settings.enabled ? t("memoryApp.empty") : t("memoryApp.emptyOff")}</p>
            <p className="max-w-[48ch] text-sm text-muted">{t("memoryApp.emptyBody")}</p>
          </div>
        ) : (
          <div className="-mx-3 overflow-x-auto sm:-mx-4">
            <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
              <caption className="sr-only">{t("memoryApp.items")}</caption>
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th scope="col" className="px-3 py-2 sm:pl-4">{t("memoryApp.columns.page")}</th>
                  <th scope="col" className="px-3 py-2">{t("memoryApp.columns.seen")}</th>
                  <th scope="col" className="px-3 py-2">{t("memoryApp.columns.expires")}</th>
                  <th scope="col" className="px-3 py-2 sm:pr-4"><span className="sr-only">{t("memoryApp.columns.forget")}</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id} ref={i.id === focusItem ? focusRef : undefined} aria-current={i.id === focusItem ? "true" : undefined} className={`border-b border-line align-top last:border-b-0 ${i.id === focusItem ? "bg-hover-paper" : "hover:bg-hover-paper"}`}>
                    <td className="max-w-[28rem] px-3 py-2 sm:pl-4">
                      <a href={i.url} target="_blank" rel="noopener noreferrer" className="block truncate font-semibold text-ink underline-offset-2 hover:underline">{i.title}</a>
                      <span className="block truncate font-mono text-xs text-muted">{i.url.replace(/^https?:\/\//, "")}</span>
                      <span className="mt-0.5 line-clamp-2 text-xs text-muted">{i.excerpt}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted">
                      {format.date(i.lastSeenAt, "date")}
                      {i.seenCount > 1 ? <span className="block text-xs">{t("memoryApp.seenTimes", { n: i.seenCount })}</span> : null}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted">{format.date(i.retentionUntil, "date")}</td>
                    <td className="px-3 py-2 text-right sm:pr-4">
                      <button type="button" disabled={busy !== null} aria-label={t("memoryApp.forgetLabel", { title: i.title })} onClick={() => void forget(i)} className={aosButton({ variant: "secondary", size: "xs" })}>
                        {busy === `forget:${i.id}` ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                        {t("memoryApp.forget")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted">{t("memoryApp.privacy")}</p>
      </div>
    </section>
  );
}
