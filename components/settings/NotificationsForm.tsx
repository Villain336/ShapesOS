// Marketr — notification defaults form (milestone 21, part D1).
// Client component: edits notificationDefaults (email digest toggle + default
// alert channels), saved via PUT workspace settings.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Notice,
  btnCls,
  cardCls,
  primaryBtnCls,
  type NoticeState,
} from "./ui";

interface NotificationDefaults {
  emailDigest: boolean;
  defaultChannels: string[];
}

const DEFAULTS: NotificationDefaults = {
  emailDigest: true,
  defaultChannels: ["email"],
};

const CHANNELS = ["email", "slack", "telegram"] as const;

export default function NotificationsForm({ workspaceId }: { workspaceId: string }) {
  const [prefs, setPrefs] = useState<NotificationDefaults>(DEFAULTS);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    const r = await fetch(`/api/settings/workspace?${q}`);
    if (r.ok) {
      const j = await r.json();
      const n = (j.settings?.notificationDefaults ?? {}) as Partial<NotificationDefaults>;
      setPrefs({ ...DEFAULTS, ...n });
    }
    setLoaded(true);
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleChannel(ch: string) {
    setPrefs((p) => ({
      ...p,
      defaultChannels: p.defaultChannels.includes(ch)
        ? p.defaultChannels.filter((c) => c !== ch)
        : [...p.defaultChannels, ch],
    }));
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, notificationDefaults: prefs }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message: typeof j.error === "string" ? j.error : "Save failed.",
        });
        return;
      }
      const n = (j.settings?.notificationDefaults ?? {}) as Partial<NotificationDefaults>;
      setPrefs({ ...DEFAULTS, ...n });
      setNotice({ kind: "ok", message: "Notification defaults saved." });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, notificationDefaults: DEFAULTS }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message: typeof j.error === "string" ? j.error : "Reset failed.",
        });
        return;
      }
      setPrefs(DEFAULTS);
      setNotice({ kind: "ok", message: "Notification defaults reset." });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <Notice notice={notice} />
      <div className={cardCls}>
        <h2 className="font-medium">Notification defaults</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Defaults applied to new alert rules and workspace digests. Channels
          themselves are configured under Settings → Alerts.
        </p>
        <div className="mt-4 flex max-w-xl flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-3">
            <input
              type="checkbox"
              checked={prefs.emailDigest}
              onChange={(e) => setPrefs({ ...prefs, emailDigest: e.target.checked })}
              className="mt-1 accent-[#0E7C66]"
            />
            <span>
              <span className="block text-sm font-medium">Email digest</span>
              <span className="block text-xs text-zinc-500">
                Bundle routine notifications into a periodic email digest instead
                of sending each one immediately.
              </span>
            </span>
          </label>
          <fieldset>
            <legend className="text-sm font-medium">Default alert channels</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {CHANNELS.map((ch) => (
                <label
                  key={ch}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={prefs.defaultChannels.includes(ch)}
                    onChange={() => toggleChannel(ch)}
                    className="accent-[#0E7C66]"
                  />
                  {ch}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={save} disabled={busy} className={primaryBtnCls}>
            {busy ? "Saving…" : "Save defaults"}
          </button>
          <button onClick={reset} disabled={busy} className={btnCls}>
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
