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

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500">
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
  connId,
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
  connId: string;
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
        className={`group flex items-center gap-1 rounded px-2 py-1 text-sm ${
          openPath === entry.path
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
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
            <span className="w-3 text-zinc-600">{expanded ? "▾" : "▸"}</span>
            <span>📁</span>
            <span className="truncate">{entry.name}</span>
          </button>
        ) : (
          <>
            <button
              onClick={() => onOpen(entry)}
              className="flex min-w-0 flex-1 items-center gap-1 text-left"
            >
              <span className="w-3" />
              <span>📄</span>
              <span className="truncate font-mono text-[13px]">{entry.name}</span>
            </button>
            <button
              onClick={() => onAttach(entry)}
              title="Attach to AI chat"
              className="hidden rounded px-1 text-xs text-zinc-600 hover:text-zinc-200 group-hover:block"
            >
              ＋
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
              connId={connId}
              projectId={projectId}
              onOpen={onOpen}
              onAttach={onAttach}
              openPath={openPath}
            />
          ))}
          {children && children.length === 0 && (
            <div
              className="py-1 text-xs text-zinc-600"
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
  connId: string;
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
        `/api/sites/${props.connId}/files?projectId=${props.projectId}&path=${encodeURIComponent(dir)}`,
      );
      const data = await res.json();
      if (res.ok) setChildren(data.entries);
    },
    [props.connId, props.projectId],
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
      connId={props.connId}
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
    <pre className="max-h-64 overflow-auto rounded bg-zinc-950 p-2 font-mono text-xs leading-5">
      {parts.map((part, i) => (
        <span
          key={i}
          className={
            part.added
              ? "block bg-emerald-950/60 text-emerald-200"
              : part.removed
                ? "block bg-red-950/60 text-red-200"
                : "block text-zinc-600"
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
}: {
  projectId: string;
  domain: string;
  initialConnections: Connection[];
  llm: LlmInfo;
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

  const selected = connections.find((c) => c.id === selectedId) ?? null;

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
    if (!confirm(`Remove connection "${conn.label}"?`)) return;
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
      if (!selectedId) return;
      if (dirty && !confirm("Discard unsaved changes?")) return;
      setFileLoading(true);
      setFileError(null);
      setTruncated(false);
      try {
        const res = await fetch(
          `/api/sites/${selectedId}/file?projectId=${projectId}&path=${encodeURIComponent(entry.path)}`,
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
    if (!selectedId || !openPath) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/sites/${selectedId}/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, path: openPath, content: editorValue, source, summary }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Save failed");
        return;
      }
      setSavedValue(editorValue);
      if (tab === "activity") void loadActivity();
    } finally {
      setSaving(false);
    }
  }

  async function attachFile(entry: FileEntry) {
    if (!selectedId) return;
    if (attached.some((a) => a.path === entry.path)) return;
    const res = await fetch(
      `/api/sites/${selectedId}/file?projectId=${projectId}&path=${encodeURIComponent(entry.path)}`,
    );
    const data = await res.json();
    if (res.ok) setAttached((a) => [...a, { path: entry.path, content: data.content }]);
  }

  // ---- AI assistant

  async function sendMessage() {
    const message = input.trim();
    if (!message || !selectedId || asking) return;
    if (!openPath) {
      alert("Open a file first so the assistant has context.");
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
      const res = await fetch(`/api/sites/${selectedId}/assist`, {
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
                  `/api/sites/${selectedId}/file?projectId=${projectId}&path=${encodeURIComponent(p.path)}`,
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
    if (!selectedId) return;
    setProposals((prev) => prev.map((x) => (x === p ? { ...x, status: "applying" } : x)));
    try {
      const res = await fetch(`/api/sites/${selectedId}/file`, {
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
        alert(data.error ?? "Apply failed");
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
    if (!selectedId) return;
    const res = await fetch(`/api/sites/${selectedId}/activity?projectId=${projectId}`);
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
          <Link href={`/dashboard/projects/${projectId}`} className="text-sm text-zinc-500 hover:text-zinc-300">
            ← {domain}
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Site IDE</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Edit client website code with AI assistance. The AI proposes — you approve.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setTab("editor")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "editor" ? "bg-zinc-100 text-zinc-950" : "border border-zinc-700 text-zinc-300"}`}
          >
            Editor
          </button>
          <button
            onClick={() => setTab("activity")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "activity" ? "bg-zinc-100 text-zinc-950" : "border border-zinc-700 text-zinc-300"}`}
          >
            Activity
          </button>
        </div>
      </div>

      {/* banners */}
      <div className="flex flex-col gap-2">
        {selected ? (
          selected.demo ? (
            <div className="rounded-md border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
              <strong>Demo site — mock files.</strong> Nothing here is a real server. Add an SFTP connection below for live editing.
            </div>
          ) : (
            <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
              <strong>Live SFTP:</strong> {selected.username}@{selected.host}:{selected.port}
              {selected.lastTestedAt && (
                <span className="ml-2 text-emerald-300/70">
                  · last test {selected.lastTestOk ? "✓" : "✗"} {shortTime(selected.lastTestedAt)}
                </span>
              )}
            </div>
          )
        ) : (
          <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
            No connection selected — add an SFTP connection or open the demo site.
          </div>
        )}
        <div
          className={`rounded-md border px-3 py-2 text-sm ${llm.isLive ? "border-emerald-800 bg-emerald-950/40 text-emerald-200" : "border-amber-800 bg-amber-950/40 text-amber-200"}`}
        >
          {llm.isLive ? (
            <>AI assistant: <strong>live</strong> ({llm.model})</>
          ) : (
            <><strong>AI assistant: mock mode</strong> — set <code>LLM_API_KEY</code> for real AI proposals. Demo proposals are labeled.</>
          )}
        </div>
      </div>

      {/* connection manager */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-200">Site connections</h2>
          <div className="flex gap-2">
            <button
              onClick={() => void createConnection(true)}
              disabled={formBusy}
              className="rounded-md border border-amber-700 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-950"
            >
              Open demo site
            </button>
            <button
              onClick={() => setShowForm((s) => !s)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500"
            >
              {showForm ? "Cancel" : "＋ Add SFTP connection"}
            </button>
          </div>
        </div>

        {showForm && (
          <div className="mt-3 grid grid-cols-2 gap-3 rounded-md border border-zinc-800 p-3">
            <label className="text-sm text-zinc-400">
              Label
              <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Client production" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="text-sm text-zinc-400">
              Host
              <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="example.com" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100" />
            </label>
            <label className="text-sm text-zinc-400">
              Port
              <input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100" />
            </label>
            <label className="text-sm text-zinc-400">
              Username
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="deploy" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100" />
            </label>
            <label className="text-sm text-zinc-400">
              Auth type
              <select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value })} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100">
                <option value="password">Password</option>
                <option value="key">Private key</option>
              </select>
            </label>
            <label className="text-sm text-zinc-400">
              {form.authType === "key" ? "Private key" : "Password"}
              {form.authType === "key" ? (
                <textarea value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} rows={3} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100" />
              ) : (
                <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100" />
              )}
            </label>
            <div className="col-span-2">
              {formError && <p className="mb-2 text-sm text-red-400">{formError}</p>}
              <button onClick={() => void createConnection(false)} disabled={formBusy} className="rounded-md bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50">
                {formBusy ? "Saving…" : "Save connection"}
              </button>
              <p className="mt-2 text-xs text-zinc-600">
                Credentials are AES-256-GCM encrypted at rest and never shown again — only a non-sensitive hint ({`••••····`}) is displayed.
              </p>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {connections.map((c) => (
            <div
              key={c.id}
              className={`flex items-center justify-between rounded-md border px-3 py-2 ${selectedId === c.id ? "border-zinc-500 bg-zinc-900" : "border-zinc-800"}`}
            >
              <button onClick={() => { setSelectedId(c.id); setOpenPath(null); }} className="flex-1 text-left">
                <span className="text-sm font-medium text-zinc-100">
                  {c.demo ? "🧪 " : ""}{c.label}
                </span>
                <span className="ml-2 font-mono text-xs text-zinc-500">
                  {c.demo ? "demo (mock)" : `${c.username}@${c.host}:${c.port} · ${c.authType} ${c.secretHint ?? ""}`}
                </span>
              </button>
              <div className="flex items-center gap-2">
                {testMsg[c.id] && <span className="max-w-xs truncate text-xs text-zinc-400">{testMsg[c.id]}</span>}
                <button onClick={() => void testConnection(c)} className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500">
                  Test
                </button>
                <button onClick={() => void deleteConnection(c)} className="rounded border border-zinc-700 px-2 py-1 text-xs text-red-300 hover:border-red-700">
                  Remove
                </button>
              </div>
            </div>
          ))}
          {connections.length === 0 && (
            <p className="text-sm text-zinc-500">No connections yet.</p>
          )}
        </div>
      </div>

      {tab === "activity" ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-sm font-semibold text-zinc-200">Change audit log</h2>
          {activity === null ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-zinc-500">No changes yet. Saves and AI proposals will appear here.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {activity.map((e) => (
                <div key={e.id} className="flex items-start justify-between rounded-md border border-zinc-800 px-3 py-2">
                  <div>
                    <span
                      className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                        e.action === "ai_proposal"
                          ? "bg-violet-950 text-violet-200"
                          : e.action === "ai_applied"
                            ? "bg-emerald-950 text-emerald-200"
                            : "bg-zinc-800 text-zinc-300"
                      }`}
                    >
                      {e.action === "ai_proposal" ? "AI proposed" : e.action === "ai_applied" ? "AI applied ✓" : "Manual save"}
                    </span>
                    <span className="font-mono text-sm text-zinc-200">{e.filePath}</span>
                    <p className="mt-0.5 text-xs text-zinc-500">{e.summary}</p>                    <p className="mt-0.5 text-xs text-zinc-500">{e.summary}</p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-zinc-600">
                    <div>{shortTime(e.createdAt)}</div>
                    <div className="mt-0.5">{e.actor === "ai" ? "🤖 AI" : "👤 you"}{e.approvedBy ? " · approved by you" : ""}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* file tree */}
          <div className="col-span-3 rounded-lg border border-zinc-800 bg-zinc-950 p-2">
            <h2 className="px-2 py-1 text-sm font-semibold text-zinc-200">Files</h2>
            {!selected ? (
              <p className="px-2 py-2 text-xs text-zinc-600">Select a connection above.</p>
            ) : (
              <TreeNodeConnected
                key={selected.id}
                entry={{ name: "/", path: "/", type: "dir" }}
                depth={0}
                connId={selected.id}
                projectId={projectId}
                onOpen={(e) => void openFile(e)}
                onAttach={(e) => void attachFile(e)}
                openPath={openPath}
              />
            )}
            <p className="px-2 py-2 text-[11px] text-zinc-600">Hover a file and press ＋ to attach it to the AI chat.</p>
          </div>

          {/* editor */}
          <div className="col-span-6 flex flex-col rounded-lg border border-zinc-800 bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
              <div className="min-w-0">
                {openPath ? (
                  <>
                    <span className="font-mono text-sm text-zinc-100">{openPath}</span>
                    {dirty && <span className="ml-2 text-xs text-amber-300">● unsaved</span>}
                    {truncated && <span className="ml-2 text-xs text-amber-300">(truncated at 200 KB)</span>}
                  </>
                ) : (
                  <span className="text-sm text-zinc-600">No file open — pick one from the tree.</span>
                )}
              </div>
              <button
                onClick={() => void saveFile("manual")}
                disabled={!openPath || !dirty || saving}
                className="rounded-md bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
            <div className="h-[560px]">
              {fileLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading…</div>
              ) : fileError ? (
                <div className="flex h-full items-center justify-center text-sm text-red-400">{fileError}</div>
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
                <div className="flex h-full items-center justify-center text-sm text-zinc-600">
                  {selected ? "Select a file to start editing." : "Connect a site first."}
                </div>
              )}
            </div>
          </div>

          {/* AI assistant */}
          <div className="col-span-3 flex max-h-[640px] flex-col rounded-lg border border-zinc-800 bg-zinc-950">
            <div className="border-b border-zinc-800 px-3 py-2">
              <h2 className="text-sm font-semibold text-zinc-200">🤖 AI assistant</h2>
              <p className="text-[11px] text-zinc-500">Proposes diffs. Nothing is written until you click Apply.</p>
            </div>

            {attached.length > 0 && (
              <div className="flex flex-wrap gap-1 border-b border-zinc-800 px-3 py-2">
                {attached.map((a) => (
                  <span key={a.path} className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                    {a.path}
                    <button onClick={() => setAttached((prev) => prev.filter((x) => x.path !== a.path))} className="text-zinc-500 hover:text-zinc-200">✕</button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
              {chat.length === 0 && (
                <p className="text-xs text-zinc-600">
                  Ask for a change, e.g. “Add a meta description to the head” or “Make the header sticky”. The open file
                  {attached.length > 0 ? " and attached files are" : " is"} sent as context.
                </p>
              )}
              {chat.map((m, i) => (
                <div key={i} className={`rounded-md px-2.5 py-2 text-sm ${m.role === "user" ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 text-zinc-300"}`}>
                  <div className="mb-0.5 text-[11px] font-medium text-zinc-500">{m.role === "user" ? "You" : "Assistant"}</div>
                  <div className="whitespace-pre-wrap text-[13px]">{m.text}</div>
                </div>
              ))}
              {asking && <p className="text-xs text-zinc-500">Thinking…</p>}
              <div ref={chatEndRef} />
            </div>

            {proposals.length > 0 && (
              <div className="max-h-72 space-y-2 overflow-y-auto border-t border-zinc-800 px-3 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Proposals — review required</h3>
                {proposals.map((pr, i) => (
                  <div key={`${pr.path}-${i}`} className="rounded-md border border-violet-900 bg-violet-950/20 p-2">
                    <div className="font-mono text-xs text-violet-200">{pr.path}</div>
                    <p className="mt-0.5 text-xs text-zinc-400">{pr.summary}</p>
                    {pr.originalContent !== null ? (
                      <div className="mt-1.5"><DiffView original={pr.originalContent} proposed={pr.proposedContent} /></div>
                    ) : (
                      <p className="mt-1 text-xs text-zinc-500">Could not load original for diff — Apply will still write the full proposed content.</p>
                    )}
                    <div className="mt-1.5 flex gap-2">
                      {pr.status === "applied" ? (
                        <span className="text-xs font-medium text-emerald-300">✓ Applied & logged</span>
                      ) : pr.status === "rejected" ? (
                        <span className="text-xs text-zinc-500">Rejected</span>
                      ) : (
                        <>
                          <button
                            onClick={() => void applyProposal(pr)}
                            disabled={pr.status === "applying"}
                            className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            {pr.status === "applying" ? "Applying…" : "Apply"}
                          </button>
                          <button
                            onClick={() => setProposals((prev) => prev.map((x) => (x === pr ? { ...x, status: "rejected" as const } : x)))}
                            className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500"
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

            <div className="border-t border-zinc-800 p-2">
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void sendMessage(); }}
                  placeholder="Ask for a code change…"
                  className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
                />
                <button
                  onClick={() => void sendMessage()}
                  disabled={asking || !input.trim()}
                  className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
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
