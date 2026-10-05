// Marketr — hosting manager (milestone 9).
//
// Connect Vercel / Cloudflare Pages / Netlify deploy targets (tokens encrypted at
// rest, test-before-save), deploy any site's working copy to a live URL, and
// list each site's deployment history. Live provider APIs are untested from
// this sandbox — demo mode runs the full flow on labeled mocks.
// Phase 9: Netlify, and one-click rollback to an earlier deployment — it
// changes a live site, so it asks for approval first (Actions), then runs.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

interface HostingConnection {
  id: string;
  name: string;
  target: "vercel" | "cloudflare-pages" | "netlify";
  tokenHint: string;
  demo: boolean;
  createdAt: string;
}

interface SiteRow {
  id: string;
  name: string;
}

interface DeploymentRow {
  id: string;
  target: string;
  targetLabel: string;
  url: string | null;
  deploymentId: string | null;
  status: string;
  mock: boolean;
  createdAt: string;
  // Phase 9: rollback state (GET /api/websites/[id]/deployments).
  current?: boolean;
  canRollBack?: boolean;
  rollbackReason?: string | null;
  rollbackOf?: string | null;
  rollback?: { approvalId: string; status: string } | null;
}

const TARGET_LABEL: Record<string, string> = {
  vercel: "Vercel",
  "cloudflare-pages": "Cloudflare Pages",
  netlify: "Netlify",
};

const INPUT =
  "mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";
const PILL_SECONDARY =
  "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-3 text-[13px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40";

const STATUS_COLOR: Record<string, string> = {
  // Deployment states read as text; only an error takes the failed color.
  ready: "text-ink",
  building: "text-ink",
  queued: "text-muted",
  error: "text-failed-text",
};

