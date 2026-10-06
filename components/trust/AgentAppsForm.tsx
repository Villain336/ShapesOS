"use client";

// ShapesOS — Phase 18.3 (WS=trust): agent app access (Settings → Privacy and
// security). One switch per app (tool group): on = agents may use it. Saves
// the whole list (PUT /api/trust/agent-apps); the server audits each change
// and enforces it in the grant arithmetic and at execute time.

import { useId, useState } from "react";
import { Lock } from "lucide-react";
import { Switch } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";

export function AgentAppsForm({ initialBlocked, blockable, canEdit }: { initialBlocked: string[]; blockable: string[]; canEdit: boolean }) {
  const { t } = useI18n();
  const [blocked, setBlocked] = useState<string[]>(initialBlocked);
  const [saving, setSaving] = useState<string | null>(null);
  const baseId = useId();
  const label = (g: string) => t(`trust.apps.groups.${g}.label` as MessageKey);

  async function toggle(group: string, allow: boolean) {
    const before = blocked;
    const next = allow ? blocked.filter((g) => g !== group) : [...new Set([...blocked, group])];
    setBlocked(next);
    setSaving(group);
    try {
      const res = await fetch("/api/trust/agent-apps", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { blocked?: string[]; error?: string };
      if (!res.ok || !body.blocked) throw new Error(body.error ?? `HTTP ${res.status}`);
      setBlocked(body.blocked);
      toast({ title: t("trust.apps.saved"), description: `${label(group)}: ${allow ? t("trust.apps.allowed") : t("trust.apps.blocked")}` });
    } catch (e) {
      setBlocked(before);
      toastError(t("trust.apps.couldNotSave"), e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-lg bg-paper px-4 py-3 text-sm text-muted shadow-hairline sm:px-5">{t("trust.apps.help")}</p>
      {!canEdit ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Lock size={14} aria-hidden />
          {t("trust.apps.adminsOnly")}
        </p>
      ) : null}
      <ul className="divide-y divide-line rounded-lg bg-paper shadow-hairline" aria-label={t("trust.apps.title")}>
        <li className="flex min-h-row items-center gap-4 px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-ink">{label("workspace")}</p>
            <p className="text-sm text-muted">{t("trust.apps.alwaysOn")}</p>
          </div>
          <span className="text-sm font-semibold text-muted">{t("trust.apps.allowed")}</span>
        </li>
        {blockable.map((g) => {
          const allowed = !blocked.includes(g);
          const id = `${baseId}-${g}`;
          return (
            <li key={g} className="flex min-h-row items-center gap-4 px-4 py-3 sm:px-5" data-app-group={g}>
              <div className="min-w-0 flex-1">
                <p id={`${id}-l`} className="text-base font-semibold text-ink">
                  {label(g)}
                </p>
                <p id={`${id}-d`} className="text-sm text-muted">
                  {t(`trust.apps.groups.${g}.help` as MessageKey)}
                </p>
              </div>
              <span className="hidden text-sm text-muted sm:inline" aria-hidden>
                {allowed ? t("trust.apps.allowed") : t("trust.apps.blocked")}
              </span>
              <Switch
                checked={allowed}
                disabled={!canEdit || saving !== null}
                labelledBy={`${id}-l`}
                describedBy={`${id}-d`}
                onChange={(v) => void toggle(g, v)}
              />
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-muted">{t("trust.apps.audited")}</p>
    </div>
  );
}
