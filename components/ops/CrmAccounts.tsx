// ShapesOS Phase 10 (ops-core) — CRM accounts views inside /dashboard/crm:
// Contacts, Companies, Deals (board on the active pipeline's stages), and
// the lead slide-over's "Convert to contact" strip. Data: the generic
// /api/ops/{contacts,companies,deals} routes + /api/ops/crm/convert-lead.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Contact, Handshake, Loader2, Plus, Search, UserCheck } from "lucide-react";
import type { CrmPipeline } from "@/components/crm/types";
import {
  Avatar,
  StageBadge,
  btnGhost,
  btnGhostSm,
  btnPrimary,
  chipCls,
  errorBoxCls,
  inputCls,
  labelCls,
  noteBoxCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/crm/ui";
import { Board } from "./Board";
import { EmptyBlock, LoadingLine, OpsModal, fmtCents, fmtDate, opsJson, sentence, toCents, useOpsList } from "./shared";

export interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  phone: string | null;
  industry: string | null;
  createdAt: string;
}
export interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  companyId: string | null;
  leadId: string | null;
  createdAt: string;
}
export interface DealRow {
  id: string;
  title: string;
  pipelineId: string;
  stage: string;
  valueCents: number;
  status: string;
  ownerName: string | null;
  contactId: string | null;
  companyId: string | null;
  expectedCloseAt: string | null;
  createdAt: string;
}

