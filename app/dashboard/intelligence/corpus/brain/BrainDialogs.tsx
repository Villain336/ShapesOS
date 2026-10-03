// Marketr — Knowledge Brain: corpus management dialogs (Agentic OS).
// AddSourceDialog → POST /api/corpus/propose · RebuildDialog → /api/corpus/rebuild.

import { useCallback, useEffect, useState } from "react";
import {
  X,
  Plus,
  RefreshCw,
  Loader2,
  Link2,
  Upload,
  Type,
  Database,
  Info,
} from "lucide-react";
import type { BrainPillar } from "@/lib/intelligence/corpus/graph";
import { inputCls, btnPrimary, btnGhost } from "./brain-ui";
import { closeOnEscape } from "@/lib/ui/keyboard";

function DialogShell({
  title,
  onClose,
  children,
  footer,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
      <div
        className="w-full max-w-lg rounded-lg bg-paper shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 className="aos-subheading">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-full p-1.5 text-muted hover:bg-hover-paper"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-line p-4">{footer}</div>
      </div>
    </div>
  );
}

export function AddSourceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<"url" | "upload" | "text">("url");
  const [title, setTitle] = useState("");
  const [pillar, setPillar] = useState<BrainPillar>("marketing");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [teaches, setTeaches] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileB64, setFileB64] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (![".md", ".txt", ".pdf"].includes(ext)) {
      setErr("Only .md, .txt, .pdf files are accepted.");
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setErr("File must be ≤ 2MB.");
      return;
    }
    const buf = await f.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    setFileB64(btoa(bin));
    setFileName(f.name);
    setErr(null);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/corpus/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, pillar, kind, url, text, teaches, fileName, fileBase64: fileB64 }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "proposal failed");
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "proposal failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell
      title="Propose a source"
      onClose={onClose}
      footer={
        <>
          <button className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button className={btnPrimary} disabled={busy || !title.trim()} onClick={submit}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Propose source
          </button>
        </>
      }
    >
      <div className="flex gap-1 rounded-full bg-canvas p-1" role="group" aria-label="Source kind">
        {([["url", "URL", Link2], ["upload", "Upload", Upload], ["text", "Paste text", Type]] as const).map(
          ([k, label, Icon]) => (
            <button
              key={k}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-sm font-semibold ${
                kind === k ? "bg-ink text-white" : "text-muted hover:text-ink"
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ),
        )}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Source title"
        className={`${inputCls} h-control w-full`}
      />
      <div className="grid grid-cols-2 gap-2">
        <select value={pillar} onChange={(e) => setPillar(e.target.value as BrainPillar)} className={`${inputCls} h-control-sm`}>
          <option value="marketing">Marketing</option>
          <option value="growth">Growth</option>
          <option value="design">Design</option>
        </select>
        <input
          value={teaches}
          onChange={(e) => setTeaches(e.target.value)}
          placeholder="What should it teach? (optional)"
          className={`${inputCls} h-control-sm`}
        />
      </div>
      {kind === "url" && (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          className={`${inputCls} h-control-sm w-full`}
        />
      )}
      {kind === "upload" && (
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-control bg-canvas p-6 text-center">
          <Upload className="h-5 w-5 text-subtle" />
          <span className="text-sm text-muted">
            {fileName || "Drop a .md, .txt, or .pdf file (≤ 2MB)"}
          </span>
          <input
            type="file"
            accept=".md,.txt,.pdf"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </label>
      )}
      {kind === "text" && (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the text ShapesOS should learn from (min 200 characters)…"
          rows={6}
          className={`${inputCls} w-full resize-y py-2.5`}
        />
      )}
      <div className="flex items-start gap-2 rounded-md border border-line bg-canvas p-2.5 text-[11px] leading-snug text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
        Proposed sources appear as dotted nodes immediately, but nothing is ingested until you run a
        corpus rebuild — and pasted text must be yours to give (no scraped or pirated material).
      </div>
      {err && (
        <p className="flex items-start gap-1.5 text-sm text-failed-text" role="alert">
          <span className="aos-shape aos-shape--failed mt-1 shrink-0" style={{ "--aos-shape-size": "10px" } as React.CSSProperties} />
          {err}
        </p>
      )}
    </DialogShell>
  );
}

export function RebuildDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<{
    state: string;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  } | null>(null);
  const [logTail, setLogTail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/corpus/rebuild");
      const j = await res.json();
      setStatus(j.status);
      setLogTail(j.logTail ?? "");
      return j.status.state;
    } catch {
      return "unknown";
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(async () => {
      const s = await poll();
      if (s === "succeeded" || s === "failed") {
        clearInterval(t);
        if (s === "succeeded") onDone();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [poll, onDone]);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/corpus/rebuild", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "rebuild failed to start");
      setStatus(j.status);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "rebuild failed to start");
    } finally {
      setBusy(false);
    }
  };

  const stateShape =
    status?.state === "running" ? (
      <span className="aos-shape aos-shape--running aos-is-live" style={{ "--aos-shape-size": "12px" } as React.CSSProperties} />
    ) : status?.state === "succeeded" ? (
      <span className="aos-shape aos-shape--done" style={{ "--aos-shape-size": "12px" } as React.CSSProperties} />
    ) : status?.state === "failed" ? (
      <span className="aos-shape aos-shape--failed" style={{ "--aos-shape-size": "12px" } as React.CSSProperties} />
    ) : null;

  return (
    <DialogShell
      title={
        <span className="flex items-center gap-2">
          <Database className="h-4 w-4" /> Rebuild corpus
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <button className={btnGhost} onClick={onClose}>
            Close
          </button>
          <button className={btnPrimary} disabled={busy || status?.state === "running"} onClick={start}>
            {busy || status?.state === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {status?.state === "running" ? "Rebuilding…" : "Start rebuild"}
          </button>
        </>
      }
    >
      <p className="text-sm leading-snug text-muted">
        Runs the full ingest pipeline (fetch → chunk → embed → manifest). This rewrites the corpus and
        bumps its version. Removal flags take effect here.
      </p>
      {status && (
        <div className="flex items-center gap-2 text-sm">
          {stateShape}
          {status.state === "running" && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
          <span className="font-medium text-ink">Status: {status.state}</span>
          {status.startedAt && (
            <span className="text-subtle">started {new Date(status.startedAt).toLocaleTimeString()}</span>
          )}
        </div>
      )}
      {logTail && (
        <pre className="max-h-56 overflow-y-auto rounded-md bg-night p-3 font-mono text-sm leading-relaxed text-night-text">
          {logTail}
        </pre>
      )}
      {status?.error && (
        <p className="flex items-start gap-1.5 text-sm text-failed-text" role="alert">
          <span className="aos-shape aos-shape--failed mt-1 shrink-0" style={{ "--aos-shape-size": "10px" } as React.CSSProperties} />
          {status.error}
        </p>
      )}
      {err && (
        <p className="flex items-start gap-1.5 text-sm text-failed-text" role="alert">
          <span className="aos-shape aos-shape--failed mt-1 shrink-0" style={{ "--aos-shape-size": "10px" } as React.CSSProperties} />
          {err}
        </p>
      )}
    </DialogShell>
  );
}
