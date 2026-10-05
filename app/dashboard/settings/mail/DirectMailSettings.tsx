// Marketr — Direct Mail provider cards (Phase 4 T1).
// Client component: Lob + PostGrid connect (test key first), live-key
// fencing, health check, disconnect. Dense data-first, Lucide icons only,
// no emoji.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Mail,
  PlugZap,
  Unplug,
  Activity,
  ShieldAlert,
  FlaskConical,
  BadgeCheck,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

type NoticeKind = "ok" | "error";
interface Notice {
  kind: NoticeKind;
  message: string;
}

function NoticeBar({ notice }: { notice: Notice | null }) {
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

interface ProviderConn {
  id: string;
  provider: "lob" | "postgrid";
  mode: "test" | "live";
  hasTestKey: boolean;
  hasLiveKey: boolean;
  hasWebhookSecret: boolean;
  health: string;
  healthCheckedAt: string | null;
  healthMessage: string | null;
}

const PROVIDER_META: Record<
  "lob" | "postgrid",
  { name: string; blurb: string; verifyNote: string }
> = {
  lob: {
    name: "Lob",
    blurb: "Best-in-class docs & SDK. Address verification is a paid add-on (~$0.05/lookup).",
    verifyNote: "Verification: paid add-on, surfaced in estimates.",
  },
  postgrid: {
    name: "PostGrid",
    blurb: "Free test tier + webhook simulation. Address verification included free.",
    verifyNote: "Verification: free / included.",
  },
};

// Mode/health are provider states, not agent states — neutral chips.
function ModeBadge({ mode }: { mode: "test" | "live" }) {
  return mode === "live" ? (
    <span className={chipCls}>
      <ShieldAlert size={12} className="text-ink" aria-hidden="true" /> Live
    </span>
  ) : (
    <span className={chipCls}>
      <FlaskConical size={12} className="text-ink" aria-hidden="true" /> Test
    </span>
  );
}

function HealthBadge({ health }: { health: string }) {
  return <span className={chipCls}>{health}</span>;
}

export default function DirectMailSettings() {
  const [conns, setConns] = useState<ProviderConn[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Per-provider connect form state.
  const [keys, setKeys] = useState<Record<string, string>>({ lob: "", postgrid: "" });
  const [webhookSecrets, setWebhookSecrets] = useState<Record<string, string>>({ lob: "", postgrid: "" });
  const [modes, setModes] = useState<Record<string, "test" | "live">>({ lob: "test", postgrid: "test" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/mail/providers");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Load failed");
      setConns(data.providers ?? []);
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Load failed" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connFor = (p: "lob" | "postgrid") => conns.find((c) => c.provider === p) ?? null;

  async function connect(p: "lob" | "postgrid") {
    const key = (keys[p] ?? "").trim();
    if (!key) {
      setNotice({ kind: "error", message: "Paste an API key first." });
      return;
    }
    setBusy(`connect-${p}`);
    setNotice(null);
    try {
      const res = await fetch("/api/mail/providers/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: p,
          key,
          mode: modes[p],
          webhookSecret: (webhookSecrets[p] ?? "").trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Connect failed");
      setKeys((k) => ({ ...k, [p]: "" }));
      setWebhookSecrets((k) => ({ ...k, [p]: "" }));
      setNotice({
        kind: "ok",
        message:
          data.warning ?? `${PROVIDER_META[p].name} connected in test mode (render-only).`,
      });
      await load();
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Connect failed" });
    } finally {
      setBusy(null);
    }
  }

  async function health(id: string) {
    setBusy(`health-${id}`);
    try {
      const res = await fetch(`/api/mail/providers/${id}/health`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? data.error ?? "Health check failed");
      setNotice({ kind: "ok", message: `Health: ${data.health}${data.detail ? ` — ${data.detail}` : ""}` });
      await load();
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Health check failed" });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(id: string, name: string) {
    if (!await confirmAction(`Disconnect ${name}? Campaigns will fall back to the fake (test) provider.`)) return;
    setBusy(`disconnect-${id}`);
    try {
      const res = await fetch(`/api/mail/providers/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Disconnect failed");
      setNotice({ kind: "ok", message: `${name} disconnected.` });
      await load();
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Disconnect failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <NoticeBar notice={notice} />

      <div className="rounded-lg border border-line bg-canvas p-4 text-[12.5px] text-muted">
        <p className="font-medium text-ink">Test keys are the default.</p>
        <p className="mt-1">
          A test key renders postcards and letters without physically mailing
          anything. Live keys are fenced behind a human-approved campaign with
          a bound max spend. Webhook endpoints:{" "}
          <code className="font-mono text-xs">/api/webhooks/mail/lob</code> and{" "}
          <code className="font-mono text-xs">/api/webhooks/mail/postgrid</code> — register these
          in the provider dashboard with the webhook secret below.
        </p>
      </div>

      {(["lob", "postgrid"] as const).map((p) => {
        const meta = PROVIDER_META[p];
        const conn = connFor(p);
        const mode = modes[p];
        return (
          <div key={p} className={cardCls}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Mail size={16} className="text-muted" aria-hidden="true" />
                <h2 className="font-medium text-ink">{meta.name}</h2>
                {conn && <ModeBadge mode={conn.mode} />}
              </div>
              {conn && <HealthBadge health={conn.health} />}
            </div>
            <p className="mt-1 text-sm text-muted">{meta.blurb}</p>
            <p className="mt-1 text-xs text-muted">{meta.verifyNote}</p>

            {conn ? (
              <div className="mt-3">
                <dl className="grid gap-2 text-sm md:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted">Test key</dt>
                    <dd className="font-mono text-xs text-ink">{conn.hasTestKey ? "stored" : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Live key</dt>
                    <dd className="font-mono text-xs text-ink">{conn.hasLiveKey ? "stored" : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Webhook secret</dt>
                    <dd className="font-mono text-xs text-ink">{conn.hasWebhookSecret ? "stored" : "—"}</dd>
                  </div>
                </dl>
                {conn.healthMessage && (
                  <p className="mt-2 text-xs text-muted">{conn.healthMessage}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => health(conn.id)}
                    disabled={busy !== null}
                    className={btnGhost}
                  >
                    <Activity size={14} aria-hidden="true" />
                    {busy === `health-${conn.id}` ? "Checking…" : "Health check"}
                  </button>
                  <button
                    type="button"
                    onClick={() => disconnect(conn.id, meta.name)}
                    disabled={busy !== null}
                    className={btnDeny}
                  >
                    <Unplug size={14} aria-hidden="true" /> Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {mode === "live" && (
                  <p className="flex items-center gap-2 rounded-md border border-line bg-needs-tint px-3 py-2 text-sm font-medium text-ink">
                    <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Warning" />
                    Live — real postage. This key can spend real money.
                  </p>
                )}
                <label className={labelCls}>
                  {mode === "live" ? "Live API key" : "Test API key"}
                  <input
                    type="password"
                    value={keys[p]}
                    onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
                    placeholder={mode === "live" ? "live_…" : "test_…"}
                    autoComplete="off"
                    className={`${inputCls} mt-1 w-full font-mono`}
                  />
                </label>
                <label className={labelCls}>
                  Webhook secret (optional — signs inbound delivery events)
                  <input
                    type="password"
                    value={webhookSecrets[p]}
                    onChange={(e) => setWebhookSecrets((k) => ({ ...k, [p]: e.target.value }))}
                    placeholder="whsec_…"
                    autoComplete="off"
                    className={`${inputCls} mt-1 w-full font-mono`}
                  />
                </label>
                <div className="flex items-center gap-2">
                  <div
                    role="group"
                    aria-label="Key mode"
                    className="inline-flex rounded-full border border-line bg-paper p-0.5 text-sm"
                  >
                    {(["test", "live"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModes((s) => ({ ...s, [p]: m }))}
                        aria-pressed={mode === m}
                        className={`rounded-full px-2.5 py-1 ${
                          mode === m ? "bg-ink text-white" : "text-muted hover:text-ink"
                        }`}
                      >
                        {m === "live" ? "Live" : "Test"}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => connect(p)}
                    disabled={busy !== null || !(keys[p] ?? "").trim()}
                    className={btnPrimary}
                  >
                    {busy === `connect-${p}` ? (
                      "Validating…"
                    ) : (
                      <>
                        <PlugZap size={14} aria-hidden="true" /> Connect {mode === "live" ? "live key" : "test key"}
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className={`${cardCls} flex items-start gap-2 text-xs text-muted`}>
        <BadgeCheck size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <p>
          No provider connected? Campaigns run on the built-in fake provider —
          verification, cost estimates, and sends all simulate deterministically
          and nothing is physically mailed.
        </p>
      </div>
    </div>
  );
}
