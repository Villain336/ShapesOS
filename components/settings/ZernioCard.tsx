// ShapesOS — Phase 15.4 (zernio): the Zernio card on Settings → Connectors.
//
// One platform key (LIVE / pre-added), one Zernio profile per workspace. The
// card lists the 16 posting platforms with "Connect an account", the 7 ad
// networks with "Connect ad account" (OpenAI Ads takes a ChatGPT Ads Manager
// key; X Ads needs one of this workspace's X accounts), and the connected
// accounts with their health from Zernio. Connection states are provider
// states, not agent states — neutral chips (DESIGN.md), never the status
// colours.

"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderPlus, KeyRound, Megaphone, Plug, RefreshCw, Share2 } from "lucide-react";

const cardCls = "rounded-xl border border-line bg-paper p-5";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const pillCls =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-3 text-sm font-medium text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

interface Platform {
  key: string;
  label: string;
  closedBeta: boolean;
}
interface AdNetwork {
  key: string;
  label: string;
  connect: "oauth" | "credentials";
  needsPostingAccount: string | null;
}
interface Account {
  accountId: string;
  platform: string;
  category: string;
  username: string | null;
  displayName: string | null;
  status: string;
  health: string;
  issues: string[];
}
interface Status {
  mode: "live" | "mock" | "off";
  platforms: Platform[];
  adNetworks: AdNetwork[];
  profileId: string | null;
  accounts: Account[];
  rateLimit: { limit: number | null; remaining: number | null } | null;
}

const STATUS_LABEL: Record<string, string> = {
  connected: "connected",
  needs_reconnect: "needs reconnecting",
  disconnected: "disconnected",
};