export default function HostingManager({ projectId }: { projectId: string }) {
  const [conns, setConns] = useState<HostingConnection[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [form, setForm] = useState<"vercel" | "cloudflare" | "netlify" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Vercel form
  const [vName, setVName] = useState("");
  const [vToken, setVToken] = useState("");
  const [vProjectId, setVProjectId] = useState("");
  const [vTeamId, setVTeamId] = useState("");
  const [vDemo, setVDemo] = useState(false);
  const [vTest, setVTest] = useState<string | null>(null);
  const [vTestBusy, setVTestBusy] = useState(false);

  // Cloudflare form
  const [cName, setCName] = useState("");
  const [cToken, setCToken] = useState("");
  const [cAccountId, setCAccountId] = useState("");
  const [cProjectName, setCProjectName] = useState("");
  const [cDemo, setCDemo] = useState(false);
  const [cTest, setCTest] = useState<string | null>(null);
  const [cTestBusy, setCTestBusy] = useState(false);

  // Netlify form (Phase 9)
  const [nName, setNName] = useState("");
  const [nToken, setNToken] = useState("");
  const [nSiteId, setNSiteId] = useState("");
  const [nDemo, setNDemo] = useState(false);
  const [nTest, setNTest] = useState<string | null>(null);
  const [nTestBusy, setNTestBusy] = useState(false);

  // Phase 11 (devtools): reuse a Netlify hosting connection for the Netlify agent connector.
  const [agentBusy, setAgentBusy] = useState<string | null>(null);
  const [agentMsg, setAgentMsg] = useState<string | null>(null);

  // Rollback (Phase 9)
  const [rbBusy, setRbBusy] = useState<string | null>(null);
  const [rbMsg, setRbMsg] = useState<string | null>(null);

  // Deploy flow
  const [depSite, setDepSite] = useState<string>("");
  const [depConn, setDepConn] = useState<string>("");
  const [depBusy, setDepBusy] = useState(false);
  const [depMsg, setDepMsg] = useState<string | null>(null);
  const [depUrl, setDepUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, DeploymentRow[]>>({});
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [cRes, sRes] = await Promise.all([
      fetch(`/api/hosting/connections?projectId=${projectId}`),
      fetch(`/api/websites?projectId=${projectId}`),
    ]);
    const cData = await cRes.json();
    const sData = await sRes.json();
    if (cRes.ok) setConns(cData.connections);
    if (sRes.ok) setSites(sData.sites.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })));
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadHistory(siteId: string) {
    const res = await fetch(`/api/websites/${siteId}/deployments?projectId=${projectId}`);
    const data = await res.json();
    if (res.ok) setHistory((h) => ({ ...h, [siteId]: data.deployments }));
  }

  async function testVercel() {
    setVTestBusy(true);
    setVTest(null);
    try {
      const res = await fetch("/api/hosting/vercel/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          token: vToken,
          vercelProjectId: vProjectId,
          teamId: vTeamId,
          demo: vDemo,
        }),
      });
      const data = await res.json();
      setVTest(res.ok && data.ok ? `✓ ${data.info}${data.mock ? " (mock)" : ""}` : `✗ ${data.error ?? "failed"}`);
    } catch {
      setVTest("✗ request failed");
    } finally {
      setVTestBusy(false);
    }
  }

  async function testCloudflare() {
    setCTestBusy(true);
    setCTest(null);
    try {
      const res = await fetch("/api/hosting/cloudflare/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          token: cToken,
          accountId: cAccountId,
          projectName: cProjectName,
          demo: cDemo,
        }),
      });
      const data = await res.json();
      setCTest(res.ok && data.ok ? `✓ ${data.info}${data.mock ? " (mock)" : ""}` : `✗ ${data.error ?? "failed"}`);
    } catch {
      setCTest("✗ request failed");
    } finally {
      setCTestBusy(false);
    }
  }

  async function testNetlify() {
    setNTestBusy(true);
    setNTest(null);
    try {
      const res = await fetch("/api/hosting/netlify/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, token: nToken, siteId: nSiteId, demo: nDemo }),
      });
      const data = await res.json();
      setNTest(res.ok && data.ok ? `Connected: ${data.info}${data.mock ? " (mock)" : ""}` : `Failed: ${data.error ?? "unknown error"}`);
    } catch {
      setNTest("Failed: request failed");
    } finally {
      setNTestBusy(false);
    }
  }

  async function saveNetlify() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/hosting/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          target: "netlify",
          name: nName.trim() || "Netlify",
          token: nToken,
          siteId: nSiteId,
          demo: nDemo,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setNName(""); setNToken(""); setNSiteId(""); setNTest(null);
      setForm(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Phase 9: roll back to an earlier deployment. First click asks for
   * approval (Tier 2 — it changes a live site); once approved in Actions,
   * the same button runs it with that approval.
   */
  async function rollBack(siteId: string, d: DeploymentRow) {
    const approved = d.rollback?.status === "approved" ? d.rollback.approvalId : null;
    if (!approved) {
      const ok = await confirmAction(
        `Ask to roll ${d.targetLabel} back to the deployment from ${new Date(d.createdAt).toLocaleString()}? It changes the live site, so someone approves it in Actions first.`,
      );
      if (!ok) return;
    }
    setRbBusy(d.id);
    setRbMsg(null);
    try {
      const res = await fetch(`/api/websites/${siteId}/deployments/${d.id}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(approved ? { projectId, approvalId: approved } : { projectId }),
      });
      const data = await res.json();
      if (res.status === 202) setRbMsg("Rollback requested — approve it in Actions, then run it here.");
      else if (!res.ok) throw new Error(data.error ?? "Rollback failed");
      else setRbMsg(`Rolled back (${data.status})${data.mock ? " (mock)" : ""}${data.url ? `: ${data.url}` : ""}`);
      await loadHistory(siteId);
    } catch (err) {
      setRbMsg(err instanceof Error ? err.message : "Rollback failed");
    } finally {
      setRbBusy(null);
    }
  }

  async function saveVercel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/hosting/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          target: "vercel",
          name: vName.trim() || "Vercel",
          token: vToken,
          vercelProjectId: vProjectId,
          teamId: vTeamId,
          demo: vDemo,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setVName(""); setVToken(""); setVProjectId(""); setVTeamId(""); setVTest(null);
      setForm(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveCloudflare() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/hosting/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          target: "cloudflare-pages",
          name: cName.trim() || "Cloudflare Pages",
          token: cToken,
          accountId: cAccountId,
          projectName: cProjectName,
          demo: cDemo,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setCName(""); setCToken(""); setCAccountId(""); setCProjectName(""); setCTest(null);
      setForm(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteConn(id: string, name: string) {
    if (!await confirmAction(`Remove hosting connection "${name}"? Deployments made through it are kept.`)) return;
    await fetch(`/api/hosting/connections/${id}?projectId=${projectId}`, { method: "DELETE" });
    await refresh();
  }

  async function connectForAgents(c: HostingConnection) {
    setAgentBusy(c.id);
    setAgentMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/connectors/netlify/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostingConnectionId: c.id, label: c.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data.error ?? "Could not connect Netlify for agents.");
      else setAgentMsg(`Agents can now use "${c.name}" through the Netlify connector. Enable it for a project in its data sources.`);
    } finally {
      setAgentBusy(null);
    }
  }

  async function runDeploy() {
    if (!depSite || !depConn) return;
    setDepBusy(true);
    setDepMsg(null);
    setDepUrl(null);
    try {
      const res = await fetch(`/api/websites/${depSite}/deploy-hosting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, connectionId: depConn }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Deploy failed");
      setDepMsg(`✓ Deployed (${data.status})${data.mock ? " (mock)" : ""}`);
      setDepUrl(data.url ?? null);
      await loadHistory(depSite);
    } catch (err) {
      setDepMsg(`✗ ${err instanceof Error ? err.message : "Deploy failed"}`);
    } finally {
      setDepBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Hosting — Vercel, Cloudflare Pages & Netlify</h2>
        <div className="flex gap-2">
          <button
            onClick={() => { setForm(form === "vercel" ? null : "vercel"); setError(null); }}
            className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
          >
            Connect Vercel
          </button>
          <button
            onClick={() => { setForm(form === "cloudflare" ? null : "cloudflare"); setError(null); }}
            className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
          >
            Connect Cloudflare
          </button>
          <button
            onClick={() => { setForm(form === "netlify" ? null : "netlify"); setError(null); }}
            className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
          >
            Connect Netlify
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed-text">
          <span className="aos-shape aos-shape--failed mt-1 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {form === "vercel" && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <h3 className="mb-3 text-sm font-semibold text-ink">Connect Vercel</h3>
          <label className="mb-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={vDemo} onChange={(e) => { setVDemo(e.target.checked); setVTest(null); }} />
            Use demo target <span className="text-xs text-muted">(mock — no token or network needed)</span>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm text-muted">Name
              <input value={vName} onChange={(e) => setVName(e.target.value)} placeholder="Vercel" className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
            </label>
            {!vDemo && (
              <>
                <label className="text-sm text-muted">Personal access token
                  <input type="password" value={vToken} onChange={(e) => setVToken(e.target.value)} placeholder="vercel.com/account/tokens" className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
                </label>
                <label className="text-sm text-muted">Project id <span className="text-xs text-muted">(optional — auto-creates)</span>
                  <input value={vProjectId} onChange={(e) => setVProjectId(e.target.value)} className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
                </label>
                <label className="text-sm text-muted">Team id <span className="text-xs text-muted">(optional)</span>
                  <input value={vTeamId} onChange={(e) => setVTeamId(e.target.value)} className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
                </label>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">Tokens are encrypted at rest and never shown in the UI.</p>
          {vTest && <p className="mt-3 text-xs text-muted">{vTest}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => void testVercel()} disabled={vTestBusy} className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40">
              {vTestBusy ? "Testing…" : "Test"}
            </button>
            <button onClick={() => void saveVercel()} disabled={busy} className="inline-flex h-control-sm items-center justify-center whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? "Saving…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      {form === "cloudflare" && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <h3 className="mb-3 text-sm font-semibold text-ink">Connect Cloudflare Pages</h3>
          <label className="mb-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={cDemo} onChange={(e) => { setCDemo(e.target.checked); setCTest(null); }} />
            Use demo target <span className="text-xs text-muted">(mock — no token or network needed)</span>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm text-muted">Name
              <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Cloudflare Pages" className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
            </label>
            {!cDemo && (
              <>
                <label className="text-sm text-muted">API token <span className="text-xs text-muted">(Pages:Edit)</span>
                  <input type="password" value={cToken} onChange={(e) => setCToken(e.target.value)} className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
                </label>
                <label className="text-sm text-muted">Account id
                  <input value={cAccountId} onChange={(e) => setCAccountId(e.target.value)} className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
                </label>
                <label className="text-sm text-muted">Pages project <span className="text-xs text-muted">(optional — created on first deploy)</span>
                  <input value={cProjectName} onChange={(e) => setCProjectName(e.target.value)} className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]" />
                </label>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">Tokens are encrypted at rest and never shown in the UI.</p>
          {cTest && <p className="mt-3 text-xs text-muted">{cTest}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => void testCloudflare()} disabled={cTestBusy} className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40">
              {cTestBusy ? "Testing…" : "Test"}
            </button>
            <button onClick={() => void saveCloudflare()} disabled={busy} className="inline-flex h-control-sm items-center justify-center whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? "Saving…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      {form === "netlify" && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <h3 className="mb-3 text-sm font-semibold text-ink">Connect Netlify</h3>
          <label className="mb-3 flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={nDemo} onChange={(e) => { setNDemo(e.target.checked); setNTest(null); }} />
            Use demo target <span className="text-xs text-muted">(mock — no token or network needed)</span>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm text-muted">Name
              <input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="Netlify" className={INPUT} />
            </label>
            {!nDemo && (
              <>
                <label className="text-sm text-muted">Personal access token
                  <input type="password" value={nToken} onChange={(e) => setNToken(e.target.value)} placeholder="app.netlify.com/user/applications" className={INPUT} />
                </label>
                <label className="text-sm text-muted">Site id <span className="text-xs text-muted">(optional — created on first deploy)</span>
                  <input value={nSiteId} onChange={(e) => setNSiteId(e.target.value)} className={INPUT} />
                </label>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-muted">Tokens are encrypted at rest and never shown in the UI.</p>
          {nTest && <p className="mt-3 text-xs text-muted">{nTest}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => void testNetlify()} disabled={nTestBusy} className="inline-flex h-control-sm items-center whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40">
              {nTestBusy ? "Testing…" : "Test"}
            </button>
            <button onClick={() => void saveNetlify()} disabled={busy} className="inline-flex h-control-sm items-center justify-center whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? "Saving…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {conns.length === 0 && (
          <p className="text-sm text-muted">No hosting connections yet — connect Vercel, Cloudflare or Netlify to deploy sites to a live URL.</p>
        )}
        {conns.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-sm bg-paper px-4 py-2.5 shadow-hairline">
            <div className="text-sm">
              <span className="font-medium text-ink">{c.name}</span>
              <span className="ml-2 text-muted">{TARGET_LABEL[c.target]}</span>
              {c.demo && <span className="ml-2 rounded-full bg-canvas px-2 py-0.5 text-xs font-semibold text-muted">Mock</span>}
              <span className="ml-2 text-xs text-muted">token {c.tokenHint}</span>
            </div>
            <div className="flex items-center gap-2">
              {c.target === "netlify" && !c.demo && (
                <button
                  onClick={() => void connectForAgents(c)}
                  disabled={agentBusy === c.id}
                  className="inline-flex h-8 items-center whitespace-nowrap rounded-full bg-paper px-3 text-[13px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {agentBusy === c.id ? "Connecting…" : "Use for agents"}
                </button>
              )}
              <button
                onClick={() => void deleteConn(c.id, c.name)}
                className="inline-flex h-8 items-center whitespace-nowrap rounded-full bg-paper px-3 text-[13px] font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {agentMsg && <p className="text-sm text-muted">{agentMsg}</p>}
      </div>

      {conns.length > 0 && sites.length > 0 && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <h3 className="mb-3 text-sm font-semibold text-ink">Deploy a site to hosting</h3>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm text-muted">Site
              <select value={depSite} onChange={(e) => { setDepSite(e.target.value); setDepMsg(null); setDepUrl(null); if (e.target.value) void loadHistory(e.target.value); }} className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]">
                <option value="">Select…</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="text-sm text-muted">Hosting connection
              <select value={depConn} onChange={(e) => setDepConn(e.target.value)} className="mt-1 h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]">
                <option value="">Select…</option>
                {conns.map((c) => <option key={c.id} value={c.id}>{c.name} — {TARGET_LABEL[c.target]}{c.demo ? " (mock)" : ""}</option>)}
              </select>
            </label>
            <div className="flex items-end">
              <button
                onClick={() => void runDeploy()}
                disabled={depBusy || !depSite || !depConn}
                className="inline-flex h-control w-full items-center justify-center whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {depBusy ? "Deploying…" : "Deploy to hosting"}
              </button>
            </div>
          </div>
          {depMsg && <p className="mt-3 text-sm text-muted">{depMsg}</p>}
          {depUrl && (
            <p className="mt-2 text-sm">
              <a href={depUrl} target="_blank" rel="noreferrer" className="text-ink underline hover:text-focus">
                Visit site ↗
              </a>
              <span className="ml-2 text-muted">{depUrl}</span>
            </p>
          )}
        </div>
      )}

      {depSite && history[depSite] && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <button
            onClick={() => setHistoryOpen(historyOpen === depSite ? null : depSite)}
            className="text-sm font-semibold text-ink"
          >
            Deployment history {historyOpen === depSite ? "▾" : "▸"} ({history[depSite].length})
          </button>
          {historyOpen === depSite && (
            <div className="mt-3 flex flex-col gap-2">
              {rbMsg && <p role="status" className="text-sm text-muted">{rbMsg}</p>}
              {history[depSite].map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-sm bg-canvas px-3 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className={`font-medium ${STATUS_COLOR[d.status] ?? "text-muted"}`}>{d.status}</span>
                    <span className="text-muted">{d.targetLabel}</span>
                    {d.mock && <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted">Mock</span>}
                    {d.url && (
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-ink underline hover:text-focus">
                        {d.url}
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {d.current && <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-ink">Live</span>}
                    {d.rollbackOf && <span className="text-xs text-muted">Rollback</span>}
                    <span className="text-xs text-muted">{new Date(d.createdAt).toLocaleString()}</span>
                    {d.canRollBack && d.rollback?.status === "pending" && (
                      <Link href="/dashboard/actions" className="text-xs font-semibold text-ink underline hover:text-focus">
                        Waiting for approval
                      </Link>
                    )}
                    {d.canRollBack && d.rollback?.status !== "pending" && (
                      <button
                        onClick={() => void rollBack(depSite, d)}
                        disabled={rbBusy !== null}
                        title={d.rollback?.status === "approved" ? "Approved — run the rollback" : "Ask to roll back to this deployment"}
                        className={PILL_SECONDARY}
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        {rbBusy === d.id ? "Working…" : d.rollback?.status === "approved" ? "Run rollback" : "Roll back"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {history[depSite].length === 0 && <p className="text-sm text-muted">No deployments yet.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
