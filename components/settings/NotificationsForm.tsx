// Marketr — notification defaults form (milestone 21, part D1).
// Client component: edits notificationDefaults (email digest toggle + default
// alert channels), saved via PUT workspace settings.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { SwitchRow } from "@/components/aos/Controls";

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

interface NotificationDefaults {
  emailDigest: boolean;
  defaultChannels: string[];
}

const DEFAULTS: NotificationDefaults = {
  emailDigest: true,
  defaultChannels: ["email"],
};

const CHANNELS = ["email", "slack", "telegram"] as const;

const CHANNEL_COPY: Record<(typeof CHANNELS)[number], { title: string; description: string }> = {
  email: { title: "Email", description: "New alert rules notify by email" },
  slack: { title: "Slack", description: "New alert rules post to Slack" },
  telegram: { title: "Telegram", description: "New alert rules message Telegram" },
};

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
        <div className="mt-4 flex max-w-xl flex-col gap-4">
          <div className="divide-y divide-line rounded-lg border border-line bg-paper">
            <SwitchRow
              title="Email digest"
              description="Bundle routine notifications into a periodic digest instead of one email each"
              checked={prefs.emailDigest}
              onChange={(v) => setPrefs({ ...prefs, emailDigest: v })}
              disabled={busy}
            />
          </div>
          <section aria-labelledby="notif-channels-h">
            <h3 id="notif-channels-h" className="text-sm font-semibold text-ink">
              Default alert channels
            </h3>
            <div className="mt-2 divide-y divide-line rounded-lg border border-line bg-paper">
              {CHANNELS.map((ch) => (
                <SwitchRow
                  key={ch}
                  title={CHANNEL_COPY[ch].title}
                  description={CHANNEL_COPY[ch].description}
                  checked={prefs.defaultChannels.includes(ch)}
                  onChange={() => toggleChannel(ch)}
                  disabled={busy}
                />
              ))}
            </div>
          </section>
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
