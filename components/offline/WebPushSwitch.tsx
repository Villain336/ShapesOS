"use client";

// ShapesOS — Phase 18.3 (WS=flow): "Notifications on this browser" (Web
// Push). Subscribes THIS browser through the service worker
// (pushManager.subscribe with the server's VAPID public key) and stores the
// subscription for the signed-in person (POST /api/push/web). Which
// notifications become pushes is the person's notification channels
// (lib/notifications, WS=trust); this only connects the browser. Without
// VAPID keys on the server the switch is hidden and the reason is shown.

import { useCallback, useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { aosButton, SwitchRow } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";

type Config = { configured: boolean; publicKey: string | null; reason?: string; subscriptions: Array<{ id: string }> };

function keyBytes(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function WebPushSwitch() {
  const { t } = useI18n();
  const [config, setConfig] = useState<Config | null>(null);
  const [supported, setSupported] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/push/web", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setConfig((await res.json()) as Config);
    const ok = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupported(ok);
    if (ok) {
      const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
      const sub = await reg?.pushManager.getSubscription().catch(() => null);
      setSubscribed(!!sub);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function turnOn() {
    if (!config?.publicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toastError(t("flow.webPush.denied"));
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) as BufferSource });
      const res = await fetch("/api/push/web", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (!res.ok) {
        await sub.unsubscribe().catch(() => undefined);
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSubscribed(true);
      toast({ title: t("flow.webPush.on"), status: "done" });
    } catch (err) {
      toastError(t("flow.webPush.failed"), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/web", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast({ title: t("flow.webPush.off"), status: "done" });
    } catch (err) {
      toastError(t("flow.webPush.failed"), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function test() {
    setBusy(true);
    const res = await fetch("/api/push/web/test", { method: "POST" }).catch(() => null);
    setBusy(false);
    const j = (await res?.json().catch(() => ({}))) as { sent?: number; error?: string } | undefined;
    if (!res?.ok) toastError(t("flow.webPush.failed"), j?.error);
    else toast({ title: t("flow.webPush.testSent", { count: j?.sent ?? 0 }), status: "done" });
  }

  return (
    <section aria-labelledby="web-push-title" className="flex flex-col gap-2 rounded-lg bg-paper shadow-hairline">
      <div className="flex items-center gap-2 px-4 pt-4">
        <BellRing className="size-4 text-muted" aria-hidden />
        <h2 id="web-push-title" className="text-md font-semibold text-ink">
          {t("flow.webPush.title")}
        </h2>
      </div>
      {!config ? (
        <p className="px-4 pb-4 text-sm text-muted">{t("common.loading")}</p>
      ) : !config.configured ? (
        <p className="mx-4 mb-4 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">{t("flow.webPush.notConfigured", { reason: config.reason ?? "" })}</p>
      ) : !supported ? (
        <p className="mx-4 mb-4 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">{t("flow.webPush.unsupported")}</p>
      ) : (
        <>
          <SwitchRow title={t("flow.webPush.switch")} description={t("flow.webPush.switchHelp")} checked={subscribed} disabled={busy} onChange={(v) => void (v ? turnOn() : turnOff())} />
          <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
            <span className="text-sm text-muted">{t("flow.webPush.browsers", { count: config.subscriptions.length })}</span>
            {subscribed ? (
              <button type="button" disabled={busy} onClick={() => void test()} className={aosButton({ variant: "secondary", size: "xs" })}>
                {t("flow.webPush.test")}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

export default WebPushSwitch;