export default function ZernioCard({
  workspaceId,
  notice,
  errorNotice,
}: {
  workspaceId: string;
  notice: string | null;
  errorNotice: string | null;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    errorNotice ? { kind: "error", text: errorNotice } : notice ? { kind: "ok", text: notice } : null,
  );
  const [openAiKey, setOpenAiKey] = useState("");
  const [openAiOpen, setOpenAiOpen] = useState(false);
  const [xAccount, setXAccount] = useState("");

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;
  const load = useCallback(async () => {
    setLoadError(null);
    const r = await fetch(`/api/zernio?${q}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setLoadError(typeof j.error === "string" ? j.error : "Could not load Zernio.");
      return;
    }
    setStatus(j as Status);
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  async function connect(kind: "social" | "ads", platform: string, postingAccountId?: string) {
    setBusy(`${kind}-${platform}`);
    setMessage(null);
    try {
      const r = await fetch("/api/zernio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, kind, platform, postingAccountId: postingAccountId ?? null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMessage({ kind: "error", text: typeof j.error === "string" ? j.error : "Could not start the connection." });
        return;
      }
      if (typeof j.authUrl === "string") {
        window.location.href = j.authUrl;
        return;
      }
      setMessage({ kind: "ok", text: "That ad network is already connected on this workspace's profile." });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function connectOpenAi() {
    if (!openAiKey.trim()) return;
    setBusy("ads-openai");
    setMessage(null);
    try {
      const r = await fetch("/api/zernio/openai-ads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, apiKey: openAiKey }),
      });
      const j = await r.json().catch(() => ({}));
      setOpenAiKey("");
      if (!r.ok) {
        setMessage({ kind: "error", text: typeof j.error === "string" ? j.error : "Could not connect OpenAI Ads." });
        return;
      }
      setOpenAiOpen(false);
      setMessage({ kind: "ok", text: "Connected OpenAI Ads." });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function useInProjects() {
    setBusy("projects");
    setMessage(null);
    try {
      const r = await fetch("/api/zernio/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMessage({ kind: "error", text: typeof j.error === "string" ? j.error : "Could not turn Zernio on for your projects." });
        return;
      }
      setMessage({ kind: "ok", text: `Zernio tools are on in ${j.bound ?? 0} project${j.bound === 1 ? "" : "s"}. Creating ads and raising budgets still ask every time.` });
    } finally {
      setBusy(null);
    }
  }

  const xAccounts = (status?.accounts ?? []).filter((a) => a.platform === "twitter" && a.status !== "disconnected");
  const modeChip =
    status?.mode === "live" ? "Platform key · live, pre-added" : status?.mode === "mock" ? "Mock · labelled fake Zernio" : status?.mode === "off" ? "Off · ZERNIO_API_KEY not set" : "Loading";

  return (
    <div id="zernio" data-testid="connector-card-zernio" className={`${cardCls} md:col-span-2`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="max-w-2xl">
          <h3 className="font-medium text-ink">Zernio</h3>
          <p className="mt-1 text-sm text-muted">
            Ads on Meta, Google, TikTok, LinkedIn, Pinterest, X and OpenAI, and social publishing on 16 platforms. This workspace has its own
            Zernio profile — connect your accounts below; there is no key to paste. Creating ads and raising budgets always ask first.
          </p>
        </div>
        <span className={chipCls}>{modeChip}</span>
      </div>

      {message && (
        <div
          role={message.kind === "error" ? "alert" : undefined}
          className={
            message.kind === "error"
              ? "mt-3 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
              : "mt-3 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted"
          }
        >
          {message.text}
        </div>
      )}
      {loadError && (
        <div role="alert" className="mt-3 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          {loadError}
        </div>
      )}
      {status?.mode === "mock" && (
        <p className="mt-3 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
          Mock mode: no ZERNIO_API_KEY on this server, so connections, ads and posts run on a labelled fake Zernio and nothing reaches a real
          network. Every name it invents ends in “(MOCK)”.
        </p>
      )}
      {status?.mode === "off" && (
        <p className="mt-3 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
          Zernio is not connected on this server. Set ZERNIO_API_KEY (Settings → Providers lists every key) to turn it on.
        </p>
      )}

      {status && status.mode !== "off" && (
        <>
          <div className="mt-5">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Share2 size={15} aria-hidden="true" /> Social accounts
            </h4>
            <p className="mt-0.5 text-xs text-muted">Connect an account opens Zernio&apos;s sign-in for that platform, then brings you back here.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {status.platforms.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => connect("social", p.key)}
                  disabled={busy !== null}
                  className={pillCls}
                  aria-label={`Connect an account on ${p.label}`}
                  title={p.closedBeta ? `${p.label} is a closed beta at Zernio — it may be refused until approved.` : `Connect an account on ${p.label}`}
                >
                  <Plug size={14} aria-hidden="true" />
                  {busy === `social-${p.key}` ? "Starting…" : p.label}
                  {p.closedBeta && <span className="text-xs text-subtle">beta</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Megaphone size={15} aria-hidden="true" /> Ad accounts
            </h4>
            <p className="mt-0.5 text-xs text-muted">One ads connection per network. Your ad spend bills to you on each network; ShapesOS never holds it.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {status.adNetworks.map((n) => {
                if (n.connect === "credentials") {
                  return (
                    <button key={n.key} type="button" onClick={() => setOpenAiOpen((v) => !v)} disabled={busy !== null} className={pillCls}>
                      <KeyRound size={14} aria-hidden="true" />
                      {n.label}
                    </button>
                  );
                }
                if (n.needsPostingAccount) {
                  return (
                    <span key={n.key} className="inline-flex items-center gap-1.5">
                      {xAccounts.length > 1 && (
                        <select
                          aria-label="X account for X Ads"
                          value={xAccount}
                          onChange={(e) => setXAccount(e.target.value)}
                          className={inputCls}
                        >
                          <option value="">Pick an X account</option>
                          {xAccounts.map((a) => (
                            <option key={a.accountId} value={a.accountId}>
                              {a.username ?? a.accountId}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={() => connect("ads", n.key, xAccounts.length === 1 ? xAccounts[0]!.accountId : xAccount)}
                        disabled={busy !== null || xAccounts.length === 0 || (xAccounts.length > 1 && !xAccount)}
                        className={pillCls}
                        title={xAccounts.length === 0 ? "Connect an X account first — X Ads runs through it." : `Connect ${n.label}`}
                      >
                        <Plug size={14} aria-hidden="true" />
                        {busy === `ads-${n.key}` ? "Starting…" : n.label}
                      </button>
                    </span>
                  );
                }
                return (
                  <button key={n.key} type="button" onClick={() => connect("ads", n.key)} disabled={busy !== null} className={pillCls}>
                    <Plug size={14} aria-hidden="true" />
                    {busy === `ads-${n.key}` ? "Starting…" : n.label}
                  </button>
                );
              })}
            </div>
            {openAiOpen && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className={labelCls}>
                  ChatGPT Ads Manager API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={openAiKey}
                    onChange={(e) => setOpenAiKey(e.target.value)}
                    placeholder="sk-ads-…"
                    className={`${inputCls} mt-1 block w-72`}
                  />
                </label>
                <button type="button" onClick={connectOpenAi} disabled={busy !== null || !openAiKey.trim()} className={btnPrimary}>
                  {busy === "ads-openai" ? "Connecting…" : "Connect ad account"}
                </button>
                <p className="w-full text-xs text-subtle">The key goes to Zernio for this workspace&apos;s profile; ShapesOS does not store it.</p>
              </div>
            )}
          </div>

          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-ink">Connected accounts</h4>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => load()} disabled={busy !== null} className={btnGhost}>
                  <RefreshCw size={14} aria-hidden="true" /> Refresh
                </button>
                <button type="button" onClick={useInProjects} disabled={busy !== null || status.accounts.length === 0} className={btnGhost}>
                  <FolderPlus size={14} aria-hidden="true" /> {busy === "projects" ? "Turning on…" : "Use in every project"}
                </button>
              </div>
            </div>
            {status.accounts.length === 0 ? (
              <p className="mt-2 text-xs text-subtle">No accounts connected yet.</p>
            ) : (
              <div className="mt-2 overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line bg-canvas">
                      <th className="px-3 py-2 text-xs font-semibold text-muted">Account</th>
                      <th className="px-3 py-2 text-xs font-semibold text-muted">Platform</th>
                      <th className="px-3 py-2 text-xs font-semibold text-muted">Kind</th>
                      <th className="px-3 py-2 text-xs font-semibold text-muted">Status</th>
                      <th className="px-3 py-2 text-xs font-semibold text-muted">Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.accounts.map((a) => (
                      <tr key={a.accountId} className="border-b border-line last:border-0 hover:bg-hover-paper">
                        <td className="px-3 py-2 text-ink">
                          {a.displayName ?? a.username ?? "Account"}
                          {a.username && a.displayName ? <span className="ml-1 text-xs text-muted">{a.username}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-muted">{status.platforms.find((p) => p.key === a.platform)?.label ?? a.platform}</td>
                        <td className="px-3 py-2 text-muted">{a.category === "ads" ? "Ads" : a.category === "communication" ? "Messaging" : "Social"}</td>
                        <td className="px-3 py-2">
                          <span className={chipCls}>{STATUS_LABEL[a.status] ?? a.status}</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted">
                          {a.health}
                          {a.issues.length > 0 ? ` — ${a.issues.join("; ")}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {status.rateLimit?.remaining !== null && status.rateLimit?.remaining !== undefined && (
              <p className="mt-2 text-xs text-subtle">
                Zernio API: {status.rateLimit.remaining} of {status.rateLimit.limit ?? "?"} requests left this minute.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
