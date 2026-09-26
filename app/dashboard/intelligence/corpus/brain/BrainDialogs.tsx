// Marketr — Knowledge Brain: corpus management dialogs.
// Moved verbatim out of BrainClient.tsx (3D rebuild refactor).
// AddSourceDialog → POST /api/corpus/propose · RebuildDialog → /api/corpus/rebuild.

import { useCallback, useEffect, useState } from "react";
import {
  X,
  Plus,
  RefreshCw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Link2,
  Upload,
  Type,
  Database,
  Info,
} from "lucide-react";
import type { BrainPillar } from "@/lib/intelligence/corpus/graph";
import { inputCls, btnPrimary, btnGhost } from "./brain-ui";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-stone-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-100 p-4">
          <h2 className="text-[15px] font-semibold text-stone-900">Propose a source</h2>
          <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="flex gap-1 rounded-md bg-stone-100 p-1">
            {([["url", "URL", Link2], ["upload", "Upload", Upload], ["text", "Paste text", Type]] as const).map(
              ([k, label, Icon]) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-[13px] font-medium ${
                    kind === k ? "bg-white text-violet-700 shadow-sm" : "text-stone-500 hover:text-stone-700"
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
            className={`${inputCls} w-full`}
          />
          <div className="grid grid-cols-2 gap-2">
            <select value={pillar} onChange={(e) => setPillar(e.target.value as BrainPillar)} className={inputCls}>
              <option value="marketing">Marketing</option>
              <option value="growth">Growth</option>
              <option value="design">Design</option>
            </select>
            <input
              value={teaches}
              onChange={(e) => setTeaches(e.target.value)}
              placeholder="What should it teach? (optional)"
              className={inputCls}
            />
          </div>
          {kind === "url" && (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className={`${inputCls} w-full`}
            />
          )}
          {kind === "upload" && (
            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-stone-300 bg-stone-50 p-6 text-center">
              <Upload className="h-5 w-5 text-stone-400" />
              <span className="text-[13px] text-stone-600">
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
              placeholder="Paste the text Marketr should learn from (min 200 characters)…"
              rows={6}
              className={`${inputCls} w-full resize-y`}
            />
          )}
          <div className="flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 p-2.5 text-[11px] leading-snug text-stone-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-400" />
            Proposed sources appear as dotted nodes immediately, but nothing is ingested until you run a
            corpus rebuild — and pasted text must be yours to give (no scraped or pirated material).
          </div>
          {err && <p className="text-[13px] text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-stone-100 p-4">
          <button className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button className={btnPrimary} disabled={busy || !title.trim()} onClick={submit}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Propose source
          </button>
        </div>
      </div>
    </div>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-stone-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-100 p-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-stone-900">
            <Database className="h-4 w-4 text-violet-600" /> Rebuild corpus
          </h2>
          <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-[13px] leading-snug text-stone-600">
            Runs the full ingest pipeline (fetch → chunk → embed → manifest). This rewrites the corpus and
            bumps its version. Removal flags take effect here.
          </p>
          {status && (
            <div className="flex items-center gap-2 text-[13px]">
              {status.state === "running" && <Loader2 className="h-4 w-4 animate-spin text-violet-600" />}
              {status.state === "succeeded" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
              {status.state === "failed" && <AlertTriangle className="h-4 w-4 text-red-600" />}
              <span className="font-medium text-stone-800">Status: {status.state}</span>
              {status.startedAt && (
                <span className="text-stone-400">started {new Date(status.startedAt).toLocaleTimeString()}</span>
              )}
            </div>
          )}
          {logTail && (
            <pre className="max-h-56 overflow-y-auto rounded-md border border-stone-200 bg-stone-950 p-3 font-mono text-[11px] leading-relaxed text-stone-200">
              {logTail}
            </pre>
          )}
          {status?.error && <p className="text-[13px] text-red-600">{status.error}</p>}
          {err && <p className="text-[13px] text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-stone-100 p-4">
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
        </div>
      </div>
    </div>
  );
}
