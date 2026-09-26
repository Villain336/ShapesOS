// Marketr — Direct Mail provider cards (Phase 4 T1).
// Client component: Lob + PostGrid connect (test key first), live-key
// fencing, health check, disconnect. Light mode, dense data-first,
// violet accents, Lucide icons only, no emoji.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Mail,
  PlugZap,
  Unplug,
  Activity,
  ShieldAlert,
  FlaskConical,
  BadgeCheck,
} from "lucide-react";

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

interface Notice {
  kind: "ok" | "error";
  message: string;
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

function ModeBadge({ mode }: { mode: "test" | "live" }) {
  return mode === "live" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
      <ShieldAlert className="h-3 w-3" /> LIVE
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
      <FlaskConical className="h-3 w-3" /> test
    </span>
  );
}

function HealthBadge({ health }: { health: string }) {
  const cls =
    health === "healthy"
      ? "bg-emerald-50 text-emerald-700"
      : health === "degraded"
        ? "bg-amber-50 text-amber-700"
        : health === "error"
          ? "bg-red-50 text-red-700"
          : "bg-zinc-100 text-zinc-500";
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{health}</span>;
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
    if (!window.confirm(`Disconnect ${name}? Campaigns will fall back to the fake (test) provider.`)) return;
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
      {notice && (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.kind === "ok"
              ? "border-emerald-200 bg-emerald-50/70 text-emerald-800"
              : "border-red-200 bg-red-50/70 text-red-700"
          }`}
        >
          {notice.message}
        </p>
      )}

      <div className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-[12.5px] text-stone-600">
        <p className="font-medium text-stone-800">Test keys are the default.</p>
        <p className="mt-1">
          A test key renders postcards and letters without physically mailing
          anything. Live keys are visually fenced (red LIVE badge) and can
          only spend behind a human-approved campaign with a bound max spend.
          Webhook endpoints: <code className="font-mono text-xs">/api/webhooks/mail/lob</code> and{" "}
          <code className="font-mono text-xs">/api/webhooks/mail/postgrid</code> — register these
          in the provider dashboard with the webhook secret below.
        </p>
      </div>

      {(["lob", "postgrid"] as const).map((p) => {
        const meta = PROVIDER_META[p];
        const conn = connFor(p);
        const mode = modes[p];
        return (
          <div key={p} className="rounded-xl border border-zinc-200 bg-white/60 p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-violet-700" />
                <h2 className="font-medium">{meta.name}</h2>
                {conn && <ModeBadge mode={conn.mode} />}
              </div>
              {conn && <HealthBadge health={conn.health} />}
            </div>
            <p className="mt-1 text-sm text-zinc-500">{meta.blurb}</p>
            <p className="mt-1 text-xs text-zinc-500">{meta.verifyNote}</p>

            {conn ? (
              <div className="mt-3">
                <dl className="grid gap-2 text-sm md:grid-cols-3">
                  <div>
                    <dt className="text-xs text-zinc-500">Test key</dt>
                    <dd className="font-mono text-xs">{conn.hasTestKey ? "stored" : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-zinc-500">Live key</dt>
                    <dd className="font-mono text-xs">{conn.hasLiveKey ? "stored" : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-zinc-500">Webhook secret</dt>
                    <dd className="font-mono text-xs">{conn.hasWebhookSecret ? "stored" : "—"}</dd>
                  </div>
                </dl>
                {conn.healthMessage && (
                  <p className="mt-2 text-xs text-zinc-500">{conn.healthMessage}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => health(conn.id)}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50"
                  >
                    <Activity className="h-3.5 w-3.5" />
                    {busy === `health-${conn.id}` ? "Checking…" : "Health check"}
                  </button>
                  <button
                    type="button"
                    onClick={() => disconnect(conn.id, meta.name)}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700 hover:bg-red-100 disabled:opacity-50"
                  >
                    <Unplug className="h-3.5 w-3.5" /> Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                {mode === "live" && (
                  <p className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                    <ShieldAlert className="h-4 w-4" /> LIVE — real postage. This key can spend real money.
                  </p>
                )}
                <label className="block text-xs font-medium text-zinc-600">
                  {mode === "live" ? "Live API key" : "Test API key"}
                  <input
                    type="password"
                    value={keys[p]}
                    onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value }))}
                    placeholder={mode === "live" ? "live_…" : "test_…"}
                    autoComplete="off"
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-500 focus:outline-none"
                  />
                </label>
                <label className="block text-xs font-medium text-zinc-600">
                  Webhook secret (optional — signs inbound delivery events)
                  <input
                    type="password"
                    value={webhookSecrets[p]}
                    onChange={(e) => setWebhookSecrets((k) => ({ ...k, [p]: e.target.value }))}
                    placeholder="whsec_…"
                    autoComplete="off"
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-500 focus:outline-none"
                  />
                </label>
                <div className="flex items-center gap-2">
                  <div className="inline-flex rounded-md border border-zinc-200 p-0.5 text-sm">
                    {(["test", "live"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModes((s) => ({ ...s, [p]: m }))}
                        className={`rounded px-2.5 py-1 ${
                          mode === m ? "bg-violet-600 text-white" : "text-zinc-600 hover:bg-zinc-100"
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
                    className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {busy === `connect-${p}` ? (
                      "Validating…"
                    ) : (
                      <>
                        <PlugZap className="h-3.5 w-3.5" /> Connect {mode === "live" ? "live key" : "test key"}
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-start gap-2 rounded-xl border border-zinc-200 bg-white/60 p-4 text-xs text-zinc-500">
        <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-700" />
        <p>
          No provider connected? Campaigns run on the built-in fake provider —
          verification, cost estimates, and sends all simulate deterministically
          and nothing is physically mailed.
        </p>
      </div>
    </div>
  );
}
