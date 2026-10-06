// Marketr — site IDE (milestone 6): SFTP file editing with AI assistance.
// Supervised rung of the fix-agent trust ladder: the AI only ever PROPOSES
// diffs; nothing is written without the user clicking "Apply". Every manual
// save and every proposal/application is written to the audit log.
// UI patterns adapted from the design-vault showcase (chat thread + composer,
// code editor pane) to Next.js App Router.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { diffLines } from "diff";
import { Folder, FileText, Plus, Lock, FlaskConical } from "lucide-react";
import { confirmAction, toastError } from "@/lib/ui/feedback";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-muted">
      Loading editor…
    </div>
  ),
});

// ---------------------------------------------------------------- types

interface Connection {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  secretHint: string | null;
  demo: boolean;
  isLive: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
}

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  modifiedAt?: string;
  mock?: boolean;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

interface Proposal {
  path: string;
  summary: string;
  proposedContent: string;
  /** Content the diff is computed against (fetched when needed). */
  originalContent: string | null;
  status: "pending" | "applying" | "applied" | "rejected";
}

interface AttachedFile {
  path: string;
  content: string;
}

interface ActivityEntry {
  id: string;
  filePath: string;
  actor: "user" | "ai";
  action: "save" | "ai_proposal" | "ai_applied";
  summary: string;
  approvedBy: string | null;
  createdAt: string;
}

interface LlmInfo {
  name: string;
  isLive: boolean;
  configured: boolean;
  model: string | null;
}

const EXT_LANG: Record<string, string> = {
  php: "php",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sql: "sql",
  sh: "shell",
  txt: "plaintext",
};

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (path.endsWith(".htaccess")) return "plaintext";
  return EXT_LANG[ext] ?? "plaintext";
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------- file tree

