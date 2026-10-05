// Marketr — Legal/Compliance slice 3: document vault view (client).
// Versioned vault for formation docs, contracts, licenses, EIN letters —
// with expiring-document alerts riding the slice-2 escalation ladder.
// Guardrail: expiry dates come only from the tenant (set by them or read
// from the document) — the UI never renders a guessed date, only
// "no expiry recorded".
// Agentic OS: white cards radius-lg, pills for pressables, tokens only,
// Lucide icons only, sentence case, monochrome urgency pills (the status
// color+shape language is reserved for genuine agent states).

"use client";

import { useState } from "react";
import {
  Archive,
  CalendarClock,
  CalendarDays,
  CalendarX,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  Info,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  EXPIRY_SOURCE_LABELS,
  type ExpiryTier,
  type LegalDocumentType,
  type LegalExpirySource,
} from "@/lib/legal/documents";
import { confirmAction } from "@/lib/ui/feedback";

export interface DocumentVersionView {
  id: string;
  versionNumber: number;
  filename: string;
  logicalPath: string;
  mimeType: string;
  sizeBytes: number;
  workspaceFileId: string;
  uploadedBy: string;
  uploadedAt: string;
  expiryDate: string | null;
  expirySource: LegalExpirySource | null;
  issuer: string | null;
  supersedesVersionNumber: number | null;
}

export interface DocumentView {
  id: string;
  docType: LegalDocumentType;
  title: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  currentVersion: DocumentVersionView | null;
  tier: ExpiryTier | null;
  daysUntilExpiry: number | null;
}

export interface DocumentDetailView extends DocumentView {
  versions: DocumentVersionView[];
}

