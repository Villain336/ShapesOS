// Marketr — sites manager (milestone 7): list, connect, sync, deploy.
// A Site is the unit the builder creates and the IDE edits — GitHub repo,
// SFTP host (via a milestone-6 connection), or uploaded/managed files.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ContentBrowser from "./ContentBrowser";

interface SiteSummary {
  id: string;
  name: string;
  sourceType: "github" | "sftp" | "file" | "wordpress" | "webflow";
  isMock: boolean;
  isLive: boolean;
  github: { owner: string; repo: string; branch: string; demo: boolean } | null;
  wordpress: { baseUrl: string; username: string; demo: boolean } | null;
  webflow: { siteId: string; demo: boolean } | null;
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
  wordpress: "WordPress",
  webflow: "Webflow",
};

export default function SitesManager({ projectId }: { projectId: string }) {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<"github" | "upload" | "sftp" | "wordpress" | "webflow" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // WordPress form
  const [wpUrl, setWpUrl] = useState("");
  const [wpUser, setWpUser] = useState("");
  const [wpPass, setWpPass] = useState("");
  const [wpDemo, setWpDemo] = useState(false);
  const [wpTest, setWpTest] = useState<string | null>(null);
  const [wpTestBusy, setWpTestBusy] = useState(false);
  const [wpName, setWpName] = useState("");

  // Webflow form
  const [wfToken, setWfToken] = useState("");
  const [wfDemo, setWfDemo] = useState(false);
  const [wfTest, setWfTest] = useState<string | null>(null);
  const [wfTestBusy, setWfTestBusy] = useState(false);
  const [wfSites, setWfSites] = useState<{ id: string; name: string }[]>([]);
  const [wfSiteId, setWfSiteId] = useState("");
  const [wfName, setWfName] = useState("");

  // Publish landing page → WordPress/Webflow
  const [pubSite, setPubSite] = useState<SiteSummary | null>(null);
  const [pubTarget, setPubTarget] = useState("");
  const [pubTitle, setPubTitle] = useState("");
  const [pubSlug, setPubSlug] = useState("");
  const [pubStatus, setPubStatus] = useState("draft");
  const [pubCollection, setPubCollection] = useState("");
  const [pubCollections, setPubCollections] = useState<{ id: string; title: string }[]>([]);
  const [pubPublishSite, setPubPublishSite] = useState(true);
  const [pubBusy, setPubBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<string | null>(null);

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

  async function testWp() {
    setWpTestBusy(true);
    setWpTest(null);
    setError(null);
    try {
      const res = await fetch("/api/websites/wordpress/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, baseUrl: wpUrl, username: wpUser, appPassword: wpPass, demo: wpDemo || undefined }),
      });
      const data = await res.json();
      setWpTest(res.ok ? `✓ ${data.info}` : `✗ ${data.error ?? "Test failed"}`);
    } finally {
      setWpTestBusy(false);
    }
  }

  async function createWpSite() {
    setError(null);
    if (!wpDemo && (!wpUrl.trim() || !wpUser.trim() || !wpPass.trim())) {
      setError("Site URL, username, and application password are required");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: wpName.trim() || wpUrl.replace(/^https?:\/\//, "") || "WordPress site",
          sourceType: "wordpress",
          wordpress: { baseUrl: wpUrl.trim(), username: wpUser.trim(), appPassword: wpPass, demo: wpDemo || undefined },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create site");
        return;
      }
      setForm(null);
      setWpUrl(""); setWpUser(""); setWpPass(""); setWpName(""); setWpTest(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function testWf() {
    setWfTestBusy(true);
    setWfTest(null);
    setWfSites([]);
    setError(null);
    try {
      const res = await fetch("/api/websites/webflow/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, token: wfToken, demo: wfDemo || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setWfTest(`✗ ${data.error ?? "Test failed"}`);
        return;
      }
      setWfTest(`✓ ${data.info}`);
      setWfSites(data.sites ?? []);
      if (data.sites?.length === 1) setWfSiteId(data.sites[0].id);
    } finally {
      setWfTestBusy(false);
    }
  }

  async function createWfSite() {
    setError(null);
    if (!wfDemo && !wfToken.trim()) {
      setError("API token is required");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: wfName.trim() || wfSites.find((s) => s.id === wfSiteId)?.name || "Webflow site",
          sourceType: "webflow",
          webflow: { token: wfToken, siteId: wfSiteId, demo: wfDemo || undefined },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create site");
        return;
      }
      setForm(null);
      setWfToken(""); setWfSiteId(""); setWfSites([]); setWfName(""); setWfTest(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function openPublishModal(site: SiteSummary) {
    setPubSite(site);
    setPubTitle(site.name);
    setPubSlug("");
    setPubStatus("draft");
    setPubCollection("");
    setPubCollections([]);
    setPubPublishSite(true);
    setPubMsg(null);
    const targets = sites.filter((s) => s.sourceType === "wordpress" || s.sourceType === "webflow");
    setPubTarget(targets[0]?.id ?? "");
    void loadPubCollections(targets[0]);
  }

  async function loadPubCollections(target?: SiteSummary) {
    setPubCollections([]);
    if (!target || target.sourceType !== "webflow") return;
    try {
      const res = await fetch(`/api/websites/${target.id}/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action: "list", kind: "collection" }),
      });
      const data = await res.json();
      if (res.ok) {
        setPubCollections(data.items);
        if (data.items.length > 0) setPubCollection(data.items[0].id);
      }
    } catch {
      /* leave empty — user picks manually */
    }
  }

  async function runPublish() {
    if (!pubSite || !pubTarget) return;
    setPubBusy(true);
    setPubMsg(null);
    setError(null);
    try {
      const res = await fetch(`/api/websites/${pubSite.id}/publish-content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          targetSiteId: pubTarget,
          title: pubTitle,
          slug: pubSlug,
          status: pubStatus,
          collectionId: pubCollection || undefined,
          webflowPublish: pubPublishSite,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPubMsg(`✗ ${data.error ?? "Publish failed"}`);
        return;
      }
      setPubMsg(
        `✓ Published as “${data.item.title}”${data.published ? " — Webflow site published" : ""}${data.mock ? " (mock)" : ""}${data.item.link ? ` — ${data.item.link}` : ""}`,
      );
    } finally {
      setPubBusy(false);
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
        <h2 className="text-sm font-semibold text-zinc-800">Sites</h2>
        <div className="flex gap-2">
          <Link
            href={`/dashboard/projects/${projectId}/sites/new`}
            className="rounded-md bg-orange-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-800 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
          >
            ＋ AI landing-page builder
          </Link>
          <button
            onClick={() => { setForm(form === "github" ? null : "github"); setError(null); }}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400"
          >
            Connect GitHub
          </button>
          <button
            onClick={() => { setForm(form === "upload" ? null : "upload"); setError(null); }}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400"
          >
            Upload .zip
          </button>
          <button
            onClick={() => { const n = form === "sftp" ? null : "sftp"; setForm(n); setError(null); if (n === "sftp") void loadConns(); }}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400"
          >
            Link SFTP
          </button>
          <button
            onClick={() => { setForm(form === "wordpress" ? null : "wordpress"); setError(null); }}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400"
          >
            Connect WordPress
          </button>
          <button
            onClick={() => { setForm(form === "webflow" ? null : "webflow"); setError(null); }}
            className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400"
          >
            Connect Webflow
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {form === "github" && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-800">Connect a GitHub repo</h3>
          <label className="flex items-center gap-2 text-sm text-zinc-500">
            <input type="checkbox" checked={ghDemo} onChange={(e) => { setGhDemo(e.target.checked); setGhRepos(null); }} />
            Use demo repo <span className="text-xs text-zinc-500">(mock — no token or network needed)</span>
          </label>
          {!ghDemo && (
            <label className="mt-3 block text-sm text-zinc-500">
              Personal access token <span className="text-xs text-zinc-500">(needs repo scope; stored encrypted)</span>
              <input
                type="password"
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
                placeholder="ghp_…"
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900"
              />
            </label>
          )}
          <div className="mt-3">
            <button
              onClick={() => void loadGhRepos()}
              disabled={ghReposBusy || (!ghDemo && !ghToken.trim())}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400 disabled:opacity-50"
            >
              {ghReposBusy ? "Loading…" : "List my repos"}
            </button>
          </div>
          {ghRepos && (
            <div className="mt-3 flex flex-col gap-3">
              <label className="block text-sm text-zinc-500">
                Repository
                <select
                  value={ghSelected}
                  onChange={(e) => {
                    setGhSelected(e.target.value);
                    const r = ghRepos.find((x) => x.fullName === e.target.value);
                    if (r) setGhBranch(r.defaultBranch || "main");
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900"
                >
                  {ghRepos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}{r.mock ? " (mock)" : ""}{r.private ? " 🔒" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-zinc-500">
                …or create a new repo
                <input
                  value={ghNewName}
                  onChange={(e) => setGhNewName(e.target.value)}
                  placeholder="my-new-site (private)"
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm text-zinc-500">
                  Branch
                  <input value={ghBranch} onChange={(e) => setGhBranch(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900" />
                </label>
                <label className="block text-sm text-zinc-500">
                  Site name
                  <input value={ghName} onChange={(e) => setGhName(e.target.value)} placeholder="Defaults to repo name" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900" />
                </label>
              </div>
              <div>
                <button
                  onClick={() => void createGhSite()}
                  disabled={busy}
                  className="rounded-md bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                >
                  {busy ? "Connecting…" : "Connect repo"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {form === "upload" && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-800">Upload a site</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm text-zinc-500">
              Site name
              <input value={upName} onChange={(e) => setUpName(e.target.value)} placeholder="Client landing page" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900" />
            </label>
            <label className="block text-sm text-zinc-500">
              .zip archive or single .html
              <input
                type="file"
                accept=".zip,.html,.htm"
                onChange={(e) => setUpFile(e.target.files?.[0] ?? null)}
                className="mt-1 w-full text-sm text-zinc-500"
              />
            </label>
          </div>
          <button
            onClick={() => void createUploadSite()}
            disabled={busy}
            className="mt-3 rounded-md bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
          >
            {busy ? "Uploading…" : "Upload & create site"}
          </button>
        </div>
      )}

      {form === "sftp" && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-zinc-800">Link an SFTP connection</h3>
          {conns === null ? (
            <p className="text-sm text-zinc-500">Loading connections…</p>
          ) : conns.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No SFTP connections yet — add one in the <Link href={`/dashboard/projects/${projectId}/ide`} className="underline">Site IDE</Link> first.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="block text-sm text-zinc-500">
                Connection
                <select value={sftpConnId} onChange={(e) => setSftpConnId(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900">
                  {conns.map((c) => (
                    <option key={c.id} value={c.id}>{c.label} — {c.host}{c.demo ? " (mock)" : ""}</option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-zinc-500">
                Site name
                <input value={sftpName} onChange={(e) => setSftpName(e.target.value)} placeholder="Client production" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900" />
              </label>
              <div>
                <button
                  onClick={() => void createSftpSite()}
                  disabled={busy}
                  className="rounded-md bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                >
                  {busy ? "Linking…" : "Link connection"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {form === "wordpress" && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="mb-1 text-sm font-semibold text-zinc-800">Connect WordPress</h3>
          <p className="mb-3 text-xs text-zinc-500">
            Content-level access via the WP REST API: pages, posts, media. Theme/plugin files are not reachable — the UI labels this honestly.
          </p>
          <label className="flex items-center gap-2 text-sm text-zinc-500">
            <input type="checkbox" checked={wpDemo} onChange={(e) => { setWpDemo(e.target.checked); setWpTest(null); }} />
            Use demo site <span className="text-xs text-zinc-500">(mock — no credentials or network needed)</span>
          </label>
          {!wpDemo && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="col-span-2 block text-sm text-zinc-500">
                Site URL
                <input value={wpUrl} onChange={(e) => setWpUrl(e.target.value)} placeholder="https://client.example.com" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900" />
              </label>
              <label className="block text-sm text-zinc-500">
                Username
                <input value={wpUser} onChange={(e) => setWpUser(e.target.value)} placeholder="admin" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900" />
              </label>
              <label className="block text-sm text-zinc-500">
                Application password <span className="text-xs text-zinc-500">(Users → Profile; stored encrypted)</span>
                <input type="password" value={wpPass} onChange={(e) => setWpPass(e.target.value)} placeholder="xxxx xxxx xxxx xxxx" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900" />
              </label>
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => void testWp()}
              disabled={wpTestBusy}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400 disabled:opacity-50"
            >
              {wpTestBusy ? "Testing…" : "Test connection"}
            </button>
            {wpTest && <span className="text-xs text-zinc-500">{wpTest}</span>}
          </div>
          <div className="mt-3 flex items-end gap-3">
            <label className="block flex-1 text-sm text-zinc-500">
              Site name
              <input value={wpName} onChange={(e) => setWpName(e.target.value)} placeholder="Client WordPress" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900" />
            </label>
            <button
              onClick={() => void createWpSite()}
              disabled={busy}
              className="rounded-md bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
            >
              {busy ? "Connecting…" : "Connect site"}
            </button>
          </div>
        </div>
      )}

      {form === "webflow" && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="mb-1 text-sm font-semibold text-zinc-800">Connect Webflow</h3>
          <p className="mb-3 text-xs text-zinc-500">
            Content-level access via the Webflow API v2: CMS collections, items, and site publishing. Page designs are not API-editable.
          </p>
          <label className="flex items-center gap-2 text-sm text-zinc-500">
            <input type="checkbox" checked={wfDemo} onChange={(e) => { setWfDemo(e.target.checked); setWfTest(null); setWfSites([]); }} />
            Use demo workspace <span className="text-xs text-zinc-500">(mock — no token or network needed)</span>
          </label>
          {!wfDemo && (
            <label className="mt-3 block text-sm text-zinc-500">
              API token <span className="text-xs text-zinc-500">(site or workspace token; stored encrypted)</span>
              <input type="password" value={wfToken} onChange={(e) => setWfToken(e.target.value)} placeholder="wf_…" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900" />
            </label>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => void testWf()}
              disabled={wfTestBusy}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 hover:border-zinc-400 disabled:opacity-50"
            >
              {wfTestBusy ? "Testing…" : "Test connection"}
            </button>
            {wfTest && <span className="text-xs text-zinc-500">{wfTest}</span>}
          </div>
          {wfSites.length > 0 && (
            <label className="mt-3 block text-sm text-zinc-500">
              Webflow site
              <select value={wfSiteId} onChange={(e) => setWfSiteId(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900">
                <option value="">— pick a site —</option>
                {wfSites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
          <div className="mt-3 flex items-end gap-3">
            <label className="block flex-1 text-sm text-zinc-500">
              Site name
              <input value={wfName} onChange={(e) => setWfName(e.target.value)} placeholder="Client Webflow" className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900" />
            </label>
            <button
              onClick={() => void createWfSite()}
              disabled={busy}
              className="rounded-md bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
            >
              {busy ? "Connecting…" : "Connect site"}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {sites.map((site) => {
          const d = deployRes[site.id];
          const isContent = site.sourceType === "wordpress" || site.sourceType === "webflow";
          return (
            <div key={site.id} className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-zinc-900">{site.name}</span>
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${site.isMock ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
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
                  {site.wordpress && (
                    <span className="ml-2 font-mono text-xs text-zinc-500">{site.wordpress.baseUrl}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!isContent && (
                    <Link
                      href={`/dashboard/projects/${projectId}/ide?siteId=${site.id}`}
                      className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-800 hover:border-zinc-400"
                    >
                      Open in IDE
                    </Link>
                  )}
                  {site.sourceType !== "file" && !isContent && (
                    <button
                      onClick={() => void syncSite(site)}
                      disabled={!!opBusy[site.id]}
                      className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-50"
                    >
                      {opBusy[site.id] === "sync" ? "Syncing…" : "Sync ↓"}
                    </button>
                  )}
                  {!isContent && (
                    <button
                      onClick={() => void deploySite(site)}
                      disabled={!!opBusy[site.id]}
                      className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-50"
                    >
                      {opBusy[site.id] === "deploy" ? "Deploying…" : "Deploy ↑"}
                    </button>
                  )}
                  {site.sourceType === "file" && (
                    <button
                      onClick={() => openPublishModal(site)}
                      disabled={!sites.some((s) => s.sourceType === "wordpress" || s.sourceType === "webflow")}
                      title="Publish this landing page to WordPress or Webflow"
                      className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-50"
                    >
                      Publish to…
                    </button>
                  )}
                  {!isContent && (
                    <a
                      href={`/api/websites/${site.id}/download?projectId=${projectId}`}
                      className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400"
                    >
                      .zip
                    </a>
                  )}
                  <button
                    onClick={() => void deleteSite(site)}
                    className="rounded border border-zinc-200 px-2 py-1 text-xs text-red-700 hover:border-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {(site.sourceType === "wordpress" || site.sourceType === "webflow") && (
                <ContentBrowser
                  projectId={projectId}
                  siteId={site.id}
                  sourceType={site.sourceType}
                  isMock={site.isMock}
                />
              )}
              {syncMsg[site.id] && <p className="mt-2 text-xs text-zinc-500">{syncMsg[site.id]}</p>}
              {d && (
                <div className="mt-3 rounded-md border border-zinc-200 p-3 text-xs">
                  {d.error && !d.ok && d.fileCount === 0 ? (
                    <p className="text-red-600">✗ {d.error}</p>
                  ) : (
                    <>
                      <p className={d.ok ? "text-emerald-700" : "text-amber-700"}>
                        {d.ok ? "✓ Deployed" : "⚠ Partial deploy"} — {d.fileCount} file(s)
                        {d.commitSha && <span className="ml-2 font-mono">commit {d.commitSha.slice(0, 12)}</span>}
                        {d.mock && <span className="ml-2">(mock)</span>}
                        {d.downloadUrl && (
                          <a href={`${d.downloadUrl}`} className="ml-2 underline">Download .zip</a>
                        )}
                      </p>
                      {!d.ok && d.error && <p className="mt-1 text-red-600">{d.error}</p>}
                      <ul className="mt-2 max-h-32 overflow-auto font-mono text-zinc-500">
                        {d.perFile.slice(0, 50).map((f) => (
                          <li key={f.path} className={f.ok ? "" : "text-red-600"}>
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
            No sites yet — build one with the AI landing-page builder, connect a GitHub repo, WordPress, or Webflow, or upload a .zip.
          </p>
        )}
      </div>

      {pubSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-lg border border-zinc-200 bg-zinc-50 p-5">
            <h3 className="text-sm font-semibold text-zinc-800">
              Publish “{pubSite.name}” to…
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              The landing page HTML (index.html) becomes a WordPress page or a Webflow CMS item. Content-level publishing — designs are not touched.
            </p>
            <label className="mt-3 block text-sm text-zinc-500">
              Target site
              <select
                value={pubTarget}
                onChange={(e) => {
                  setPubTarget(e.target.value);
                  void loadPubCollections(sites.find((s) => s.id === e.target.value));
                }}
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900"
              >
                {sites.filter((s) => s.sourceType === "wordpress" || s.sourceType === "webflow").map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({SOURCE_LABEL[s.sourceType]}){s.isMock ? " · mock" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-sm text-zinc-500">
                Title
                <input value={pubTitle} onChange={(e) => setPubTitle(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900" />
              </label>
              <label className="block text-sm text-zinc-500">
                Slug <span className="text-xs text-zinc-500">(auto from title if empty)</span>
                <input value={pubSlug} onChange={(e) => setPubSlug(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 font-mono text-sm text-zinc-900" />
              </label>
              <label className="block text-sm text-zinc-500">
                Status
                <select value={pubStatus} onChange={(e) => setPubStatus(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900">
                  <option value="draft">Draft</option>
                  <option value="publish">Publish</option>
                </select>
              </label>
              {sites.find((s) => s.id === pubTarget)?.sourceType === "webflow" && (
                <label className="block text-sm text-zinc-500">
                  Collection
                  <select value={pubCollection} onChange={(e) => setPubCollection(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-900">
                    {pubCollections.map((c) => (
                      <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                    {pubCollections.length === 0 && <option value="">— no collections loaded —</option>}
                  </select>
                </label>
              )}
            </div>
            {sites.find((s) => s.id === pubTarget)?.sourceType === "webflow" && (
              <label className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
                <input type="checkbox" checked={pubPublishSite} onChange={(e) => setPubPublishSite(e.target.checked)} />
                Publish the Webflow site after creating the item
              </label>
            )}
            {pubMsg && <p className="mt-3 text-xs text-zinc-500">{pubMsg}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setPubSite(null)}
                className="rounded border border-zinc-200 px-4 py-1.5 text-sm text-zinc-500"
              >
                Close
              </button>
              <button
                onClick={() => void runPublish()}
                disabled={pubBusy || !pubTarget}
                className="rounded bg-orange-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-800 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
              >
                {pubBusy ? "Publishing…" : "Publish"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