function TreeNode({
  entry,
  depth,
  apiBase,
  projectId,
  expanded,
  onToggle,
  onOpen,
  onAttach,
  openPath,
  loadChildren,
  children,
}: {
  entry: FileEntry;
  depth: number;
  apiBase: string;
  projectId: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (e: FileEntry) => void;
  onAttach: (e: FileEntry) => void;
  openPath: string | null;
  loadChildren: (dir: string) => void;
  children: FileEntry[] | undefined;
}) {
  const isDir = entry.type === "dir";
  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-sm px-2 py-1 text-sm ${
          openPath === entry.path
            ? "bg-ink text-white"
            : "text-muted hover:bg-hover-paper hover:text-ink"
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir ? (
          <button
            onClick={() => {
              onToggle();
              if (!expanded) loadChildren(entry.path);
            }}
            className="flex flex-1 items-center gap-1 text-left"
          >
            <span className="w-3 text-muted">{expanded ? "▾" : "▸"}</span>
            <Folder size={14} className="text-muted" />
            <span className="truncate">{entry.name}</span>
          </button>
        ) : (
          <>
            <button
              onClick={() => onOpen(entry)}
              className="flex min-w-0 flex-1 items-center gap-1 text-left"
            >
              <span className="w-3" />
              <FileText size={14} className="text-muted" />
              <span className="truncate font-mono text-[0.8125rem]">{entry.name}</span>
            </button>
            <button
              onClick={() => onAttach(entry)}
              title="Attach to AI chat"
              className="hidden rounded-full px-1 text-muted hover:text-ink group-hover:block"
            >
              <Plus size={13} />
            </button>
          </>
        )}
      </div>
      {isDir && expanded && (
        <div>
          {(children ?? []).map((c) => (
            <TreeNodeConnected
              key={c.path}
              entry={c}
              depth={depth + 1}
              apiBase={apiBase}
              projectId={projectId}
              onOpen={onOpen}
              onAttach={onAttach}
              openPath={openPath}
            />
          ))}
          {children && children.length === 0 && (
            <div
              className="py-1 text-xs text-muted"
              style={{ paddingLeft: `${depth * 12 + 28}px` }}
            >
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Small wrapper so each node owns its expanded state.
function TreeNodeConnected(props: {
  entry: FileEntry;
  depth: number;
  apiBase: string;
  projectId: string;
  onOpen: (e: FileEntry) => void;
  onAttach: (e: FileEntry) => void;
  openPath: string | null;
}) {
  const [expanded, setExpanded] = useState(props.depth === 0);
  const [children, setChildren] = useState<FileEntry[] | undefined>(undefined);
  const loadedRef = useRef(false);

  const loadChildren = useCallback(
    async (dir: string) => {
      if (loadedRef.current) return;
      loadedRef.current = true;
      const res = await fetch(
        `${props.apiBase}/files?projectId=${props.projectId}&path=${encodeURIComponent(dir)}`,
      );
      const data = await res.json();
      if (res.ok) setChildren(data.entries);
    },
    [props.apiBase, props.projectId],
  );

  useEffect(() => {
    if (props.depth === 0 && !loadedRef.current) {
      loadChildren(props.entry.path);
      setExpanded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TreeNode
      entry={props.entry}
      depth={props.depth}
      apiBase={props.apiBase}
      projectId={props.projectId}
      expanded={expanded}
      onToggle={() => setExpanded((e) => !e)}
      onOpen={props.onOpen}
      onAttach={props.onAttach}
      openPath={props.openPath}
      loadChildren={loadChildren}
      children={children}
    />
  );
}

// ---------------------------------------------------------------- diff view

function DiffView({ original, proposed }: { original: string; proposed: string }) {
  const parts = useMemo(() => diffLines(original, proposed), [original, proposed]);
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-canvas p-2 font-mono text-xs leading-5">
      {parts.map((part, i) => (
        <span
          key={i}
          className={
            part.added
              ? "block bg-paper font-semibold text-ink"
              : part.removed
                ? "block text-muted line-through"
                : "block text-muted"
          }
        >
          {part.added ? "+ " : part.removed ? "− " : "  "}
          {part.value.replace(/\n$/, "")}
        </span>
      ))}
    </pre>
  );
}

// ---------------------------------------------------------------- main

export default function SiteIde({
  projectId,
  domain,
  initialConnections,
  llm,
  // Milestone 7 — site mode: the IDE operates on a Site's working copy
  // through /api/websites/[siteId]/* instead of a raw SFTP connection.
  apiBase,
  siteMode,
  siteBanner,
  pageTitle,
  pageSubtitle,
}: {
  projectId: string;
  domain: string;
  initialConnections: Connection[];
  llm: LlmInfo;
  apiBase?: string;
  siteMode?: boolean;
  siteBanner?: { mock: boolean; title: string; detail: string } | null;
  pageTitle?: string;
  pageSubtitle?: string;
}) {
  const [connections, setConnections] = useState<Connection[]>(initialConnections);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConnections[0]?.id ?? null,
  );
  const [tab, setTab] = useState<"editor" | "activity">("editor");

  // Connection form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    label: "",
    host: "",
    port: "22",
    username: "",
    authType: "password",
    secret: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  // Editor
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const dirty = editorValue !== savedValue;

  // AI panel
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Activity
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);

  const selected = siteMode ? null : (connections.find((c) => c.id === selectedId) ?? null);

  // Base URL for file operations. Connection mode: /api/sites/<connId>.
  // Site mode (milestone 7): /api/websites/<siteId>.
  const fileBase: string | null = apiBase ?? (selectedId ? `/api/sites/${selectedId}` : null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, asking]);

  const refreshConnections = useCallback(async () => {
    const res = await fetch(`/api/sites?projectId=${projectId}`);
    const data = await res.json();
    if (res.ok) {
      setConnections(data.connections);
      if (!selectedId && data.connections.length > 0) {
        setSelectedId(data.connections[0].id);
      }
    }
  }, [projectId, selectedId]);

  // ---- connection actions

  async function createConnection(demo: boolean) {
    setFormError(null);
    setFormBusy(true);
    try {
      const body = demo
        ? { projectId, demo: true }
        : {
            projectId,
            label: form.label,
            host: form.host,
            port: parseInt(form.port, 10) || 22,
            username: form.username,
            authType: form.authType,
            secret: form.secret,
          };
      const res = await fetch("/api/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error ?? "Could not create connection");
        return;
      }
      setShowForm(false);
      setForm({ label: "", host: "", port: "22", username: "", authType: "password", secret: "" });
      await refreshConnections();
      setSelectedId(data.connection.id);
    } finally {
      setFormBusy(false);
    }
  }

  async function testConnection(conn: Connection) {
    const res = await fetch(`/api/sites/${conn.id}/test?projectId=${projectId}`, {
      method: "POST",
    });
    const data = await res.json();
    setTestMsg((m) => ({
      ...m,
      [conn.id]: data.ok ? `✓ ${data.message}` : `✗ ${data.message ?? data.error}`,
    }));
    await refreshConnections();
  }

  async function deleteConnection(conn: Connection) {
    if (!await confirmAction(`Remove connection "${conn.label}"?`)) return;
    await fetch(`/api/sites/${conn.id}?projectId=${projectId}`, { method: "DELETE" });
    if (selectedId === conn.id) {
      setSelectedId(null);
      setOpenPath(null);
    }
    await refreshConnections();
  }

  // ---- file actions

  const openFile = useCallback(
    async (entry: FileEntry) => {
      if (!fileBase) return;
      if (dirty && !await confirmAction("Discard unsaved changes?")) return;
      setFileLoading(true);
      setFileError(null);
      setTruncated(false);
      try {
        const res = await fetch(
          `${fileBase}/file?projectId=${projectId}&path=${encodeURIComponent(entry.path)}`,
        );
        const data = await res.json();
        if (!res.ok) {
          setFileError(data.error ?? "Cannot open file");
          return;
        }
        setOpenPath(entry.path);
        setEditorValue(data.content);
        setSavedValue(data.content);
        setTruncated(!!data.truncated);
      } finally {
        setFileLoading(false);
      }
    },
    [selectedId, projectId, dirty],
  );

  async function saveFile(source: "manual" | "ai", summary?: string) {
    if (!fileBase || !openPath) return;
    setSaving(true);
    try {
      const res = await fetch(`${fileBase}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, path: openPath, content: editorValue, source, summary }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error ?? "Save failed");
        return;
      }
      setSavedValue(editorValue);
      if (tab === "activity") void loadActivity();
    } finally {
      setSaving(false);
    }
  }

  async function attachFile(entry: FileEntry) {
    if (!fileBase) return;
    if (attached.some((a) => a.path === entry.path)) return;
    const res = await fetch(
      `${fileBase}/file?projectId=${projectId}&path=${encodeURIComponent(entry.path)}`,
    );
    const data = await res.json();
    if (res.ok) setAttached((a) => [...a, { path: entry.path, content: data.content }]);
  }

  // ---- AI assistant

  async function sendMessage() {
    const message = input.trim();
    if (!message || !fileBase || asking) return;
    if (!openPath) {
      toastError("Open a file first so the assistant has context.");
      return;
    }
    setInput("");
    const nextChat: ChatMessage[] = [...chat, { role: "user" as const, text: message }];
    setChat(nextChat);
    setAsking(true);
    try {
      const files = [
        { path: openPath, content: editorValue },
        ...attached.filter((a) => a.path !== openPath),
      ];
      const res = await fetch(`${fileBase}/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          path: openPath,
          files,
          message,
          history: nextChat.slice(-8),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setChat((c) => [...c, { role: "assistant", text: `Error: ${data.error ?? "request failed"}` }]);
        return;
      }
      setChat((c) => [
        ...c,
        {
          role: "assistant",
          text:
            data.explanation ||
            (data.proposals.length > 0
              ? `Proposed changes to ${data.proposals.length} file(s) — review below.`
              : "No changes proposed."),
        },
      ]);
      // Resolve original content for each proposal so diffs render.
      const withOriginals: Proposal[] = await Promise.all(
        (data.proposals as { path: string; summary: string; proposedContent: string }[]).map(
          async (p) => {
            let original: string | null = null;
            if (p.path === openPath) {
              original = editorValue;
            } else {
              try {
                const r = await fetch(
                  `${fileBase}/file?projectId=${projectId}&path=${encodeURIComponent(p.path)}`,
                );
                const d = await r.json();
                if (r.ok) original = d.content;
              } catch {
                /* leave null */
              }
            }
            return { ...p, originalContent: original, status: "pending" as const };
          },
        ),
      );
      setProposals((prev) => [...withOriginals, ...prev]);
    } finally {
      setAsking(false);
    }
  }

  async function applyProposal(p: Proposal) {
    if (!fileBase) return;
    setProposals((prev) => prev.map((x) => (x === p ? { ...x, status: "applying" } : x)));
    try {
      const res = await fetch(`${fileBase}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          path: p.path,
          content: p.proposedContent,
          source: "ai",
          summary: p.summary,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toastError(data.error ?? "Apply failed");
        setProposals((prev) => prev.map((x) => (x === p ? { ...x, status: "pending" } : x)));
        return;
      }
      if (p.path === openPath) {
        setEditorValue(p.proposedContent);
        setSavedValue(p.proposedContent);
      }
      setProposals((prev) => prev.map((x) => (x === p ? { ...x, status: "applied" } : x)));
    } catch {
      setProposals((prev) => prev.map((x) => (x === p ? { ...x, status: "pending" } : x)));
    }
  }

  // ---- activity

  const loadActivity = useCallback(async () => {
    if (!fileBase) return;
    const res = await fetch(`${fileBase}/activity?projectId=${projectId}`);
    const data = await res.json();
    if (res.ok) setActivity(data.entries);
  }, [selectedId, projectId]);

  useEffect(() => {
    if (tab === "activity") void loadActivity();
  }, [tab, loadActivity]);

  // ---- render

  return (
    <div className="flex flex-col gap-4">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href={`/dashboard/projects/${projectId}`} className="text-sm text-muted hover:text-ink">
            ← {domain}
          </Link>
          <h1 className="mt-1 text-xl font-heading tracking-heading stretch-heading text-ink">{pageTitle ?? "Site IDE"}</h1>
          <p className="mt-1 text-sm text-muted">
            {pageSubtitle ?? "Edit client website code with AI assistance. The AI proposes — you approve."}
          </p>
        </div>
        <div className="flex gap-1 border-b border-line">
          <button
            onClick={() => setTab("editor")}
            className={`border-b-2 px-3 py-2 text-[0.84375rem] font-semibold transition-colors ${tab === "editor" ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            Editor
          </button>
          <button
            onClick={() => setTab("activity")}
            className={`border-b-2 px-3 py-2 text-[0.84375rem] font-semibold transition-colors ${tab === "activity" ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            Activity
          </button>
        </div>
      </div>

      {/* banners */}
      <div className="flex flex-col gap-2">
        {siteMode && siteBanner ? (
          <div className={`rounded-md border px-3 py-2 text-sm ${siteBanner.mock ? "border-line bg-canvas text-ink" : "border-line bg-paper text-ink"}`}>
            <strong>{siteBanner.mock ? "Mock site — demo files." : "Live site:"}</strong> {siteBanner.title}
            {siteBanner.detail && <span className="ml-2 opacity-70">{siteBanner.detail}</span>}
          </div>
        ) : selected ? (
          selected.demo ? (
            <div className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">
              <strong>Demo site — mock files.</strong> Nothing here is a real server. Add an SFTP connection below for live editing.
            </div>
          ) : (
            <div className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink">
              <strong>Live SFTP:</strong> {selected.username}@{selected.host}:{selected.port}
              {selected.lastTestedAt && (
                <span className="ml-2 text-muted">
                  · last test {selected.lastTestOk ? "✓" : "✗"} {shortTime(selected.lastTestedAt)}
                </span>
              )}
            </div>
          )
        ) : (
          <div className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
            No connection selected — add an SFTP connection or open the demo site.
          </div>
        )}
        <div
          className={`rounded-md border px-3 py-2 text-sm ${llm.isLive ? "border-line bg-paper text-ink" : "border-line bg-canvas text-ink"}`}
        >
          {llm.isLive ? (
            <>ShapesOS: <strong>live</strong> ({llm.model})</>
          ) : (
            <><strong>ShapesOS: mock mode</strong> — set <code>LLM_API_KEY</code> for real AI proposals. Demo proposals are labeled.</>
          )}
        </div>
      </div>

      {/* connection manager (hidden in site mode — the site is already connected) */}
      {!siteMode && (
      <div className="rounded-lg bg-paper shadow-hairline p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Site connections</h2>
          <div className="flex gap-2">
            <button
              onClick={() => void createConnection(true)}
              disabled={formBusy}
              className="rounded-full bg-paper px-3 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40"
            >
              Open demo site
            </button>
            <button
              onClick={() => setShowForm((s) => !s)}
              className="rounded-full bg-paper px-3 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40"
            >
              {showForm ? "Cancel" : (<span className="inline-flex items-center gap-1.5"><Plus size={14} /> Add SFTP connection</span>)}
            </button>
          </div>
        </div>

        {showForm && (
          <div className="mt-3 grid grid-cols-2 gap-3 rounded-md border border-line p-3">
            <label className="text-sm text-muted">
              Label
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Client production" className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 text-sm text-ink" />
            </label>
            <label className="text-sm text-muted">
              Host
              <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="example.com" className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 font-mono text-sm text-ink" />
            </label>
            <label className="text-sm text-muted">
              Port
              <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 font-mono text-sm text-ink" />
            </label>
            <label className="text-sm text-muted">
              Username
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="deploy" className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 font-mono text-sm text-ink" />
            </label>
            <label className="text-sm text-muted">
              Auth type
              <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value })} className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 text-sm text-ink">
                <option value="password">Password</option>
                <option value="key">Private key</option>
              </select>
            </label>
            <label className="text-sm text-muted">
              {form.authType === "key" ? "Private key" : "Password"}
              {form.authType === "key" ? (
                <textarea value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} rows={3} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 font-mono text-xs text-ink" />
              ) : (
                <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 font-mono text-sm text-ink" />
              )}
            </label>
            <div className="col-span-2">
              {formError && <p className="mb-2 text-sm text-failed-text">{formError}</p>}
              <button onClick={() => void createConnection(false)} disabled={formBusy} className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-white hover:bg-ink-hover disabled:opacity-50 aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                {formBusy ? "Saving…" : "Save connection"}
              </button>
              <p className="mt-2 text-xs text-muted">
                Credentials are AES-256-GCM encrypted at rest and never shown again — only a non-sensitive hint ({`••••····`}) is displayed.
              </p>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {connections.map((c) => (
            <div
              key={c.id}
              className={`flex items-center justify-between rounded-md border px-3 py-2 ${selectedId === c.id ? "border-ink bg-paper" : "border-line"}`}
            >
              <button onClick={() => { setSelectedId(c.id); setOpenPath(null); }} className="flex-1 text-left">
                <span className="text-sm font-medium text-ink">
                  {c.demo && <FlaskConical size={13} className="mr-1 inline-block text-muted" />}{c.label}
                </span>
                <span className="ml-2 font-mono text-xs text-muted">
                  {c.demo ? "demo (mock)" : `${c.username}@${c.host}:${c.port} · ${c.authType} ${c.secretHint ?? ""}`}
                </span>
              </button>
              <div className="flex items-center gap-2">
                {testMsg[c.id] && <span className="max-w-xs truncate text-xs text-muted">{testMsg[c.id]}</span>}
                <button onClick={() => void testConnection(c)} className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink shadow-control hover:shadow-outline">
                  Test
                </button>
                <button onClick={() => void deleteConnection(c)} className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint">
                  Remove
                </button>
              </div>
            </div>
          ))}
          {connections.length === 0 && (
            <p className="text-sm text-muted">No connections yet.</p>
          )}
        </div>
      </div>
      )}

      {tab === "activity" ? (
        <div className="rounded-lg bg-paper shadow-hairline p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">Change audit log</h2>
          {activity === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-muted">No changes yet. Saves and AI proposals will appear here.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {activity.map((e) => (
                <div key={e.id} className="flex items-start justify-between rounded-md border border-line px-3 py-2">
                  <div>
                    <span
                      className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                        e.action === "ai_applied"
                          ? "bg-ink text-white"
                          : "bg-canvas text-ink"
                      }`}
                    >
                      {e.action === "ai_proposal" ? "AI proposed" : e.action === "ai_applied" ? "AI applied ✓" : "Manual save"}
                    </span>
                    <span className="font-mono text-sm text-ink">{e.filePath}</span>
                    <p className="mt-0.5 text-xs text-muted">{e.summary}</p>                    <p className="mt-0.5 text-xs text-muted">{e.summary}</p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted">
                    <div>{shortTime(e.createdAt)}</div>
                    <div className="mt-0.5">{e.actor === "ai" ? "AI" : "you"}{e.approvedBy ? " · approved by you" : ""}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* file tree */}
          <div className="col-span-3 rounded-lg bg-paper shadow-hairline p-2">
            <h2 className="px-2 py-1 text-sm font-semibold text-ink">Files</h2>
            {!fileBase ? (
              <p className="px-2 py-2 text-xs text-muted">Select a connection above.</p>
            ) : (
              <TreeNodeConnected
                key={fileBase}
                entry={{ name: "/", path: "/", type: "dir" }}
                depth={0}
                apiBase={fileBase}
                projectId={projectId}
                onOpen={(e) => void openFile(e)}
                onAttach={(e) => void attachFile(e)}
                openPath={openPath}
              />
            )}
            <p className="px-2 py-2 text-[0.6875rem] text-muted">Hover a file and press + to attach it to the AI chat.</p>
          </div>

          {/* editor */}
          <div className="col-span-6 flex flex-col rounded-lg bg-paper shadow-hairline">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <div className="min-w-0">
                {openPath ? (
                  <>
                    <span className="font-mono text-sm text-ink">{openPath}</span>
                    {dirty && <span className="ml-2 text-xs text-ink">● unsaved</span>}
                    {truncated && <span className="ml-2 text-xs text-ink">(truncated at 200 KB)</span>}
                  </>
                ) : (
                  <span className="text-sm text-muted">No file open — pick one from the tree.</span>
                )}
              </div>
              <button
                onClick={() => void saveFile("manual")}
                disabled={!openPath || !dirty || saving}
                className="rounded-full bg-ink px-3 py-1 text-sm font-semibold text-white hover:bg-ink-hover disabled:opacity-40 aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
            <div className="h-[560px]">
              {fileLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-muted">Loading…</div>
              ) : fileError ? (
                <div className="flex h-full items-center justify-center text-sm text-failed-text">{fileError}</div>
              ) : openPath ? (
                <MonacoEditor
                  height="560px"
                  theme="vs-dark"
                  language={languageFor(openPath)}
                  value={editorValue}
                  onChange={(v) => setEditorValue(v ?? "")}
                  options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: "on" }}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted">
                  {selected ? "Select a file to start editing." : "Connect a site first."}
                </div>
              )}
            </div>
          </div>

          {/* AI assistant */}
          <div className="col-span-3 flex max-h-[640px] flex-col rounded-lg bg-paper shadow-hairline">
            <div className="border-b border-line px-3 py-2">
              <h2 className="text-sm font-semibold text-ink">AI assistant</h2>
              <p className="text-[0.6875rem] text-muted">Proposes diffs. Nothing is written until you click Apply.</p>
            </div>

            {attached.length > 0 && (
              <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2">
                {attached.map((a) => (
                  <span key={a.path} className="flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 font-mono text-[0.6875rem] text-muted">
                    {a.path}
                    <button onClick={() => setAttached((prev) => prev.filter((x) => x.path !== a.path))} className="text-muted hover:text-ink">✕</button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
              {chat.length === 0 && (
                <p className="text-xs text-muted">
                  Ask for a change, e.g. “Add a meta description to the head” or “Make the header sticky”. The open file
                  {attached.length > 0 ? " and attached files are" : " is"} sent as context.
                </p>
              )}
              {chat.map((m, i) => (
                <div key={i} className={`rounded-md px-2.5 py-2 text-sm ${m.role === "user" ? "bg-ink text-white" : "bg-canvas text-ink"}`}>
                  <div className="mb-0.5 text-[0.6875rem] font-semibold opacity-70">{m.role === "user" ? "You" : "Assistant"}</div>
                  <div className="whitespace-pre-wrap text-[0.8125rem]">{m.text}</div>
                </div>
              ))}
              {asking && <p className="text-xs text-muted">Thinking…</p>}
              <div ref={chatEndRef} />
            </div>

            {proposals.length > 0 && (
              <div className="max-h-72 space-y-2 overflow-y-auto border-t border-line px-3 py-2">
                <h3 className="text-xs font-semibold text-muted">Proposals — review required</h3>
                {proposals.map((pr, i) => (
                  <div key={`${pr.path}-${i}`} className="rounded-md border border-line bg-canvas p-2">
                    <div className="font-mono text-xs text-ink">{pr.path}</div>
                    <p className="mt-0.5 text-xs text-muted">{pr.summary}</p>
                    {pr.originalContent !== null ? (
                      <div className="mt-1.5"><DiffView original={pr.originalContent} proposed={pr.proposedContent} /></div>
                    ) : (
                      <p className="mt-1 text-xs text-muted">Could not load original for diff — Apply will still write the full proposed content.</p>
                    )}
                    <div className="mt-1.5 flex gap-2">
                      {pr.status === "applied" ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink"><span className="aos-shape aos-shape--done" aria-hidden />Applied & logged</span>
                      ) : pr.status === "rejected" ? (
                        <span className="text-xs text-muted">Rejected</span>
                      ) : (
                        <>
                          <button
                            onClick={() => void applyProposal(pr)}
                            disabled={pr.status === "applying"}
                            className="rounded-full bg-done px-2.5 py-1 text-xs font-semibold text-white aos-press disabled:opacity-50"
                          >
                            {pr.status === "applying" ? "Applying…" : "Apply"}
                          </button>
                          <button
                            onClick={() => setProposals((prev) => prev.map((x) => (x === pr ? { ...x, status: "rejected" as const } : x)))}
                            className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint"
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t border-line p-2">
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void sendMessage(); }}
                  placeholder="Ask for a code change…"
                  className="min-w-0 flex-1 rounded-md border-[1.5px] border-control bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-subtle"
                />
                <button
                  onClick={() => void sendMessage()}
                  disabled={asking || !input.trim()}
                  className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-white hover:bg-ink-hover disabled:opacity-40 aos-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
