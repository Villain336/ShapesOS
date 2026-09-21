// Marketr — sites manager (milestone 7): list, connect, sync, deploy.
// A Site is the unit the builder creates and the IDE edits — GitHub repo,
// SFTP host (via a milestone-6 connection), or uploaded/managed files.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface SiteSummary {
  id: string;
  name: string;
  sourceType: "github" | "sftp" | "file";
  isMock: boolean;
  isLive: boolean;
  github: { owner: string; repo: string; branch: string; demo: boolean } | null;
  sftpConnection: { id: string; label: string; demo: boolean } | null;
  updatedAt: string;
}

interface Connection {
  id: string;
  label: string;
  host: string;
  demo: boolean;
}

interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  mock?: boolean;
}

interface DeployResult {
  ok: boolean;
  fileCount: number;
  perFile: { path: string; ok: boolean; error?: string }[];
  commitSha?: string;
  downloadUrl?: string;
  mock?: boolean;
  error?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  github: "GitHub",
  sftp: "SFTP",
  file: "Files",
};

export default function SitesManager({ projectId }: { projectId: string }) {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<"github" | "upload" | "sftp" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // GitHub form
  const [ghToken, setGhToken] = useState("");
  const [ghDemo, setGhDemo] = useState(false);
  const [ghRepos, setGhRepos] = useState<RepoSummary[] | null>(null);
  const [ghReposBusy, setGhReposBusy] = useState(false);
  const [ghSelected, setGhSelected] = useState("");
  const [ghBranch, setGhBranch] = useState("main");
  const [ghNewName, setGhNewName] = useState("");
  const [ghName, setGhName] = useState("");

  // Upload form
  const [upName, setUpName] = useState("");
  const [upFile, setUpFile] = useState<File | null>(null);

  // SFTP form
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [sftpConnId, setSftpConnId] = useState("");
  const [sftpName, setSftpName] = useState("");

  // Deploy / sync status
  const [opBusy, setOpBusy] = useState<Record<string, string>>({});
  const [deployRes, setDeployRes] = useState<Record<string, DeployResult>>({});
  const [syncMsg, setSyncMsg] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/websites?projectId=${projectId}`);
    const data = await res.json();
    if (res.ok) setSites(data.sites);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadGhRepos() {
    setGhReposBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/websites/github/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, token: ghToken, demo: ghDemo || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not list repos");
        return;
      }
      setGhRepos(data.repos);
      if (data.repos.length > 0) {
        setGhSelected(data.repos[0].fullName);
        setGhBranch(data.repos[0].defaultBranch || "main");
      }
    } finally {
      setGhReposBusy(false);
    }
  }

  async function createGhSite() {
    setError(null);
    setBusy(true);
    try {
      let owner = "";
      let repo = "";
      let branch = ghBranch || "main";
      let token = ghToken;
      let demo = ghDemo;
      if (ghNewName.trim()) {
        // Create a brand-new repo first.
        const res = await fetch("/api/websites/github/repos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, token: ghToken, demo: ghDemo || undefined, create: ghNewName.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not create repo");
          return;
        }
        owner = data.repo.owner;
        repo = data.repo.name;
        branch = data.repo.defaultBranch || "main";
      } else {
        if (!ghSelected) {
          setError("Pick a repository first");
          return;
        }
        [owner, repo] = ghSelected.split("/");
      }
      const res = await fetch("/api/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: ghName.trim() || repo,
          sourceType: "github",
          github: { token, owner, repo, branch, demo: demo || undefined },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create site");
        return;
      }
      setForm(null);
      setGhName("");
      setGhNewName("");
      setGhRepos(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function createUploadSite() {
    setError(null);
    if (!upFile) {
      setError("Choose a .zip or .html file");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: upName.trim() || "Uploaded site", sourceType: "file" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create site");
        return;
      }
      const fd = new FormData();
      fd.append("projectId", projectId);
      fd.append("file", upFile);
      const up = await fetch(`/api/websites/${data.site.id}/upload`, { method: "POST", body: fd });
      const upData = await up.json();
      if (!up.ok) {
        setError(upData.error ?? "Upload failed");
        return;
      }
      setForm(null);
      setUpName("");
      setUpFile(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function loadConns() {
    const res = await fetch(`/api/sites?projectId=${projectId}`);
    const data = await res.json();
    if (res.ok) {
      setConns(data.connections);
      if (data.connections.length > 0) setSftpConnId(data.connections[0].id);
    }
  }

  async function createSftpSite() {
    setError(null);
    if (!sftpConnId) {
      setError("Pick an SFTP connection first");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: sftpName.trim() || "SFTP site",
          sourceType: "sftp",
          sftpConnectionId: sftpConnId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create site");
        return;
      }
      setForm(null);
      setSftpName("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function syncSite(site: SiteSummary) {
    setOpBusy((m) => ({ ...m, [site.id]: "sync" }));
    setSyncMsg((m) => ({ ...m, [site.id]: "" }));
    try {
      const res = await fetch(`/api/websites/${site.id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      setSyncMsg((m) => ({
        ...m,
        [site.id]: res.ok
          ? data.noop
            ? "Nothing to sync — files are local."
            : `✓ Synced ${data.fileCount} file(s)${data.mock ? " (mock)" : ""}`
          : `✗ ${data.error ?? "Sync failed"}`,
      }));
    } finally {
      setOpBusy((m) => {
        const n = { ...m };
        delete n[site.id];
        return n;
      });
    }
  }

  async function deploySite(site: SiteSummary) {
    setOpBusy((m) => ({ ...m, [site.id]: "deploy" }));
    try {
      const res = await fetch(`/api/websites/${site.id}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      setDeployRes((m) => ({ ...m, [site.id]: data }));
    } finally {
      setOpBusy((m) => {
        const n = { ...m };
        delete n[site.id];
        return n;
      });
    }
  }

  async function deleteSite(site: SiteSummary) {
    if (!confirm(`Delete site "${site.name}"? The working copy is removed too.`)) return;
    await fetch(`/api/websites/${site.id}?projectId=${projectId}`, { method: "DELETE" });
    await refresh();
  }

  if (loading) return <p className="text-sm text-zinc-500">Loading sites…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Sites</h2>
        <div className="flex gap-2">
          <Link
            href={`/dashboard/projects/${projectId}/sites/new`}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white"
          >
            ＋ AI landing-page builder
          </Link>
          <button
            onClick={() => { setForm(form === "github" ? null : "github"); setError(null); }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500"
          >
            Connect GitHub
          </button>
          <button
            onClick={() => { setForm(form === "upload" ? null : "upload"); setError(null); }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500"
          >
            Upload .zip
          </button>
          <button
            onClick={() => { const n = form === "sftp" ? null : "sftp"; setForm(n); setError(null); if (n === "sftp") void loadConns(); }}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500"
          >
            Link SFTP
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {form === "github" && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">Connect a GitHub repo</h3>
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={ghDemo} onChange={(e) => { setGhDemo(e.target.checked); setGhRepos(null); }} />
            Use demo repo <span className="text-xs text-zinc-600">(mock — no token or network needed)</span>
          </label>
          {!ghDemo && (
            <label className="mt-3 block text-sm text-zinc-400">
              Personal access token <span className="text-xs text-zinc-600">(needs repo scope; stored encrypted)</span>
              <input
                type="password"
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
                placeholder="ghp_…"
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100"
              />
            </label>
          )}
          <div className="mt-3">
            <button
              onClick={() => void loadGhRepos()}
              disabled={ghReposBusy || (!ghDemo && !ghToken.trim())}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
            >
              {ghReposBusy ? "Loading…" : "List my repos"}
            </button>
          </div>
          {ghRepos && (
            <div className="mt-3 flex flex-col gap-3">
              <label className="block text-sm text-zinc-400">
                Repository
                <select
                  value={ghSelected}
                  onChange={(e) => {
                    setGhSelected(e.target.value);
                    const r = ghRepos.find((x) => x.fullName === e.target.value);
                    if (r) setGhBranch(r.defaultBranch || "main");
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
                >
                  {ghRepos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}{r.mock ? " (mock)" : ""}{r.private ? " 🔒" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-zinc-400">
                …or create a new repo
                <input
                  value={ghNewName}
                  onChange={(e) => setGhNewName(e.target.value)}
                  placeholder="my-new-site (private)"
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm text-zinc-400">
                  Branch
                  <input value={ghBranch} onChange={(e) => setGhBranch(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100" />
                </label>
                <label className="block text-sm text-zinc-400">
                  Site name
                  <input value={ghName} onChange={(e) => setGhName(e.target.value)} placeholder="Defaults to repo name" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" />
                </label>
              </div>
              <div>
                <button
                  onClick={() => void createGhSite()}
                  disabled={busy}
                  className="rounded-md bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
                >
                  {busy ? "Connecting…" : "Connect repo"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {form === "upload" && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">Upload a site</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm text-zinc-400">
              Site name
              <input value={upName} onChange={(e) => setUpName(e.target.value)} placeholder="Client landing page" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="block text-sm text-zinc-400">
              .zip archive or single .html
              <input
                type="file"
                accept=".zip,.html,.htm"
                onChange={(e) => setUpFile(e.target.files?.[0] ?? null)}
                className="mt-1 w-full text-sm text-zinc-300"
              />
            </label>
          </div>
          <button
            onClick={() => void createUploadSite()}
            disabled={busy}
            className="mt-3 rounded-md bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload & create site"}
          </button>
        </div>
      )}

      {form === "sftp" && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-200">Link an SFTP connection</h3>
          {conns === null ? (
            <p className="text-sm text-zinc-500">Loading connections…</p>
          ) : conns.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No SFTP connections yet — add one in the <Link href={`/dashboard/projects/${projectId}/ide`} className="underline">Site IDE</Link> first.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="block text-sm text-zinc-400">
                Connection
                <select value={sftpConnId} onChange={(e) => setSftpConnId(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100">
                  {conns.map((c) => (
                    <option key={c.id} value={c.id}>{c.label} — {c.host}{c.demo ? " (mock)" : ""}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-zinc-400">
                Site name
                <input value={sftpName} onChange={(e) => setSftpName(e.target.value)} placeholder="Client production" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" />
              </label>
              <div>
                <button
                  onClick={() => void createSftpSite()}
                  disabled={busy}
                  className="rounded-md bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
                >
                  {busy ? "Linking…" : "Link connection"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {sites.map((site) => {
          const d = deployRes[site.id];
          return (
            <div key={site.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-zinc-100">{site.name}</span>
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${site.isMock ? "bg-amber-950 text-amber-200" : "bg-emerald-950 text-emerald-200"}`}>
                    {SOURCE_LABEL[site.sourceType]}{site.isMock ? " · mock" : ""}
                  </span>
                  {site.github && (
                    <span className="ml-2 font-mono text-xs text-zinc-500">
                      {site.github.owner}/{site.github.repo}@{site.github.branch}
                    </span>
                  )}
                  {site.sftpConnection && (
                    <span className="ml-2 font-mono text-xs text-zinc-500">via {site.sftpConnection.label}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/dashboard/projects/${projectId}/ide?siteId=${site.id}`}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500"
                  >
                    Open in IDE
                  </Link>
                  {site.sourceType !== "file" && (
                    <button
                      onClick={() => void syncSite(site)}
                      disabled={!!opBusy[site.id]}
                      className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
                    >
                      {opBusy[site.id] === "sync" ? "Syncing…" : "Sync ↓"}
                    </button>
                  )}
                  <button
                    onClick={() => void deploySite(site)}
                    disabled={!!opBusy[site.id]}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
                  >
                    {opBusy[site.id] === "deploy" ? "Deploying…" : "Deploy ↑"}
                  </button>
                  <a
                    href={`/api/websites/${site.id}/download?projectId=${projectId}`}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
                  >
                    .zip
                  </a>
                  <button
                    onClick={() => void deleteSite(site)}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-red-300 hover:border-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {syncMsg[site.id] && <p className="mt-2 text-xs text-zinc-400">{syncMsg[site.id]}</p>}
              {d && (
                <div className="mt-3 rounded-md border border-zinc-800 p-3 text-xs">
                  {d.error && !d.ok && d.fileCount === 0 ? (
                    <p className="text-red-400">✗ {d.error}</p>
                  ) : (
                    <>
                      <p className={d.ok ? "text-emerald-300" : "text-amber-300"}>
                        {d.ok ? "✓ Deployed" : "⚠ Partial deploy"} — {d.fileCount} file(s)
                        {d.commitSha && <span className="ml-2 font-mono">commit {d.commitSha.slice(0, 12)}</span>}
                        {d.mock && <span className="ml-2">(mock)</span>}
                        {d.downloadUrl && (
                          <a href={`${d.downloadUrl}`} className="ml-2 underline">Download .zip</a>
                        )}
                      </p>
                      {!d.ok && d.error && <p className="mt-1 text-red-400">{d.error}</p>}
                      <ul className="mt-2 max-h-32 overflow-auto font-mono text-zinc-500">
                        {d.perFile.slice(0, 50).map((f) => (
                          <li key={f.path} className={f.ok ? "" : "text-red-400"}>
                            {f.ok ? "✓" : "✗"} {f.path}{f.error ? ` — ${f.error}` : ""}
                          </li>
                        ))}
                        {d.perFile.length > 50 && <li>…and {d.perFile.length - 50} more</li>}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {sites.length === 0 && (
          <p className="text-sm text-zinc-500">
            No sites yet — build one with the AI landing-page builder, connect a GitHub repo, or upload a .zip.
          </p>
        )}
      </div>
    </div>
  );
}