function useSearch<T>(rows: T[], text: (r: T) => string) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? rows.filter((r) => text(r).toLowerCase().includes(n)) : rows;
  }, [rows, q, text]);
  return { q, setQ, filtered };
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
      <input className={`${inputCls} pl-8`} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function ContactsView() {
  const contacts = useOpsList<ContactRow>("contacts");
  const companies = useOpsList<CompanyRow>("companies");
  const C = useMemo(() => new Map(companies.rows.map((c) => [c.id, c])), [companies.rows]);
  const text = useCallback((r: ContactRow) => `${r.name} ${r.email ?? ""} ${C.get(r.companyId ?? "")?.name ?? ""}`, [C]);
  const { q, setQ, filtered } = useSearch(contacts.rows, text);
  const [show, setShow] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Search contacts…" />
        <button type="button" className={btnPrimary} onClick={() => setShow(true)}>
          <Plus size={15} /> New contact
        </button>
        <span className="ml-auto text-[0.8125rem] text-muted">Leads become contacts with “Convert to contact” on the lead.</span>
      </div>
      {contacts.error && <div className={errorBoxCls}>{contacts.error}</div>}
      {contacts.loading ? (
        <LoadingLine label="Loading contacts…" />
      ) : filtered.length === 0 ? (
        <EmptyBlock icon={Contact} title="No contacts yet" hint="Add one, or convert a lead." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr>
                <th className={thCls}>Name</th>
                <th className={thCls}>Email</th>
                <th className={thCls}>Company</th>
                <th className={thCls}>Title</th>
                <th className={thCls}>Source</th>
                <th className={thCls}>Added</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td className={tdCls}>
                    <span className="inline-flex items-center gap-2 font-semibold">
                      <Avatar name={c.name} size={22} /> {c.name}
                    </span>
                  </td>
                  <td className={`${tdCls} text-muted`}>{c.email ?? "—"}</td>
                  <td className={tdCls}>{C.get(c.companyId ?? "")?.name ?? "—"}</td>
                  <td className={`${tdCls} text-muted`}>{c.title ?? "—"}</td>
                  <td className={tdCls}>{c.leadId ? <span className={chipCls}>Converted lead</span> : <span className="text-muted">Manual</span>}</td>
                  <td className={`${tdCls} text-muted`}>{fmtDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <NewContactModal companies={companies.rows} onClose={() => setShow(false)} onCreated={contacts.reload} />}
    </div>
  );
}

function NewContactModal({ companies, onClose, onCreated }: { companies: CompanyRow[]; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ name: "", email: "", phone: "", title: "", companyId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { name: f.name.trim() };
      for (const k of ["email", "phone", "title", "companyId"] as const) if (f[k].trim()) body[k] = f[k].trim();
      await opsJson("/api/ops/contacts", "POST", body);
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the contact.");
    } finally {
      setBusy(false);
    }
  }
  const field = (k: keyof typeof f, label: string) => (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <input className={`${inputCls} w-full`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <OpsModal title="New contact" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {field("name", "Name")}
        <div className="grid grid-cols-2 gap-3">
          {field("email", "Email")}
          {field("phone", "Phone")}
          {field("title", "Title")}
          <label className="block">
            <span className={labelCls}>Company</span>
            <select className={`${selectCls} w-full`} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
              <option value="">Match by email domain</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.name.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create contact
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export function CompaniesView() {
  const companies = useOpsList<CompanyRow>("companies");
  const contacts = useOpsList<ContactRow>("contacts");
  const deals = useOpsList<DealRow>("deals");
  const text = useCallback((r: CompanyRow) => `${r.name} ${r.domain ?? ""} ${r.industry ?? ""}`, []);
  const { q, setQ, filtered } = useSearch(companies.rows, text);
  const [show, setShow] = useState(false);
  const counts = useMemo(() => {
    const m = new Map<string, { contacts: number; openCents: number }>();
    for (const c of contacts.rows) if (c.companyId) m.set(c.companyId, { ...(m.get(c.companyId) ?? { contacts: 0, openCents: 0 }), contacts: (m.get(c.companyId)?.contacts ?? 0) + 1 });
    for (const d of deals.rows)
      if (d.companyId && d.status === "open") {
        const cur = m.get(d.companyId) ?? { contacts: 0, openCents: 0 };
        m.set(d.companyId, { ...cur, openCents: cur.openCents + d.valueCents });
      }
    return m;
  }, [contacts.rows, deals.rows]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Search companies…" />
        <button type="button" className={btnPrimary} onClick={() => setShow(true)}>
          <Plus size={15} /> New company
        </button>
      </div>
      {companies.error && <div className={errorBoxCls}>{companies.error}</div>}
      {companies.loading ? (
        <LoadingLine label="Loading companies…" />
      ) : filtered.length === 0 ? (
        <EmptyBlock icon={Building2} title="No companies yet" hint="Companies are created when you convert leads, or add one here." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr>
                <th className={thCls}>Company</th>
                <th className={thCls}>Domain</th>
                <th className={thCls}>Industry</th>
                <th className={`${thCls} text-right`}>Contacts</th>
                <th className={`${thCls} text-right`}>Open deals</th>
                <th className={thCls}>Added</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td className={`${tdCls} font-semibold`}>{c.name}</td>
                  <td className={`${tdCls} font-mono text-[0.75rem] text-muted`}>{c.domain ?? "—"}</td>
                  <td className={`${tdCls} text-muted`}>{c.industry ?? "—"}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{counts.get(c.id)?.contacts ?? 0}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{fmtCents(counts.get(c.id)?.openCents ?? 0)}</td>
                  <td className={`${tdCls} text-muted`}>{fmtDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <NewCompanyModal onClose={() => setShow(false)} onCreated={companies.reload} />}
    </div>
  );
}

function NewCompanyModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ name: "", domain: "", industry: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { name: f.name.trim() };
      for (const k of ["domain", "industry", "phone"] as const) if (f[k].trim()) body[k] = f[k].trim();
      await opsJson("/api/ops/companies", "POST", body);
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the company.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="New company" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {(["name", "domain", "industry", "phone"] as const).map((k) => (
          <label key={k} className="block">
            <span className={labelCls}>{k === "domain" ? "Domain (e.g. acme.com)" : sentence(k)}</span>
            <input className={`${inputCls} w-full`} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.name.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create company
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Deals board (the active pipeline's stage machine)
// ---------------------------------------------------------------------------

export function DealsView({ pipeline }: { pipeline: CrmPipeline }) {
  const deals = useOpsList<DealRow>("deals", { pipelineId: pipeline.id });
  const companies = useOpsList<CompanyRow>("companies");
  const C = useMemo(() => new Map(companies.rows.map((c) => [c.id, c])), [companies.rows]);
  const [rows, setRows] = useState<DealRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => setRows(null), [deals.rows]);
  const list = rows ?? deals.rows;
  const open = list.filter((d) => d.status === "open").reduce((s, d) => s + d.valueCents, 0);
  const won = list.filter((d) => d.status === "won").reduce((s, d) => s + d.valueCents, 0);

  const move = async (id: string, stage: string) => {
    const before = list;
    setRows(list.map((d) => (d.id === id ? { ...d, stage, status: stage === "won" ? "won" : stage === "lost" ? "lost" : "open" } : d)));
    try {
      await opsJson("/api/ops/deals", "PATCH", { id, stage });
      setError(null);
    } catch (e) {
      setRows(before);
      setError(e instanceof Error ? e.message : "Move failed.");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} onClick={() => setShow(true)}>
          <Plus size={15} /> New deal
        </button>
        <span className="ml-auto flex gap-4 text-[0.8125rem] text-muted">
          <span>
            Open <span className="font-bold tabular-nums text-ink">{fmtCents(open)}</span>
          </span>
          <span>
            Won <span className="font-bold tabular-nums text-ink">{fmtCents(won)}</span>
          </span>
        </span>
      </div>
      {(error || deals.error) && <div className={errorBoxCls}>{error ?? deals.error}</div>}
      {deals.loading ? (
        <LoadingLine label="Loading deals…" />
      ) : (
        <Board
          columns={pipeline.stages}
          items={list}
          columnOf={(d) => d.stage}
          cardLabel={(d) => d.title}
          onMove={move}
          emptyHint="Drop deals here"
          renderHeader={(c, col) => {
            const s = pipeline.stages.find((x) => x.id === c.id)!;
            return (
              <>
                <span className="flex items-center gap-2">
                  <StageBadge label={s.label} color={s.color} />
                  <span className="text-[0.75rem] font-semibold tabular-nums text-muted">{col.length}</span>
                </span>
                <span className="text-[0.75rem] font-semibold tabular-nums text-muted">{fmtCents(col.reduce((a, d) => a + d.valueCents, 0))}</span>
              </>
            );
          }}
          renderCard={(d) => (
            <>
              <div className="truncate text-[0.8125rem] font-semibold text-ink">{d.title}</div>
              <div className="truncate text-[0.75rem] text-muted">{C.get(d.companyId ?? "")?.name ?? d.ownerName ?? "—"}</div>
              <div className="mt-2 flex items-center justify-between text-[0.75rem]">
                <span className="text-muted">{d.expectedCloseAt ? `Close ${fmtDate(d.expectedCloseAt)}` : "No close date"}</span>
                <span className="font-semibold tabular-nums text-ink">{fmtCents(d.valueCents)}</span>
              </div>
            </>
          )}
        />
      )}
      {show && (
        <NewDealModal
          pipeline={pipeline}
          companies={companies.rows}
          onClose={() => setShow(false)}
          onCreated={() => {
            setRows(null);
            deals.reload();
          }}
        />
      )}
    </div>
  );
}

function NewDealModal({ pipeline, companies, onClose, onCreated }: { pipeline: CrmPipeline; companies: CompanyRow[]; onClose: () => void; onCreated: () => void }) {
  const contacts = useOpsList<ContactRow>("contacts");
  const [f, setF] = useState({ title: "", stage: pipeline.stages[0]?.id ?? "", value: "", companyId: "", contactId: "", close: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    const valueCents = f.value.trim() ? toCents(f.value) : 0;
    if (valueCents === null) return setError("Value must be a dollar amount.");
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/deals", "POST", {
        title: f.title.trim(),
        pipelineId: pipeline.id,
        stage: f.stage,
        valueCents,
        ...(f.companyId ? { companyId: f.companyId } : {}),
        ...(f.contactId ? { contactId: f.contactId } : {}),
        ...(f.close ? { expectedCloseAt: new Date(f.close).toISOString() } : {}),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the deal.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title={`New deal in ${pipeline.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Title</span>
          <input className={`${inputCls} w-full`} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Stage</span>
            <select className={`${selectCls} w-full`} value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>
              {pipeline.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Value ($)</span>
            <input className={`${inputCls} w-full`} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} inputMode="decimal" />
          </label>
          <label className="block">
            <span className={labelCls}>Company</span>
            <select className={`${selectCls} w-full`} value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
              <option value="">None</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Contact</span>
            <select className={`${selectCls} w-full`} value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
              <option value="">None</option>
              {contacts.rows.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Expected close</span>
            <input type="date" className={`${inputCls} w-full`} value={f.close} onChange={(e) => setF({ ...f, close: e.target.value })} />
          </label>
        </div>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !f.title.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create deal
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Lead slide-over: convert to contact (+ company, + deal)
// ---------------------------------------------------------------------------

export function ConvertLeadStrip({ leadId, hasValue, onConverted }: { leadId: string; hasValue: boolean; onConverted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function convert(createDeal: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { data } = await opsJson("/api/ops/crm/convert-lead", "POST", { leadId, createDeal });
      const created = data.created as { contact: boolean; company: boolean; deal: boolean };
      const company = data.company as { name?: string } | null;
      setNote(
        created.contact || created.company || created.deal
          ? `Converted: ${created.contact ? "new contact" : "existing contact"}${company ? ` at ${company.name}` : ""}${data.deal ? (created.deal ? ", new deal" : ", existing deal") : ""}.`
          : `Already converted${company ? ` (contact at ${company.name})` : ""}.`,
      );
      onConverted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2.5">
      <UserCheck size={15} className="text-muted" />
      <span className="text-[0.8125rem] text-muted">Customer record</span>
      <button type="button" className={btnGhostSm} disabled={busy} onClick={() => convert(false)}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Contact size={12} />} Convert to contact
      </button>
      {hasValue && (
        <button type="button" className={btnGhostSm} disabled={busy} onClick={() => convert(true)}>
          <Handshake size={12} /> Convert with deal
        </button>
      )}
      {note && <span className={`${noteBoxCls} py-1`}>{note}</span>}
      {error && <span className={`${errorBoxCls} py-1`}>{error}</span>}
    </div>
  );
}
