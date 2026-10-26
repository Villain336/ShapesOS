"use client";

// ShapesOS — Dev preview tab strip (in-product browser v1). One tab per
// (project, port); the active tab shows that project's dev server through
// the authenticated proxy. Tabs persist in localStorage. A tab whose
// sandbox is paused shows Resume (the ONLY wake path - explicit, never
// traffic-driven); a project with none shows Start.

import { useCallback, useEffect, useState } from "react";
import { Globe, Pause, Play, Plus, RotateCw, X } from "lucide-react";

interface ProjectOpt { id: string; name: string }
interface Tab { key: string; projectId: string; port: number }
type Status = { status: string; exposedPorts: number[]; previews?: { port: number; url: string }[] } | null;

export interface BrowserLabels {
  newTab: string; closeTab: string; project: string; pickProject: string; port: string;
  openTab: string; start: string; starting: string; resume: string; resuming: string;
  pause: string; paused: string; none: string; empty: string; stopsItself: string;
  sessionExpired: string; reloadPreview: string;
}

const STORE_KEY = "shapes.dev-preview.tabs.v1";

function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Tab[]) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => t && t.projectId && t.port > 0) : [];
  } catch { return []; }
}

export function BrowserPanel({ projects, labels }: { projects: ProjectOpt[]; labels: BrowserLabels }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [port, setPort] = useState("3000");

  useEffect(() => {
    const t = loadTabs();
    setTabs(t);
    if (t[0]) setActive(t[0].key);
  }, []);
  useEffect(() => {
    if (tabs.length) localStorage.setItem(STORE_KEY, JSON.stringify(tabs));
  }, [tabs]);

  const openTab = () => {
    const p = Number(port);
    if (!projectId || !Number.isInteger(p) || p < 1 || p > 65535) return;
    const key = `${projectId}:${p}`;
    setTabs((ts) => (ts.some((t) => t.key === key) ? ts : [...ts, { key, projectId, port: p }]));
    setActive(key);
    setAdding(false);
  };
  const closeTab = (key: string) => {
    setTabs((ts) => {
      const next = ts.filter((t) => t.key !== key);
      if (active === key) setActive(next[next.length - 1]?.key ?? null);
      if (!next.length) localStorage.removeItem(STORE_KEY);
      return next;
    });
  };

  const tab = tabs.find((t) => t.key === active) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1" role="tablist" aria-label={labels.newTab}>
        {tabs.map((t) => {
          const proj = projects.find((p) => p.id === t.projectId);
          const isActive = t.key === active;
          return (
            <div
              key={t.key}
              role="tab"
              aria-selected={isActive}
              className={`flex items-center gap-1.5 rounded-t-md border border-b-0 border-line px-3 py-1.5 text-xs ${isActive ? "bg-panel text-strong" : "text-muted hover:text-strong"}`}
            >
              <button type="button" className="flex items-center gap-1.5" onClick={() => setActive(t.key)}>
                <Globe className="h-3.5 w-3.5" aria-hidden />
                <span>{proj?.name ?? t.projectId}:{t.port}</span>
              </button>
              <button type="button" aria-label={labels.closeTab} className="text-muted hover:text-strong" onClick={() => closeTab(t.key)}>
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => setAdding((a) => !a)}
          className="ml-1 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted hover:text-strong"
          aria-label={labels.newTab}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> {labels.newTab}
        </button>
      </div>

      {adding ? (
        <div className="flex items-end gap-2 border-b border-line px-3 py-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted">{labels.project}</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="rounded-md border border-line bg-panel px-2 py-1 text-sm"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">{labels.port}</span>
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
              className="w-24 rounded-md border border-line bg-panel px-2 py-1 text-sm"
            />
          </label>
          <button type="button" onClick={openTab} className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-foreground">
            {labels.openTab}
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {tab ? (
          <PreviewPane key={tab.key} tab={tab} labels={labels} />
        ) : (
          <p className="p-6 text-sm text-muted">{labels.empty}</p>
        )}
      </div>
      <p className="border-t border-line px-3 py-1.5 text-xs text-muted">{labels.stopsItself}</p>
    </div>
  );
}

function PreviewPane({ tab, labels }: { tab: Tab; labels: BrowserLabels }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<"start" | "resume" | "pause" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${tab.projectId}/dev-sandbox`, { cache: "no-store" });
      if (r.ok) setStatus(await r.json());
      else setStatus({ status: "none", exposedPorts: [] });
    } catch {
      setStatus({ status: "none", exposedPorts: [] });
    }
  }, [tab.projectId]);
  useEffect(() => { refresh(); }, [refresh]);
  // Owning-session renewal: while this tab is VISIBLE, poll status so the
  // preview token's sliding expiry is extended. Background tabs are
  // throttled by the browser; the 1h TTL absorbs it, and a lapsed token
  // surfaces the explicit reload affordance below - never a silent reload.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (method: "POST" | "DELETE", which: "start" | "resume" | "pause") => {
    setBusy(which);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${tab.projectId}/dev-sandbox`, { method });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `${r.status}`);
      }
    } finally {
      setBusy(null);
      await refresh();
      setFrameKey((k) => k + 1);
    }
  };

  const running = status?.status === "running";
  // The iframe URL comes from the status endpoint (capability URL). It is
  // NEVER rendered: the token is a bearer secret, so chrome shows the
  // tokenless project:port label only.
  const previewUrl = status?.previews?.find((p) => p.port === tab.port)?.url ?? null;
  // Token rotation while a LIVE document is loaded must not silently swap
  // the iframe src (that reloads the app and loses unsaved state). The
  // RENDERED url is its own state: it advances only on first load, on an
  // explicit user reload, or when no live document is mounted - never as a
  // side effect of a status poll returning a rotated token.
  const [renderedUrl, setRenderedUrl] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!previewUrl || !running) { setRenderedUrl(null); setExpired(false); return; }
    if (renderedUrl === null || renderedUrl === previewUrl) {
      setRenderedUrl(previewUrl);
      setExpired(false);
      return;
    }
    // Rotation while a document is live: hold the OLD url, show the
    // explicit reload affordance. Nothing here touches renderedUrl.
    setExpired(true);
  }, [previewUrl, running, renderedUrl]);
  const src = renderedUrl ?? previewUrl ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
        <span className="text-muted">{tab.key}</span>
        <span className="flex-1" />
        {running ? (
          <>
            <button type="button" aria-label="Reload" className="text-muted hover:text-strong" onClick={() => setFrameKey((k) => k + 1)}>
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act("DELETE", "pause")}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-muted hover:text-strong disabled:opacity-50"
            >
              <Pause className="h-3 w-3" aria-hidden /> {labels.pause}
            </button>
          </>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {/* sandbox mirrors SANDBOX_PREVIEW_CSP (observed-compatible in the
            real-browser harness): belt+braces if the CSP header is lost. */}
        {running && previewUrl ? (
          <div className="flex h-full min-h-0 flex-col">
            {expired ? (
              <div className="flex items-center justify-center gap-3 border-b border-line bg-panel px-3 py-2 text-xs">
                <span className="text-muted">{labels.sessionExpired}</span>
                <button
                  type="button"
                  onClick={() => { setRenderedUrl(previewUrl); setExpired(false); setFrameKey((k) => k + 1); }}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-accent-foreground"
                >
                  <RotateCw className="h-3 w-3" aria-hidden /> {labels.reloadPreview}
                </button>
              </div>
            ) : null}
            {/* renderedUrl holds the OLD url while expired (unsaved state
                survives) until the user explicitly reloads. */}
            <iframe
              key={frameKey}
              src={src}
              title={tab.key}
              sandbox="allow-scripts allow-forms allow-modals allow-downloads"
              className="h-full w-full flex-1 border-0 bg-white"
            />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="max-w-md text-sm text-muted">
              {status?.status === "paused" ? labels.paused : labels.none}
            </p>
            {error ? <p className="max-w-md text-sm text-danger">{error}</p> : null}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act("POST", status?.status === "paused" ? "resume" : "start")}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-foreground disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              {status?.status === "paused"
                ? busy === "resume" ? labels.resuming : labels.resume
                : busy === "start" ? labels.starting : labels.start}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
