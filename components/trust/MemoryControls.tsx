"use client";

// ShapesOS — Phase 18.3 (WS=trust): see and forget what agents remember.
// scope "me" (Settings → You → Privacy: memories from your own work) or
// "workspace" (Privacy and security → Memory controls, admins). Forget is a
// real delete (DELETE /api/trust/memory/[store]/[id]); it asks first.

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Segmented } from "@/components/aos/Controls";
import { aosButton } from "@/components/aos/button";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { MemoryItem, MemoryStore } from "@/lib/privacy/memory";
import { rowCls, tableCls, tableWrapCls, tdCls, thCls } from "./kit";

const STORES: MemoryStore[] = ["episode", "fact", "learning", "knowledge"];

export function MemoryControls({ scope, initial, initialStore = "episode" }: { scope: "me" | "workspace"; initial: MemoryItem[]; initialStore?: MemoryStore }) {
  const { t, format } = useI18n();
  const [store, setStore] = useState<MemoryStore>(initialStore);
  const [items, setItems] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [first, setFirst] = useState(true);

  useEffect(() => {
    if (first) {
      setFirst(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/trust/memory?scope=${scope}&store=${store}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { items?: MemoryItem[] }) => {
        if (!cancelled) setItems(b.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, scope]);

  async function forget(item: MemoryItem) {
    const ok = await confirmAction({ title: t("trust.memory.forgetConfirm"), confirmLabel: t("trust.memory.forget"), cancelLabel: t("common.cancel"), destructive: true });
    if (!ok) return;
    setBusy(item.id);
    try {
      const res = await fetch(`/api/trust/memory/${item.store}/${encodeURIComponent(item.id)}?scope=${scope}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      toast({ title: t("trust.memory.forgotten") });
    } catch (e) {
      toastError(t("trust.memory.couldNotForget"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Segmented<MemoryStore>
        value={store}
        onChange={setStore}
        label={t("trust.memory.title")}
        options={STORES.map((s) => ({ value: s, label: t(`trust.memory.tabs.${s}`) }))}
      />
      <div className={tableWrapCls} aria-busy={loading}>
        <table className={tableCls} data-testid={`memory-${scope}`}>
          <caption className="sr-only">{t(`trust.memory.tabs.${store}`)}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={thCls}>{t("trust.memory.columns.when")}</th>
              <th scope="col" className={thCls}>{t("trust.memory.columns.what")}</th>
              <th scope="col" className={thCls}>{t("trust.memory.columns.from")}</th>
              <th scope="col" className={thCls}>
                <span className="sr-only">{t("trust.memory.forget")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={`${i.store}:${i.id}`} className={rowCls} data-memory-id={i.id}>
                <td className={`${tdCls} whitespace-nowrap text-muted`}>{format.date(i.at, "dateTime")}</td>
                <td className={tdCls}>
                  <span className="block font-medium text-ink">{i.title}</span>
                  {i.detail ? <span className="block max-w-xl text-xs text-muted">{i.detail}</span> : null}
                </td>
                <td className={`${tdCls} text-muted`}>{i.from ?? "—"}</td>
                <td className={`${tdCls} text-right`}>
                  <button
                    type="button"
                    disabled={busy === i.id}
                    onClick={() => void forget(i)}
                    aria-label={t("trust.memory.forgetLabel", { title: i.title.slice(0, 60) })}
                    className={aosButton({ variant: "deny", size: "xs" })}
                  >
                    <Trash2 size={14} aria-hidden />
                    {t("trust.memory.forget")}
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && !loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted">
                  {scope === "me" ? t("trust.privacy.memory.empty") : t("trust.memory.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
