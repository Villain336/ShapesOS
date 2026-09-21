// Marketr — hosting manager (milestone 9).
//
// Connect Vercel / Cloudflare Pages deploy targets (tokens encrypted at
// rest, test-before-save), deploy any site's working copy to a live URL, and
// list each site's deployment history. Live provider APIs are untested from
// this sandbox — demo mode runs the full flow on labeled mocks.

"use client";

import { useCallback, useEffect, useState } from "react";

interface HostingConnection {
  id: string;
  name: string;
  target: "vercel" | "cloudflare-pages";
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
}

const TARGET_LABEL: Record<string, string> = {
  vercel: "Vercel",
  "cloudflare-pages": "Cloudflare Pages",
};

const STATUS_COLOR: Record<string, string> = {
  ready: "text-emerald-400",
  building: "text-amber-400",
  queued: "text-zinc-400",
  error: "text-red-400",
};

export default function HostingManager({ projectId }: { projectId: string }) {
  const [conns, setConns] = useState<HostingConnection[]>([]);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [form, setForm] = useState<"vercel" | "cloudflare" | null>(null);
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
    if (!confirm(`Remove hosting connection "${name}"? Deployments made through it are kept.`)) return;
    await fetch(`/api/hosting/connections/${id}?projectId=${projectId}`, { method: "DELETE" });
    await refresh();
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
        <h2 className="text-sm font-semibold text-zinc-200">Hosting — Vercel & Cloudflare Pages</h2>
        <div className="flex gap-2">
          <button
            onClick={() => { setForm(form === "vercel" ? null : "vercel"); setError(null); }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500"
          >
            Connect Vercel
          </button>
          <button
            onClick={() => { setForm(form === "cloudflare" ? null : "cloudflare"); setError(null); }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500"
          >
            Connect Cloudflare
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {form === "vercel" && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">Connect Vercel</h3>
          <label className="mb-3 flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={vDemo} onChange={(e) => { setVDemo(e.target.checked); setVTest(null); }} />
            Use demo target <span className="text-xs text-zinc-600">(mock — no token or network needed)</span>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm text-zinc-400">Name
              <input value={vName} onChange={(e) => setVName(e.target.value)} placeholder="Vercel" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
            </label>
            {!vDemo && (
              <>
                <label className="text-sm text-zinc-400">Personal access token
                  <input type="password" value={vToken} onChange={(e) => setVToken(e.target.value)} placeholder="vercel.com/account/tokens" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
                </label>
                <label className="text-sm text-zinc-400">Project id <span className="text-xs text-zinc-600">(optional — auto-creates)</span>
                  <input value={vProjectId} onChange={(e) => setVProjectId(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
                </label>
                <label className="text-sm text-zinc-400">Team id <span className="text-xs text-zinc-600">(optional)</span>
                  <input value={vTeamId} onChange={(e) => setVTeamId(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
                </label>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-600">Tokens are encrypted at rest and never shown in the UI.</p>
          {vTest && <p className="mt-3 text-xs text-zinc-300">{vTest}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => void testVercel()} disabled={vTestBusy} className="rounded border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 disabled:opacity-50">
              {vTestBusy ? "Testing…" : "Test"}
            </button>
            <button onClick={() => void saveVercel()} disabled={busy} className="rounded bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50">
              {busy ? "Saving…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      {form === "cloudflare" && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">Connect Cloudflare Pages</h3>
          <label className="mb-3 flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={cDemo} onChange={(e) => { setCDemo(e.target.checked); setCTest(null); }} />
            Use demo target <span className="text-xs text-zinc-600">(mock — no token or network needed)</span>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm text-zinc-400">Name
              <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Cloudflare Pages" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
            </label>
            {!cDemo && (
              <>
                <label className="text-sm text-zinc-400">API token <span className="text-xs text-zinc-600">(Pages:Edit)</span>
                  <input type="password" value={cToken} onChange={(e) => setCToken(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
                </label>
                <label className="text-sm text-zinc-400">Account id
                  <input value={cAccountId} onChange={(e) => setCAccountId(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
                </label>
                <label className="text-sm text-zinc-400">Pages project <span className="text-xs text-zinc-600">(optional — created on first deploy)</span>
                  <input value={cProjectName} onChange={(e) => setCProjectName(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200" />
                </label>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-600">Tokens are encrypted at rest and never shown in the UI.</p>
          {cTest && <p className="mt-3 text-xs text-zinc-300">{cTest}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => void testCloudflare()} disabled={cTestBusy} className="rounded border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 disabled:opacity-50">
              {cTestBusy ? "Testing…" : "Test"}
            </button>
            <button onClick={() => void saveCloudflare()} disabled={busy} className="rounded bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50">
              {busy ? "Saving…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {conns.length === 0 && (
          <p className="text-sm text-zinc-500">No hosting connections yet — connect Vercel or Cloudflare to deploy sites to a live URL.</p>
        )}
        {conns.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5">
            <div className="text-sm">
              <span className="font-medium text-zinc-200">{c.name}</span>
              <span className="ml-2 text-zinc-500">{TARGET_LABEL[c.target]}</span>
              {c.demo && <span className="ml-2 rounded bg-amber-900/40 px-1.5 py-0.5 text-xs text-amber-300">mock</span>}
              <span className="ml-2 text-xs text-zinc-600">token {c.tokenHint}</span>
            </div>
            <button
              onClick={() => void deleteConn(c.id, c.name)}
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-red-500 hover:text-red-400"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {conns.length > 0 && sites.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">Deploy a site to hosting</h3>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm text-zinc-400">Site
              <select value={depSite} onChange={(e) => { setDepSite(e.target.value); setDepMsg(null); setDepUrl(null); if (e.target.value) void loadHistory(e.target.value); }} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200">
                <option value="">Select…</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="text-sm text-zinc-400">Hosting connection
              <select value={depConn} onChange={(e) => setDepConn(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200">
                <option value="">Select…</option>
                {conns.map((c) => <option key={c.id} value={c.id}>{c.name} — {TARGET_LABEL[c.target]}{c.demo ? " (mock)" : ""}</option>)}
              </select>
            </label>
            <div className="flex items-end">
              <button
                onClick={() => void runDeploy()}
                disabled={depBusy || !depSite || !depConn}
                className="w-full rounded bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
              >
                {depBusy ? "Deploying…" : "Deploy to hosting"}
              </button>
            </div>
          </div>
          {depMsg && <p className="mt-3 text-sm text-zinc-300">{depMsg}</p>}
          {depUrl && (
            <p className="mt-2 text-sm">
              <a href={depUrl} target="_blank" rel="noreferrer" className="text-sky-400 underline hover:text-sky-300">
                Visit site ↗
              </a>
              <span className="ml-2 text-zinc-500">{depUrl}</span>
            </p>
          )}
        </div>
      )}

      {depSite && history[depSite] && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <button
            onClick={() => setHistoryOpen(historyOpen === depSite ? null : depSite)}
            className="text-sm font-semibold text-zinc-200"
          >
            Deployment history {historyOpen === depSite ? "▾" : "▸"} ({history[depSite].length})
          </button>
          {historyOpen === depSite && (
            <div className="mt-3 flex flex-col gap-2">
              {history[depSite].map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded border border-zinc-800 px-3 py-2 text-sm">
                  <div className="flex items-center gap-3">
                    <span className={`font-medium ${STATUS_COLOR[d.status] ?? "text-zinc-400"}`}>{d.status}</span>
                    <span className="text-zinc-500">{d.targetLabel}</span>
                    {d.mock && <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-xs text-amber-300">mock</span>}
                    {d.url && (
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-sky-400 underline hover:text-sky-300">
                        {d.url}
                      </a>
                    )}
                  </div>
                  <span className="text-xs text-zinc-600">{new Date(d.createdAt).toLocaleString()}</span>
                </div>
              ))}
              {history[depSite].length === 0 && <p className="text-sm text-zinc-500">No deployments yet.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
