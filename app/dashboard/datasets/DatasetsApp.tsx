// Marketr — Dataset Builder slice 1: datasets dashboard app (client).
// Source register + add-source flow (upload / Drive / URL / paste).
// Agentic OS: tokens only, Lucide icons only, sentence case, black pill
// primary actions, pills for pressables, cards white radius-lg.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  Database,
  FileUp,
  Globe,
  HardDrive,
  ListChecks,
  Loader2,
  Plus,
  ShieldCheck,
  Tags,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { BuildView } from "./BuildView";

type DatasetsTab = "sources" | "types" | "reviews" | "build";

type SourceKind = "upload" | "drive" | "web" | "paste";

interface RegisterDocument {
  id: string;
  name: string;
  mimeType: string | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  chunkCount: number;
  charCount: number;
  createdAt: string;
}

interface RegisterSource {
  id: string;
  kind: SourceKind;
  name: string;
  externalRef: string | null;
  createdAt: string;
  documentCount: number;
  chunkCount: number;
  charCount: number;
  documents: RegisterDocument[];
}

const KIND_META: Record<SourceKind, { label: string; icon: LucideIcon }> = {
  upload: { label: "Upload file", icon: FileUp },
  drive: { label: "Google Drive", icon: HardDrive },
  web: { label: "Website URL", icon: Globe },
  paste: { label: "Paste text", icon: ClipboardPaste },
};

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function DatasetsApp() {
  const [tab, setTab] = useState<DatasetsTab>("sources");
  const [sources, setSources] = useState<RegisterSource[]>([]);
  const [totals, setTotals] = useState({ sources: 0, documents: 0, chunks: 0, chars: 0 });
  const [integrityOk, setIntegrityOk] = useState<boolean | null>(null);
  const [pendingReviews, setPendingReviews] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    const [regRes, intRes, revRes] = await Promise.all([
      fetch("/api/datasets/sources"),
      fetch("/api/datasets/integrity"),
      fetch("/api/datasets/reviews"),
    ]);
    if (regRes.ok) {
      const json = await regRes.json();
      setSources(json.sources);
      setTotals(json.totals);
    }
    if (intRes.ok) {
      const json = await intRes.json();
      setIntegrityOk(json.ok === true);
    }
    if (revRes.ok) {
      const json = await revRes.json();
      setPendingReviews(json.pending?.length ?? 0);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-4">
      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-full bg-paper px-4 py-2 shadow-hairline">
          {integrityOk === null ? (
            <Loader2 size={14} className="animate-spin text-muted" />
          ) : integrityOk ? (
            <ShieldCheck size={14} className="text-muted" />
          ) : (
            <TriangleAlert size={14} className="text-failed-text" />
          )}
          <span className="text-[13px] font-semibold">
            {integrityOk === null
              ? "Checking integrity"
              : integrityOk
                ? "No orphaned chunks"
                : "Integrity issue found"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span>
            {formatCount(totals.sources)} sources · {formatCount(totals.documents)}{" "}
            documents · {formatCount(totals.chunks)} chunks
          </span>
        </div>
        {tab === "sources" && (
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setShowAdd((v) => !v)}
              className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-6 text-[15px] font-semibold text-white"
            >
              <Plus size={16} />
              Add source
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2" role="tablist" aria-label="Dataset views">
        {(
          [
            { id: "sources", label: "Sources", icon: Globe, badge: null },
            { id: "types", label: "By type", icon: Tags, badge: null },
            { id: "build", label: "Build", icon: Database, badge: null },
            {
              id: "reviews",
              label: "Review queue",
              icon: ListChecks,
              badge: pendingReviews > 0 ? pendingReviews : null,
            },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`aos-press flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold ${
                active ? "bg-black text-white" : "bg-paper text-muted shadow-hairline"
              }`}
            >
              <Icon size={15} />
              {t.label}
              {t.badge !== null && (
                <span
                  className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[11px] ${
                    active ? "bg-white text-black" : "bg-black text-white"
                  }`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "sources" && (
        <>
          {showAdd && (
            <AddSourcePanel
              onAdded={() => {
                setShowAdd(false);
                void refresh();
              }}
              onCancel={() => setShowAdd(false)}
            />
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading sources
            </div>
          ) : sources.length === 0 ? (
            <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
              <p className="text-[15px] font-semibold">No sources yet</p>
              <p className="mt-1 text-sm text-muted">
                Add your first source — a file, a Drive document, a website, or
                pasted text — and it becomes chunked, traceable knowledge.
              </p>
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="aos-press mt-4 h-11 rounded-full bg-black px-6 text-[15px] font-semibold text-white"
              >
                Add source
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {sources.map((source) => {
            const meta = KIND_META[source.kind];
            const Icon = meta.icon;
            const isOpen = expanded[source.id] ?? false;
            return (
              <div key={source.id} className="rounded-lg bg-paper shadow-hairline">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((e) => ({ ...e, [source.id]: !isOpen }))
                  }
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left"
                  aria-expanded={isOpen}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas">
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold">
                      {source.name}
                    </span>
                    <span className="block text-[13px] text-muted">
                      {meta.label} · {source.documentCount} document
                      {source.documentCount === 1 ? "" : "s"} ·{" "}
                      {formatCount(source.chunkCount)} chunks
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className={`shrink-0 text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen && (
                  <div className="border-t border-line px-4 py-3">
                    {source.documents.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-3 rounded-md px-2 py-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {doc.name}
                          </span>
                          <span className="block font-mono text-[12px] text-subtle">
                            {doc.mimeType ?? "unknown type"} ·{" "}
                            {formatCount(doc.charCount)} chars
                          </span>
                          {doc.status === "failed" && doc.error && (
                            <span className="mt-1 block text-[13px] text-failed-text">
                              {doc.error}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
                          {doc.status === "ready" ? (
                            <CheckCircle2 size={13} />
                          ) : doc.status === "failed" ? (
                            <TriangleAlert size={13} className="text-failed-text" />
                          ) : (
                            <Loader2 size={13} className="animate-spin" />
                          )}
                          {doc.status === "ready"
                            ? `${formatCount(doc.chunkCount)} chunks`
                            : doc.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
            </div>
          )}
        </>
      )}

      {tab === "types" && <ByTypeView onClassified={() => void refresh()} />}

      {tab === "build" && <BuildView />}

      {tab === "reviews" && (
        <ReviewQueueView onDecided={() => void refresh()} />
      )}
    </div>
  );
}

interface TypeEntry {
  type: string;
  label: string;
  count: number;
}

function ByTypeView({ onClassified }: { onClassified: () => void }) {
  const [types, setTypes] = useState<TypeEntry[]>([]);
  const [unclassified, setUnclassified] = useState(0);
  const [pendingReview, setPendingReview] = useState(0);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/datasets/by-type");
    if (res.ok) {
      const json = await res.json();
      setTypes(json.types ?? []);
      setUnclassified(json.unclassified ?? 0);
      setPendingReview(json.pendingReview ?? 0);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runClassification() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/datasets/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Classification run failed");
      await load();
      onClassified();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Classification run failed");
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading dataset types
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-muted">
          Chunks auto-classified into dataset types. Low-confidence chunks go
          to the review queue instead of being force-fit.
        </p>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void runClassification()}
            disabled={running}
            className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-6 text-[15px] font-semibold text-white disabled:opacity-60"
          >
            {running ? <Loader2 size={16} className="animate-spin" /> : <Tags size={16} />}
            {running ? "Classifying" : "Run classification"}
          </button>
        </div>
      </div>
      {error && <p className="text-[13px] text-failed-text">{error}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {types.map((t) => (
          <div key={t.type} className="rounded-lg bg-paper p-4 shadow-hairline">
            <p className="text-[15px] font-semibold">{t.label}</p>
            <p className="mt-1 font-mono text-[24px] font-semibold">
              {formatCount(t.count)}
            </p>
            <p className="text-[13px] text-muted">
              {t.count === 1 ? "chunk" : "chunks"} classified
            </p>
          </div>
        ))}
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <p className="text-[15px] font-semibold">Unclassified</p>
          <p className="mt-1 font-mono text-[24px] font-semibold">
            {formatCount(unclassified)}
          </p>
          <p className="text-[13px] text-muted">chunks awaiting classification</p>
        </div>
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <p className="text-[15px] font-semibold">In review</p>
          <p className="mt-1 font-mono text-[24px] font-semibold">
            {formatCount(pendingReview)}
          </p>
          <p className="text-[13px] text-muted">chunks awaiting your decision</p>
        </div>
      </div>
    </div>
  );
}

interface ReviewEntry {
  reviewId: string;
  classificationId: string;
  suggestedType: string;
  suggestedTypeLabel: string;
  confidence: number;
  engine: string;
  chunkText: string;
  documentName: string;
  sourceName: string;
  createdAt: string;
}

const REASSIGN_TYPES = [
  { value: "faq", label: "FAQs" },
  { value: "product_catalog", label: "Products / catalog" },
  { value: "policy", label: "Policies" },
  { value: "process_sop", label: "Processes / SOPs" },
  { value: "company_fact", label: "Company facts" },
  { value: "pricing", label: "Pricing" },
];

function ReviewQueueView({ onDecided }: { onDecided: () => void }) {
  const [items, setItems] = useState<ReviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [reassignFor, setReassignFor] = useState<string | null>(null);
  const [reassignType, setReassignType] = useState("faq");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/datasets/reviews");
    if (res.ok) {
      const json = await res.json();
      setItems(json.pending ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(
    reviewId: string,
    action: "approve" | "reassign" | "reject",
    datasetType?: string,
  ) {
    setBusy(reviewId);
    try {
      const res = await fetch(`/api/datasets/reviews/${reviewId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, datasetType }),
      });
      if (res.ok) {
        setItems((cur) => cur.filter((i) => i.reviewId !== reviewId));
        setReassignFor(null);
        onDecided();
      }
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading review queue
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
        <p className="text-[15px] font-semibold">Review queue is clear</p>
        <p className="mt-1 text-sm text-muted">
          Low-confidence classifications will land here for your decision —
          approve, reassign to the right type, or reject.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.reviewId} className="rounded-lg bg-paper p-4 shadow-hairline">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
              {item.suggestedTypeLabel}
            </span>
            <span className="font-mono text-[12px] text-subtle">
              {Math.round(item.confidence * 100)}% confidence · {item.engine}
            </span>
            <span className="text-[13px] text-muted">
              {item.documentName} · {item.sourceName}
            </span>
          </div>
          <p className="mt-2 line-clamp-3 text-[14px] text-muted">
            {item.chunkText}
          </p>
          {reassignFor === item.reviewId ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={reassignType}
                onChange={(e) => setReassignType(e.target.value)}
                className="h-10 rounded-full border border-line bg-paper px-4 text-[14px]"
                aria-label="Reassign to type"
              >
                {REASSIGN_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy === item.reviewId}
                onClick={() => void decide(item.reviewId, "reassign", reassignType)}
                className="aos-press h-10 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                Confirm reassign
              </button>
              <button
                type="button"
                onClick={() => setReassignFor(null)}
                className="aos-press h-10 rounded-full px-4 text-[14px] font-semibold text-muted"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy === item.reviewId}
                onClick={() => void decide(item.reviewId, "approve")}
                className="aos-press h-10 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => {
                  setReassignFor(item.reviewId);
                  setReassignType(item.suggestedType);
                }}
                className="aos-press h-10 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline"
              >
                Reassign
              </button>
              <button
                type="button"
                disabled={busy === item.reviewId}
                onClick={() => void decide(item.reviewId, "reject")}
                className="aos-press h-10 rounded-full px-4 text-[14px] font-semibold text-failed-text"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AddSourcePanel({
  onAdded,
  onCancel,
}: {
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<SourceKind>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state per kind.
  const [file, setFile] = useState<File | null>(null);
  const [uploadLabel, setUploadLabel] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [driveFileId, setDriveFileId] = useState("");
  const [driveFiles, setDriveFiles] = useState<
    { id: string; name: string; mimeType: string }[]
  >([]);
  const [url, setUrl] = useState("");
  const [urlLabel, setUrlLabel] = useState("");
  const [pasteLabel, setPasteLabel] = useState("");
  const [pasteText, setPasteText] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let res: Response;
      if (kind === "upload") {
        if (!file) throw new Error("Choose a file to upload (PDF, DOCX, CSV, or MD).");
        const form = new FormData();
        form.append("file", file);
        if (uploadLabel.trim()) form.append("label", uploadLabel.trim());
        res = await fetch("/api/datasets/sources", { method: "POST", body: form });
      } else if (kind === "drive") {
        if (!connectionId.trim() || !driveFileId.trim()) {
          throw new Error("Enter a Nango connection id and pick a Drive file.");
        }
        res = await fetch("/api/datasets/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "drive",
            connectionId: connectionId.trim(),
            fileId: driveFileId.trim(),
          }),
        });
      } else if (kind === "web") {
        if (!url.trim()) throw new Error("Enter a website URL to crawl.");
        res = await fetch("/api/datasets/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "web",
            url: url.trim(),
            ...(urlLabel.trim() ? { label: urlLabel.trim() } : {}),
          }),
        });
      } else {
        if (!pasteLabel.trim() || !pasteText.trim()) {
          throw new Error("Pasted text needs an explicit source label.");
        }
        res = await fetch("/api/datasets/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "paste",
            label: pasteLabel.trim(),
            text: pasteText,
          }),
        });
      }
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? json?.message ?? `Request failed (${res.status}).`);
      }
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadDriveFiles() {
    if (!connectionId.trim()) {
      setError("Enter a Nango connection id first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/datasets/drive/files?connectionId=${encodeURIComponent(connectionId.trim())}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? json?.message ?? "Could not list Drive files.");
      setDriveFiles(json.files ?? []);
      if ((json.files ?? []).length > 0) setDriveFileId(json.files[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "h-11 w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-[15px] placeholder:text-subtle focus:border-focus focus:outline-none";
  const labelCls = "mb-1 block text-[13px] font-semibold";

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-lg bg-paper p-4 shadow-hairline md:p-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[18px] font-bold" style={{ fontStretch: "115%" }}>
          Add source
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="aos-press h-9 rounded-full px-4 text-[14px] font-semibold text-muted shadow-outline"
        >
          Cancel
        </button>
      </div>

      {/* Kind picker */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Source kind">
        {(Object.keys(KIND_META) as SourceKind[]).map((k) => {
          const Icon = KIND_META[k].icon;
          const active = kind === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setKind(k);
                setError(null);
              }}
              className={`aos-press flex h-9 items-center gap-2 rounded-full px-4 text-[14px] font-semibold ${
                active ? "bg-black text-white" : "bg-canvas text-ink"
              }`}
            >
              <Icon size={15} />
              {KIND_META[k].label}
            </button>
          );
        })}
      </div>

      {kind === "upload" && (
        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls} htmlFor="ds-file">
              File
            </label>
            <input
              id="ds-file"
              type="file"
              accept=".pdf,.docx,.csv,.md,.markdown"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-[14px]"
            />
            <p className="mt-1 text-[13px] text-muted">PDF, DOCX, CSV, or MD — up to 10 MB.</p>
          </div>
          <div>
            <label className={labelCls} htmlFor="ds-upload-label">
              Label (optional)
            </label>
            <input
              id="ds-upload-label"
              value={uploadLabel}
              onChange={(e) => setUploadLabel(e.target.value)}
              placeholder="Pricing one-pager"
              className={inputCls}
            />
          </div>
        </div>
      )}

      {kind === "drive" && (
        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls} htmlFor="ds-conn">
              Nango connection id
            </label>
            <div className="flex gap-2">
              <input
                id="ds-conn"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                placeholder="google-drive-prod"
                className={inputCls}
              />
              <button
                type="button"
                onClick={loadDriveFiles}
                disabled={busy}
                className="aos-press h-11 shrink-0 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
              >
                List files
              </button>
            </div>
            <p className="mt-1 text-[13px] text-muted">
              Connect Google Drive through Nango Cloud, then list and pick a file.
            </p>
          </div>
          {driveFiles.length > 0 && (
            <div>
              <label className={labelCls} htmlFor="ds-drive-file">
                Drive file
              </label>
              <select
                id="ds-drive-file"
                value={driveFileId}
                onChange={(e) => setDriveFileId(e.target.value)}
                className={inputCls}
              >
                {driveFiles.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {kind === "web" && (
        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls} htmlFor="ds-url">
              Website URL
            </label>
            <input
              id="ds-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/pricing"
              inputMode="url"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="ds-url-label">
              Label (optional)
            </label>
            <input
              id="ds-url-label"
              value={urlLabel}
              onChange={(e) => setUrlLabel(e.target.value)}
              placeholder="Acme pricing page"
              className={inputCls}
            />
          </div>
        </div>
      )}

      {kind === "paste" && (
        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls} htmlFor="ds-paste-label">
              Source label
            </label>
            <input
              id="ds-paste-label"
              value={pasteLabel}
              onChange={(e) => setPasteLabel(e.target.value)}
              placeholder="Founder notes 2026-10-01"
              className={inputCls}
            />
            <p className="mt-1 text-[13px] text-muted">
              The label you give is how every chunk from this text stays traced.
            </p>
          </div>
          <div>
            <label className={labelCls} htmlFor="ds-paste-text">
              Text
            </label>
            <textarea
              id="ds-paste-text"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={6}
              placeholder="Paste the text to ingest…"
              className="w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-[15px] placeholder:text-subtle focus:border-focus focus:outline-none"
            />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-[14px] text-failed-text">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={busy}
          className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-6 text-[15px] font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={15} className="animate-spin" />}
          {busy ? "Adding" : `Add ${KIND_META[kind].label.toLowerCase()} source`}
        </button>
      </div>
    </form>
  );
}
