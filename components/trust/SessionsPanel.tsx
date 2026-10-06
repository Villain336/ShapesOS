"use client";

// ShapesOS — Phase 18.3 (WS=trust): where you're signed in (Settings → You →
// Privacy). Each row is a user_sessions row of YOURS; "Sign out" revokes it
// (that browser is signed out on its next request) and "Sign out other
// sessions" revokes all but this one. Phones with the app (push devices) are
// listed and removable too.

import { useState } from "react";
import { LogOut, Monitor, Smartphone } from "lucide-react";
import { aosButton } from "@/components/aos/button";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { SessionView } from "@/lib/auth/sessions";
import type { PushDeviceView } from "@/lib/push/devices";
import { cardCls, rowCls, tableCls, tableWrapCls, tdCls, thCls } from "./kit";

export function SessionsPanel({ initial, currentListed }: { initial: SessionView[]; currentListed: boolean }) {
  const { t, format } = useI18n();
  const [sessions, setSessions] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const others = sessions.filter((s) => !s.current);

  async function signOut(s: SessionView) {
    setBusy(s.id);
    try {
      const res = await fetch(`/api/trust/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
      toast({ title: t("trust.privacy.sessions.signedOut") });
      if (s.current) window.location.assign("/login");
    } catch (e) {
      toastError(t("trust.privacy.sessions.couldNotSignOut"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function signOutOthers() {
    const ok = await confirmAction({ title: t("trust.privacy.sessions.signOutOthers"), confirmLabel: t("trust.privacy.sessions.signOut"), cancelLabel: t("common.cancel"), destructive: true });
    if (!ok) return;
    setBusy("others");
    try {
      const res = await fetch("/api/trust/sessions/others", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { revoked?: number };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSessions((prev) => prev.filter((x) => x.current));
      toast({ title: t("trust.privacy.sessions.signedOut"), description: t("trust.privacy.sessions.signedOutOthers", { count: body.revoked ?? 0 }) });
    } catch (e) {
      toastError(t("trust.privacy.sessions.couldNotSignOut"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {!currentListed ? <p className={`${cardCls} px-4 py-3 text-sm text-muted`}>{t("trust.privacy.sessions.legacy")}</p> : null}
      <div className={tableWrapCls}>
        <table className={tableCls} data-testid="sessions">
          <caption className="sr-only">{t("trust.privacy.sessions.title")}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={thCls}>{t("trust.privacy.sessions.device")}</th>
              <th scope="col" className={thCls}>{t("trust.privacy.sessions.signedIn")}</th>
              <th scope="col" className={thCls}>{t("trust.privacy.sessions.lastActive")}</th>
              <th scope="col" className={thCls}>{t("trust.privacy.sessions.network")}</th>
              <th scope="col" className={thCls}>
                <span className="sr-only">{t("trust.privacy.sessions.signOut")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const name = s.deviceLabel ?? t("trust.privacy.sessions.unknownDevice");
              return (
                <tr key={s.id} className={rowCls} data-session={s.current ? "current" : "other"}>
                  <td className={tdCls}>
                    <span className="inline-flex items-center gap-2 font-medium text-ink">
                      {/iPhone|iPad|Android|app/.test(name) ? <Smartphone size={16} aria-hidden /> : <Monitor size={16} aria-hidden />}
                      {name}
                      {s.current ? (
                        <span className="inline-flex h-6 items-center rounded-full bg-ink px-2.5 text-xs font-semibold text-paper">{t("trust.privacy.sessions.thisDevice")}</span>
                      ) : null}
                    </span>
                  </td>
                  <td className={`${tdCls} whitespace-nowrap text-muted`}>{format.date(s.createdAt, "dateTime")}</td>
                  <td className={`${tdCls} whitespace-nowrap text-muted`}>{format.relative(s.lastSeenAt)}</td>
                  <td className={`${tdCls} font-mono text-xs text-muted`}>{s.ipPrefix ?? "—"}</td>
                  <td className={`${tdCls} text-right`}>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void signOut(s)}
                      aria-label={t("trust.privacy.sessions.signOutLabel", { device: name })}
                      className={aosButton({ variant: "secondary", size: "xs" })}
                    >
                      <LogOut size={14} aria-hidden />
                      {t("trust.privacy.sessions.signOut")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {others.length === 0 ? <p className="text-sm text-muted">{t("trust.privacy.sessions.empty")}</p> : null}
      <div>
        <button type="button" disabled={busy !== null} onClick={() => void signOutOthers()} className={aosButton({ variant: "deny" })} data-testid="sign-out-others">
          <LogOut size={16} aria-hidden />
          {t("trust.privacy.sessions.signOutOthers")}
        </button>
      </div>
    </div>
  );
}

export function DevicesPanel({ initial }: { initial: Array<Pick<PushDeviceView, "id" | "platform" | "deviceName" | "tokenHint" | "lastSeenAt">> }) {
  const { t, format } = useI18n();
  const [devices, setDevices] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  async function remove(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/trust/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      toast({ title: t("trust.privacy.devices.removed") });
    } catch (e) {
      toastError(t("trust.privacy.devices.couldNotRemove"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }
  if (devices.length === 0) return <p className={`${cardCls} px-4 py-3 text-sm text-muted`}>{t("trust.privacy.devices.empty")}</p>;
  return (
    <ul className={`${cardCls} divide-y divide-line`}>
      {devices.map((d) => {
        const name = d.deviceName ?? `${d.platform === "ios" ? "iPhone" : "Android"} ·${d.tokenHint}`;
        return (
          <li key={d.id} className="flex min-h-row items-center gap-3 px-4 py-2.5 sm:px-5">
            <Smartphone size={16} aria-hidden className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{name}</span>
              <span className="block text-xs text-muted">
                {t("trust.privacy.devices.lastSeen")} {format.relative(d.lastSeenAt)}
              </span>
            </span>
            <button type="button" disabled={busy === d.id} onClick={() => void remove(d.id)} aria-label={t("trust.privacy.devices.removeLabel", { device: name })} className={aosButton({ variant: "secondary", size: "xs" })}>
              {t("trust.privacy.devices.remove")}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
