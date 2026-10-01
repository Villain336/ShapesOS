// Marketr — notification defaults form (milestone 21, part D1).
// Client component: edits notificationDefaults (email digest toggle + default
// alert channels), saved via PUT workspace settings.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <Check size={14} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-ink" : "bg-disabled-fg"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[21px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

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

  if (!loaded) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <Notice notice={notice} />
      <div className={cardCls}>
        <h2 className="font-medium text-ink">Notification defaults</h2>
        <p className="mt-1 text-sm text-muted">
          Defaults applied to new alert rules and workspace digests. Channels
          themselves are configured under Settings → Alerts.
        </p>
        <div className="mt-4 flex max-w-xl flex-col gap-3">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-paper px-3 py-3">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">Email digest</span>
              <span className="block text-xs text-muted">
                Bundle routine notifications into a periodic email digest instead
                of sending each one immediately.
              </span>
            </span>
            <Switch
              checked={prefs.emailDigest}
              onChange={(v) => setPrefs({ ...prefs, emailDigest: v })}
              label="Email digest"
            />
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-ink">Default alert channels</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {CHANNELS.map((ch) => {
                const on = prefs.defaultChannels.includes(ch);
                return (
                  <button
                    key={ch}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${ch} alerts`}
                    onClick={() => toggleChannel(ch)}
                    className={`inline-flex h-[26px] items-center gap-2 rounded-full px-3 text-sm font-medium transition-colors ${
                      on ? "bg-ink text-white" : "bg-canvas text-muted"
                    }`}
                  >
                    {ch}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={save} disabled={busy} className={btnPrimary}>
            {busy ? "Saving…" : "Save defaults"}
          </button>
          <button onClick={reset} disabled={busy} className={btnGhost}>
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  );
}