const TIER_META: Record<ExpiryTier | "ontrack", { label: string; icon: typeof Clock }> = {
  overdue: { label: "Expired", icon: TriangleAlert },
  due_7: { label: "Expires in 7 days", icon: Clock },
  due_30: { label: "Expires in 30 days", icon: CalendarClock },
  due_90: { label: "Expires in 90 days", icon: CalendarDays },
  date_needed: { label: "No expiry recorded", icon: CalendarX },
  ontrack: { label: "On track", icon: CheckCircle2 },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function daysText(days: number | null): string | null {
  if (days === null) return null;
  if (days < 0) return `${-days} ${-days === 1 ? "day" : "days"} past expiry`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

function TierPill({ tier }: { tier: ExpiryTier | null }) {
  const key = tier ?? "ontrack";
  const meta = TIER_META[key];
  const Icon = meta.icon;
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
      <Icon size={13} />
      {meta.label}
    </span>
  );
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return new Date().toISOString().slice(0, 10);
  return new Date(iso).toISOString().slice(0, 10);
}

function UploadForm({
  documentId,
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  /** Omit to create a new document; set to add a version to it. */
  documentId?: string;
  initial: {
    docType: LegalDocumentType;
    title: string;
    notes: string;
    expiryDate: string | null;
    expirySource: LegalExpirySource;
    issuer: string;
  };
  busy: boolean;
  submitLabel: string;
  onSubmit: (form: FormData) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<LegalDocumentType>(initial.docType);
  const [title, setTitle] = useState(initial.title);
  const [notes, setNotes] = useState(initial.notes);
  const [useExpiry, setUseExpiry] = useState(initial.expiryDate !== null);
  const [expiryDate, setExpiryDate] = useState(toDateInputValue(initial.expiryDate));
  const [expirySource, setExpirySource] = useState<LegalExpirySource>(initial.expirySource);
  const [issuer, setIssuer] = useState(initial.issuer);

  function submit() {
    if (!file) return;
    const form = new FormData();
    if (documentId) form.set("documentId", documentId);
    if (!documentId) {
      form.set("docType", docType);
      form.set("title", title.trim());
      form.set("notes", notes.trim());
    }
    if (useExpiry && expiryDate) {
      form.set("expiryDate", new Date(`${expiryDate}T12:00:00Z`).toISOString());
      form.set("expirySource", expirySource);
    }
    if (issuer.trim()) form.set("issuer", issuer.trim());
    form.set("file", file);
    onSubmit(form);
  }

  const canSubmit = file !== null && (documentId !== undefined || title.trim().length > 0);

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-md bg-canvas p-3">
      {!documentId && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as LegalDocumentType)}
            className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
            aria-label="Document type"
          >
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {DOCUMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title"
            className="h-10 min-w-0 flex-1 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-10 cursor-pointer items-center gap-1.5 rounded-full bg-paper px-4 text-[14px] font-semibold shadow-hairline">
          <Upload size={14} />
          {file ? file.name : "Choose file"}
          <input
            type="file"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {file && (
          <span className="text-[13px] text-muted">{formatBytes(file.size)} · 25 MB max</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={useExpiry}
            onChange={(e) => setUseExpiry(e.target.checked)}
            className="h-4 w-4 accent-black"
          />
          Has an expiry date
        </label>
        {useExpiry && (
          <>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
              aria-label="Expiry date"
            />
            <select
              value={expirySource}
              onChange={(e) => setExpirySource(e.target.value as LegalExpirySource)}
              className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
              aria-label="Expiry date source"
            >
              {(Object.keys(EXPIRY_SOURCE_LABELS) as LegalExpirySource[]).map((s) => (
                <option key={s} value={s}>
                  {EXPIRY_SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {!useExpiry && (
        <p className="text-[13px] text-muted">
          Leaving this unchecked keeps it as "no expiry recorded" — expiry dates are never guessed.
        </p>
      )}
      <input
        type="text"
        value={issuer}
        onChange={(e) => setIssuer(e.target.value)}
        placeholder="Issuer (optional)"
        className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !canSubmit}
          onClick={submit}
          className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="aos-press flex h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold text-muted"
        >
          <X size={14} />
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: {
    title: string;
    notes: string;
    docType: LegalDocumentType;
    expiryDate: string | null;
    expirySource: LegalExpirySource;
    issuer: string;
  };
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [notes, setNotes] = useState(initial.notes);
  const [docType, setDocType] = useState<LegalDocumentType>(initial.docType);
  const [useExpiry, setUseExpiry] = useState(initial.expiryDate !== null);
  const [expiryDate, setExpiryDate] = useState(toDateInputValue(initial.expiryDate));
  const [expirySource, setExpirySource] = useState<LegalExpirySource>(initial.expirySource);
  const [issuer, setIssuer] = useState(initial.issuer);

  function save() {
    onSave({
      title: title.trim(),
      notes: notes.trim() || null,
      docType,
      expiryDate:
        useExpiry && expiryDate
          ? new Date(`${expiryDate}T12:00:00Z`).toISOString()
          : null,
      expirySource,
      issuer: issuer.trim() || null,
    });
  }

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-md bg-canvas p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value as LegalDocumentType)}
          className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
          aria-label="Document type"
        >
          {DOCUMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {DOCUMENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title"
          className="h-10 min-w-0 flex-1 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
        />
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={2}
        className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-[14px]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[14px]">
          <input
            type="checkbox"
            checked={useExpiry}
            onChange={(e) => setUseExpiry(e.target.checked)}
            className="h-4 w-4 accent-black"
          />
          Has an expiry date
        </label>
        {useExpiry && (
          <>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
              aria-label="Expiry date"
            />
            <select
              value={expirySource}
              onChange={(e) => setExpirySource(e.target.value as LegalExpirySource)}
              className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
              aria-label="Expiry date source"
            >
              {(Object.keys(EXPIRY_SOURCE_LABELS) as LegalExpirySource[]).map((s) => (
                <option key={s} value={s}>
                  {EXPIRY_SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      <input
        type="text"
        value={issuer}
        onChange={(e) => setIssuer(e.target.value)}
        placeholder="Issuer (optional)"
        className="h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[14px]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || title.trim().length === 0}
          onClick={save}
          className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Save changes
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="aos-press flex h-10 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold text-muted"
        >
          <X size={14} />
          Cancel
        </button>
      </div>
    </div>
  );
}

function VersionRow({
  v,
  isCurrent,
  workspaceId,
}: {
  v: DocumentVersionView;
  isCurrent: boolean;
  workspaceId: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-canvas px-3 py-2">
      <span className="flex items-center gap-1.5 text-[14px] font-semibold">
        <FileText size={14} />
        v{v.versionNumber}
        {isCurrent && (
          <span className="rounded-full bg-black px-2 py-0.5 text-[11px] font-semibold text-white">
            Current
          </span>
        )}
      </span>
      <span className="text-[13px] text-muted">{v.filename}</span>
      <span className="text-[13px] text-muted">{formatBytes(v.sizeBytes)}</span>
      <span className="text-[13px] text-muted">{formatDate(v.uploadedAt)}</span>
      {v.supersedesVersionNumber !== null && (
        <span className="text-[13px] text-muted">
          Supersedes v{v.supersedesVersionNumber}
        </span>
      )}
      <a
        href={`/api/files/${encodeURIComponent(v.workspaceFileId)}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`}
        className="aos-press ml-auto flex h-9 items-center gap-1.5 rounded-full bg-paper px-4 text-[13px] font-semibold shadow-hairline"
      >
        Download
      </a>
    </div>
  );
}

export function DocumentsView({
  documents,
  workspaceId,
  disclaimer,
  onChanged,
}: {
  documents: DocumentView[];
  workspaceId: string;
  disclaimer: string;
  onChanged: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [versioningId, setVersioningId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<DocumentDetailView | null>(null);

  const attentionCount = documents.filter(
    (d) => d.tier && d.tier !== "due_90",
  ).length;
  const noExpiryCount = documents.filter((d) => d.tier === "date_needed").length;

  async function upload(form: FormData) {
    setBusyKey(form.get("documentId") ? `version:${form.get("documentId")}` : "new");
    try {
      const res = await fetch("/api/legal/documents", { method: "POST", body: form });
      if (res.ok) {
        setAdding(false);
        setVersioningId(null);
        onChanged();
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function patch(id: string, patch: Record<string, unknown>) {
    setBusyKey(id);
    try {
      const res = await fetch(`/api/legal/documents/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        setEditingId(null);
        onChanged();
      }
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(id: string) {
    const ok = await confirmAction({
      title: "Delete this document?",
      description: "It is removed from the legal workspace.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusyKey(id);
    try {
      const res = await fetch(`/api/legal/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.ok) onChanged();
    } finally {
      setBusyKey(null);
    }
  }

  async function toggleHistory(id: string) {
    if (historyId === id) {
      setHistoryId(null);
      setHistory(null);
      return;
    }
    setBusyKey(`history:${id}`);
    try {
      const res = await fetch(`/api/legal/documents/${encodeURIComponent(id)}`);
      if (res.ok) {
        const json = await res.json();
        setHistory(json.document as DocumentDetailView);
        setHistoryId(id);
      }
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <Info size={16} className="mt-0.5 shrink-0" />
        <p className="text-[14px]">{disclaimer}</p>
      </div>

      <p className="text-[13px] text-muted">
        {documents.length} {documents.length === 1 ? "document" : "documents"} in the vault
        {attentionCount > 0 && ` · ${attentionCount} need${attentionCount === 1 ? "s" : ""} attention`}
        {noExpiryCount > 0 && ` · ${noExpiryCount} with no expiry recorded`}
      </p>

      {documents.length === 0 && !adding ? (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <Archive size={28} className="mx-auto text-muted" />
          <p className="mt-2 text-[15px] font-semibold">No documents yet</p>
          <p className="mt-1 text-sm text-muted">
            Store formation docs, contracts, licenses, and EIN letters here.
            Every upload is versioned — nothing is ever overwritten.
          </p>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="aos-press mx-auto mt-4 flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white"
          >
            <Plus size={14} />
            Add a document
          </button>
        </div>
      ) : (
        <div>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white"
            >
              <Plus size={14} />
              Add a document
            </button>
          )}
        </div>
      )}

      {adding && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <h3 className="text-[15px] font-semibold">Add a document</h3>
          <UploadForm
            initial={{
              docType: "formation",
              title: "",
              notes: "",
              expiryDate: null,
              expirySource: "tenant_set",
              issuer: "",
            }}
            busy={busyKey === "new"}
            submitLabel="Upload document"
            onSubmit={(form) => void upload(form)}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <div className="flex flex-col gap-3">
        {documents.map((d) => {
          const busy = busyKey === d.id;
          const editing = editingId === d.id;
          const versioning = versioningId === d.id;
          const showingHistory = historyId === d.id && history;
          const cv = d.currentVersion;
          return (
            <article key={d.id} className="rounded-lg bg-paper p-4 shadow-hairline">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 flex-1 text-[15px] font-semibold">{d.title}</h3>
                <TierPill tier={d.tier} />
              </div>
              <p className="mt-1.5 text-[14px] text-muted">
                {cv?.expiryDate ? (
                  <>
                    Expires {formatDate(cv.expiryDate)}
                    {daysText(d.daysUntilExpiry) && (
                      <span className="font-semibold text-ink"> · {daysText(d.daysUntilExpiry)}</span>
                    )}
                  </>
                ) : (
                  <span className="font-semibold text-ink">
                    No expiry recorded yet — set one to schedule reminders.
                  </span>
                )}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-canvas px-3 py-1 text-[13px] font-semibold">
                  {DOCUMENT_TYPE_LABELS[d.docType]}
                </span>
                {cv && (
                  <span className="text-[13px] text-muted">
                    v{cv.versionNumber} · {cv.filename} · {formatBytes(cv.sizeBytes)}
                  </span>
                )}
                <span className="text-[13px] text-muted">
                  {d.versionCount} {d.versionCount === 1 ? "version" : "versions"}
                </span>
              </div>
              {d.notes && <p className="mt-1.5 text-[14px] text-muted">{d.notes}</p>}
              {cv?.issuer && (
                <p className="mt-1 text-[13px] text-muted">Issuer: {cv.issuer}</p>
              )}
              {cv?.expirySource && cv.expiryDate && (
                <p className="mt-1 text-[13px] text-muted">
                  Expiry {cv.expirySource === "read_from_document" ? "read from the document" : "set by you"}
                </p>
              )}

              {editing ? (
                <EditForm
                  initial={{
                    title: d.title,
                    notes: d.notes ?? "",
                    docType: d.docType,
                    expiryDate: cv?.expiryDate ?? null,
                    expirySource: cv?.expirySource ?? "tenant_set",
                    issuer: cv?.issuer ?? "",
                  }}
                  busy={busy}
                  onSave={(patchBody) => void patch(d.id, patchBody)}
                  onCancel={() => setEditingId(null)}
                />
              ) : versioning ? (
                <UploadForm
                  documentId={d.id}
                  initial={{
                    docType: d.docType,
                    title: d.title,
                    notes: "",
                    expiryDate: cv?.expiryDate ?? null,
                    expirySource: cv?.expirySource ?? "tenant_set",
                    issuer: cv?.issuer ?? "",
                  }}
                  busy={busyKey === `version:${d.id}`}
                  submitLabel="Upload new version"
                  onSubmit={(form) => void upload(form)}
                  onCancel={() => setVersioningId(null)}
                />
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setVersioningId(d.id)}
                    className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-black px-5 text-[14px] font-semibold text-white disabled:opacity-50"
                  >
                    <Upload size={14} />
                    New version
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditingId(d.id)}
                    className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline disabled:opacity-50"
                  >
                    <Pencil size={14} />
                    Edit details
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void toggleHistory(d.id)}
                    className="aos-press flex h-10 items-center gap-1.5 rounded-full bg-paper px-5 text-[14px] font-semibold shadow-hairline disabled:opacity-50"
                  >
                    {busyKey === `history:${d.id}` ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <ChevronDown
                        size={14}
                        className={showingHistory ? "rotate-180" : ""}
                      />
                    )}
                    Version history
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(d.id)}
                    className="aos-press flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-semibold text-failed-text disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>
              )}

              {showingHistory && history && (
                <div className="mt-3 flex flex-col gap-2">
                  {history.versions.map((v) => (
                    <VersionRow
                      key={v.id}
                      v={v}
                      isCurrent={v.id === history.currentVersion?.id}
                      workspaceId={workspaceId}
                    />
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
