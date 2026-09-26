// Marketr CRM — modals: new lead, new pipeline, CSV import.
"use client";

import { useState } from "react";
import { X, Upload } from "lucide-react";
import type { CrmPipeline } from "./types";
import { SOURCE_LABELS } from "./types";

function Shell({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="crm-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="crm-modal-card" style={wide ? { width: 640 } : undefined}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3.5">
          <h3 className="text-[15px] font-bold text-stone-900">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function NewLeadModal({
  pipelines, defaultPipelineId, onClose, onCreated,
}: {
  pipelines: CrmPipeline[];
  defaultPipelineId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [f, setF] = useState({
    name: "", email: "", phone: "", company: "", title: "",
    source: "website_form", pipelineId: defaultPipelineId, value: "", ownerName: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const valueCents = f.value.trim() === "" ? null : Math.round(Number(f.value.replace(/[$,]/g, "")) * 100);
      const r = await fetch("/api/crm/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: f.name.trim(), email: f.email.trim() || null, phone: f.phone.trim() || null,
          company: f.company.trim() || null, title: f.title.trim() || null,
          source: f.source, pipelineId: f.pipelineId,
          ownerName: f.ownerName.trim() || null, valueCents,
        }),
      });
      const d = await r.json();
      if (r.status === 409) throw new Error(`Duplicate: this contact already exists as "${d.existing?.name ?? "a lead"}".`);
      if (!r.ok) throw new Error(d.error || "Create failed");
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "crm-input w-full !text-[13px]";
  return (
    <Shell title="New lead" onClose={onClose}>
      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="crm-label">Name *</label><input className={inputCls} value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus /></div>
        <div><label className="crm-label">Email</label><input className={inputCls} value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
        <div><label className="crm-label">Phone</label><input className={inputCls} value={f.phone} onChange={(e) => set("phone", e.target.value)} /></div>
        <div><label className="crm-label">Company</label><input className={inputCls} value={f.company} onChange={(e) => set("company", e.target.value)} /></div>
        <div><label className="crm-label">Title</label><input className={inputCls} value={f.title} onChange={(e) => set("title", e.target.value)} /></div>
        <div>
          <label className="crm-label">Source</label>
          <select className="crm-select w-full !text-[13px]" value={f.source} onChange={(e) => set("source", e.target.value)}>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div><label className="crm-label">Value ($)</label><input className={inputCls} value={f.value} onChange={(e) => set("value", e.target.value)} inputMode="decimal" placeholder="e.g. 5000" /></div>
        <div>
          <label className="crm-label">Pipeline</label>
          <select className="crm-select w-full !text-[13px]" value={f.pipelineId} onChange={(e) => set("pipelineId", e.target.value)}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div><label className="crm-label">Owner</label><input className={inputCls} value={f.ownerName} onChange={(e) => set("ownerName", e.target.value)} /></div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="crm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="crm-btn-primary" onClick={submit} disabled={busy || !f.name.trim()}>
          {busy ? "Creating…" : "Create lead"}
        </button>
      </div>
    </Shell>
  );
}

export function PipelineModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (p: CrmPipeline) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/crm/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Create failed");
      onCreated(d.pipeline);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="New pipeline" onClose={onClose}>
      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
      <label className="crm-label">Pipeline name *</label>
      <input
        className="crm-input w-full !text-[13px]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. SMB — Q4"
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <p className="mt-2 text-[12px] text-stone-500">
        Starts with the standard stages: New → Contacted → Qualified → Proposal → Won / Lost.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="crm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="crm-btn-primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create pipeline"}
        </button>
      </div>
    </Shell>
  );
}

interface ImportReport {
  created: number; duplicates: number; errors: { row: number; error: string }[];
}

export function ImportModal({
  pipelineId, onClose, onDone,
}: {
  pipelineId: string; onClose: () => void; onDone: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const r = await fetch("/api/crm/leads/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, pipelineId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Import failed");
      setReport(d);
      if (d.created > 0) onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <Shell title="Import leads (CSV)" onClose={onClose} wide>
      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
      {!report ? (
        <>
          <label
            className="mb-3 flex cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-[13px] text-stone-600 hover:border-violet-400 hover:bg-violet-50"
            onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); }}
            onDragOver={(e) => e.preventDefault()}
          >
            <Upload size={18} className="text-violet-600" />
            Drop a CSV file here, or click to browse
            <input
              type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? undefined)}
            />
          </label>
          <textarea
            className="crm-input h-40 w-full font-mono !text-[12px]"
            placeholder={"name,email,phone,company,title,source,valueCents,stage\nJane Doe,jane@acme.com,555-1234,Acme,CEO,referral,500000,new"}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
          <p className="mt-2 text-[12px] text-stone-500">
            Header row required. Columns: name, email, phone, company, title, source, valueCents, stage. Max 5,000 rows, 2 MB.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="crm-btn-ghost" onClick={onClose}>Cancel</button>
            <button className="crm-btn-primary" onClick={run} disabled={busy || !csv.trim()}>
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-green-50 px-3 py-2 text-center">
              <div className="text-[18px] font-bold text-green-700 tabular-nums">{report.created}</div>
              <div className="text-[11px] text-stone-500">Created</div>
            </div>
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-center">
              <div className="text-[18px] font-bold text-amber-700 tabular-nums">{report.duplicates}</div>
              <div className="text-[11px] text-stone-500">Duplicates skipped</div>
            </div>
            <div className="rounded-lg bg-red-50 px-3 py-2 text-center">
              <div className="text-[18px] font-bold text-red-700 tabular-nums">{report.errors.length}</div>
              <div className="text-[11px] text-stone-500">Errors</div>
            </div>
          </div>
          {report.errors.length > 0 && (
            <ul className="mb-3 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-stone-200 p-3">
              {report.errors.map((e, i) => (
                <li key={i} className="text-[12.5px] text-stone-600">
                  <span className="font-semibold">Row {e.row}:</span> {e.error}
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <button className="crm-btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Shell>
  );
}
