// Marketr — newsletter studio UI (milestone 19).
// Client island: composer (email blocks → live react-email preview),
// templates, lists + CSV import, broadcasts (test/send/schedule), and
// domains + Resend key settings.
//
// Motion language (better-ui + emil-design-eng): press feedback is
// scale(0.96) via active:scale-[0.96] with named transition-property and
// cubic-bezier(0.2,0,0,1); tab content enters with a 150ms ease-out fade
// (occasional interaction); typing/preview updates animate nothing.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  TriangleAlert,
  ChartBar,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Eye,
  FileText,
  Globe,
  Image as ImageIcon,
  Mail,
  Megaphone,
  Minus,
  MousePointerClick,
  RectangleHorizontal,
  Plus,
  Send,
  Trash,
  Type,
  Users,
  PenLine,
  LayoutTemplate,
  Settings,
  type LucideIcon,
} from "lucide-react";
import {
  blockLabel,
  createBlock,
  EMAIL_BLOCK_TYPES,
  type EmailBlockNode,
  type EmailBlockType,
  type EmailTiptapDoc,
} from "@/lib/newsletter/blocks";
import { confirmAction } from "@/lib/ui/feedback";
import { closeOnEscape } from "@/lib/ui/keyboard";

const TemplateEditor = dynamic(() => import("@/components/TemplateEditor"), { ssr: false });

type Tab = "compose" | "templates" | "lists" | "broadcasts" | "domains";

const BLOCK_ICONS: Record<EmailBlockType, typeof Type> = {
  emailHeader: RectangleHorizontal,
  emailHero: Megaphone,
  emailText: Type,
  emailImage: ImageIcon,
  emailButton: MousePointerClick,
  emailDivider: Minus,
  emailFooter: ChartBar,
};

const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-sm font-semibold text-white aos-press " +
  "disabled:bg-disabled disabled:text-disabled-fg disabled:pointer-events-none";
const BTN_GHOST =
  "inline-flex items-center gap-1.5 rounded-full bg-paper px-3.5 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press " +
  "disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none disabled:pointer-events-none";
const BTN_DANGER =
  "inline-flex items-center gap-1.5 rounded-full bg-paper px-3.5 py-1.5 text-sm font-semibold text-failed-text " +
  "shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint " +
  "disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none disabled:pointer-events-none";
const INPUT =
  "w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-subtle " +
  "outline-none focus:border-focus focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] transition-[border-color] duration-150";
const CARD = "rounded-lg bg-paper shadow-hairline";
const LABEL = "mb-1 block text-xs font-medium text-muted";

export interface TemplateRow { id: string; name: string; brandKitId: string | null; isStarter: boolean }
export interface ListRow { id: string; name: string; doubleOptIn: boolean; subscribedCount: number }
export interface DomainRow {
  id: string;
  domain: string;
  status: string;
  dnsRecords: { name: string; type: string; value: string; purpose: string }[];
}
export interface BroadcastRow {
  id: string;
  subject: string;
  status: string;
  scheduledAt: string | null;
  testSentAt: string | null;
  testSentTo: string | null;
  stats: Record<string, unknown>;
  error: string | null;
  list: { id: string; name: string };
  domain: { id: string; domain: string; status: string };
}

interface Props {
  projectId: string;
  workspaceId: string;
  canEdit: boolean;
  initialTemplates: TemplateRow[];
  initialLists: ListRow[];
  initialDomains: DomainRow[];
  initialBroadcasts: BroadcastRow[];
  brandKits: { id: string; name: string }[];
  settingsHint: string | null;
  defaultFromName: string | null;
}

// Send/verify jobs carry status color + shape; subscriber states are plain
// labels (status colors are reserved for job/agent states).
const STATUS_BADGE: Record<string, { cls: string; shape?: string }> = {
  draft: { cls: "bg-canvas text-muted" },
  scheduled: { cls: "bg-paper text-ink shadow-outline", shape: "aos-shape--queued" },
  sending: { cls: "bg-running text-white", shape: "aos-shape--running aos-is-live" },
  sent: { cls: "bg-done text-white", shape: "aos-shape--done" },
  failed: { cls: "bg-failed text-white", shape: "aos-shape--failed" },
  cancelled: { cls: "bg-canvas text-muted" },
  verified: { cls: "bg-done text-white", shape: "aos-shape--done" },
  pending: { cls: "bg-needs text-ink", shape: "aos-shape--needs" },
  subscribed: { cls: "bg-canvas text-ink" },
  unsubscribed: { cls: "bg-canvas text-muted" },
  bounced: { cls: "bg-paper text-muted shadow-control" },
  complained: { cls: "bg-paper text-muted shadow-control" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_BADGE[status] ?? { cls: "bg-canvas text-muted" };
  return (
    <span className={`inline-flex h-badge items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold ${s.cls}`}>
      {s.shape && <span aria-hidden className={`aos-shape ${s.shape}`} style={{ color: "inherit" }} />}
      {status}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Composer: email-block editor + live preview
// ---------------------------------------------------------------------------

function TextInput({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className={INPUT}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function BlockFields({ node, onPatch }: { node: EmailBlockNode; onPatch: (attrs: Record<string, unknown>) => void }) {
  const get = (k: string) => (typeof node.attrs?.[k] === "string" ? (node.attrs[k] as string) : "");
  const set = (k: string) => (v: string) => onPatch({ ...(node.attrs ?? {}), [k]: v });
  switch (node.type) {
    case "emailHeader":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Logo URL"><TextInput value={get("logoUrl")} onChange={set("logoUrl")} placeholder="https://…" /></Field>
          <Field label="Tagline"><TextInput value={get("tagline")} onChange={set("tagline")} placeholder="News from our team" /></Field>
        </div>
      );
    case "emailHero":
      return (
        <div className="grid gap-3">
          <Field label="Headline"><TextInput value={get("title")} onChange={set("title")} /></Field>
          <Field label="Subheadline"><TextInput value={get("subtitle")} onChange={set("subtitle")} /></Field>
          <Field label="Hero image URL"><TextInput value={get("imageUrl")} onChange={set("imageUrl")} placeholder="https://…" /></Field>
        </div>
      );
    case "emailImage":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Image URL"><TextInput value={get("src")} onChange={set("src")} placeholder="https://…" /></Field>
          <Field label="Alt text"><TextInput value={get("alt")} onChange={set("alt")} /></Field>
          <div className="sm:col-span-2"><Field label="Caption"><TextInput value={get("caption")} onChange={set("caption")} /></Field></div>
        </div>
      );
    case "emailButton":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Button label"><TextInput value={get("label")} onChange={set("label")} /></Field>
          <Field label="Link URL"><TextInput value={get("href")} onChange={set("href")} placeholder="https://" /></Field>
        </div>
      );
    case "emailFooter":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name"><TextInput value={get("companyName")} onChange={set("companyName")} /></Field>
          <Field label="Address"><TextInput value={get("address")} onChange={set("address")} /></Field>
        </div>
      );
    case "emailDivider":
      return <p className="text-xs text-muted">A horizontal rule. No settings.</p>;
    case "emailText":
      return null;
  }
}

function Composer({
  projectId, canEdit, brandKits, templates, onSaved, initialDoc, onUseInBroadcast,
}: {
  projectId: string;
  canEdit: boolean;
  brandKits: { id: string; name: string }[];
  templates: TemplateRow[];
  onSaved: () => void;
  initialDoc: () => EmailTiptapDoc | null;
  onUseInBroadcast: (doc: EmailTiptapDoc) => void;
}) {
  const [templateId, setTemplateId] = useState<string>("");
  const [name, setName] = useState("Untitled newsletter");
  const [brandKitId, setBrandKitId] = useState("");
  const [doc, setDoc] = useState<EmailTiptapDoc>({ type: "doc", content: [] });
  const [previewHtml, setPreviewHtml] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadTemplate = useCallback(async (id: string) => {
    setTemplateId(id);
    if (!id) {
      setName("Untitled newsletter");
      setBrandKitId("");
      const d = initialDoc();
      setDoc(d ?? { type: "doc", content: [] });
      return;
    }
    const res = await fetch(`/api/newsletter/templates/${id}?projectId=${projectId}`);
    const data = await res.json();
    if (data.template) {
      setName(data.template.name);
      setBrandKitId(data.template.brandKitId ?? "");
      setDoc(data.template.tiptap);
    }
  }, [projectId, initialDoc]);

  // Debounced live preview (server-side react-email render).
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/newsletter/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, tiptap: doc, brandKitId: brandKitId || undefined }),
        });
        if (res.ok) setPreviewHtml(await res.text());
      } catch { /* preview is best-effort */ }
    }, 600);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [doc, brandKitId, projectId]);

  const updateBlock = (i: number, patch: Partial<EmailBlockNode>) =>
    setDoc((d) => ({ ...d, content: d.content.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  const moveBlock = (i: number, dir: -1 | 1) =>
    setDoc((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.content.length) return d;
      const content = [...d.content];
      [content[i], content[j]] = [content[j], content[i]];
      return { ...d, content };
    });
  const deleteBlock = (i: number) =>
    setDoc((d) => ({ ...d, content: d.content.filter((_, j) => j !== i) }));
  const addBlock = (type: EmailBlockType) =>
    setDoc((d) => ({ ...d, content: [...d.content, createBlock(type)] }));

  const save = async () => {
    if (!doc.content.length) { setNotice("Add at least one block first."); return; }
    setSaving(true);
    setNotice(null);
    try {
      const payload = { projectId, name, tiptap: doc, brandKitId: brandKitId || null };
      const res = await fetch(
        templateId ? `/api/newsletter/templates/${templateId}` : "/api/newsletter/templates",
        {
          method: templateId ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      if (!templateId && data.id) setTemplateId(data.id);
      setNotice("Saved.");
      onSaved();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className={`${CARD} p-5`}>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label="Template">
            <select className={INPUT} value={templateId} onChange={(e) => loadTemplate(e.target.value)}>
              <option value="">New template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.isStarter ? " (starter)" : ""}</option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <TextInput value={name} onChange={setName} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Brand kit">
              <select className={INPUT} value={brandKitId} onChange={(e) => setBrandKitId(e.target.value)}>
                <option value="">Default styling</option>
                {brandKits.map((k) => (
                  <option key={k.id} value={k.id}>{k.name}</option>
                ))}
              </select>
            </Field>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {doc.content.map((node, i) => {
            const Icon = BLOCK_ICONS[node.type];
            return (
              <div key={i} className="rounded-md border border-line bg-canvas p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Icon size={15} className="text-muted" />
                  <span className="text-sm font-medium text-ink">{blockLabel(node.type)}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <button className="rounded-full p-1 text-muted transition-colors duration-150 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => moveBlock(i, -1)} aria-label="Move up">
                      <ChevronUp size={15} />
                    </button>
                    <button className="rounded-full p-1 text-muted transition-colors duration-150 hover:text-ink disabled:opacity-30" disabled={i === doc.content.length - 1} onClick={() => moveBlock(i, 1)} aria-label="Move down">
                      <ChevronDown size={15} />
                    </button>
                    <button className="rounded-full p-1 text-muted transition-colors duration-150 hover:text-failed-text" onClick={() => deleteBlock(i)} aria-label="Delete block">
                      <Trash size={15} />
                    </button>
                  </span>
                </div>
                {node.type === "emailText" ? (
                  <TemplateEditor
                    initialContent={{ type: "doc", content: node.content ?? [] }}
                    onChange={(json) => {
                      const c = (json as { content?: unknown[] })?.content;
                      updateBlock(i, { content: Array.isArray(c) ? c : [] });
                    }}
                  />
                ) : (
                  <BlockFields node={node} onPatch={(attrs) => updateBlock(i, { attrs })} />
                )}
              </div>
            );
          })}
          {doc.content.length === 0 && (
            <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
              No blocks yet — add your first block below.
            </p>
          )}
        </div>

        <div className="mt-4">
          <p className={LABEL}>Add block</p>
          <div className="flex flex-wrap gap-2">
            {EMAIL_BLOCK_TYPES.map((t) => {
              const Icon = BLOCK_ICONS[t];
              return (
                <button key={t} className={BTN_GHOST} onClick={() => addBlock(t)} disabled={!canEdit}>
                  <Icon size={14} />
                  {blockLabel(t)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button className={BTN_PRIMARY} onClick={save} disabled={!canEdit || saving}>
            <Check size={14} />
            {saving ? "Saving…" : templateId ? "Save template" : "Save as template"}
          </button>
          <button className={BTN_GHOST} onClick={() => onUseInBroadcast(doc)} disabled={!doc.content.length}>
            <Send size={14} />
            Use in broadcast
          </button>
          {notice && <span className="text-sm text-muted">{notice}</span>}
        </div>
      </div>

      <div className={`${CARD} overflow-hidden`}>
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Eye size={15} className="text-muted" />
          <span className="text-sm font-medium text-ink">Live preview</span>
          <span className="ml-auto text-xs text-muted">Rendered server-side with react-email</span>
        </div>
        {previewHtml ? (
          <iframe title="Newsletter preview" srcDoc={previewHtml} className="h-[720px] w-full bg-paper" sandbox="" />
        ) : (
          <div className="flex h-[720px] items-center justify-center text-sm text-muted">Rendering preview…</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Templates tab
// ---------------------------------------------------------------------------

function TemplatesTab({
  projectId, canEdit, templates, onRefresh,
}: { projectId: string; canEdit: boolean; templates: TemplateRow[]; onRefresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const seed = async () => {
    setBusy("seed");
    const res = await fetch("/api/newsletter/templates/seed", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    setNotice(res.ok ? `Seeded ${data.seeded} starter templates.` : (data.error ?? "Seed failed."));
    setBusy(null);
    onRefresh();
  };
  const duplicate = async (id: string) => {
    setBusy(id);
    const res = await fetch(`/api/newsletter/templates/${id}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    setNotice(res.ok ? "Duplicated." : (data.error ?? "Failed."));
    setBusy(null);
    onRefresh();
  };
  const remove = async (id: string, name: string) => {
    if (!await confirmAction(`Delete template "${name}"?`)) return;
    setBusy(id);
    const res = await fetch(`/api/newsletter/templates/${id}?projectId=${projectId}`, { method: "DELETE" });
    setNotice(res.ok ? "Deleted." : "Failed.");
    setBusy(null);
    onRefresh();
  };

  return (
    <div className={CARD}>
      <div className="flex items-center border-b border-line px-5 py-3">
        <span className="text-sm font-medium text-ink">Templates</span>
        <button className={`${BTN_GHOST} ml-auto`} onClick={seed} disabled={!canEdit || busy === "seed"}>
          <Plus size={14} /> Seed starters
        </button>
      </div>
      {notice && <p className="border-b border-line px-5 py-2 text-sm text-muted">{notice}</p>}
      <ul className="divide-y divide-line">
        {templates.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-5 py-3">
            <FileText size={16} className="text-muted" />
            <span className="text-sm text-ink">{t.name}</span>
            {t.isStarter && <span className="rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">starter</span>}
            <span className="ml-auto flex gap-2">
              <button className={BTN_GHOST} onClick={() => duplicate(t.id)} disabled={!canEdit || busy === t.id}>
                Duplicate
              </button>
              <button className={BTN_DANGER} onClick={() => remove(t.id, t.name)} disabled={!canEdit || busy === t.id} aria-label={`Delete template ${t.name}`}>
                <Trash size={14} aria-hidden />
              </button>
            </span>
          </li>
        ))}
        {templates.length === 0 && (
          <li className="px-5 py-8 text-center text-sm text-muted">No templates yet — seed the starters to begin.</li>
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lists tab
// ---------------------------------------------------------------------------

function ListsTab({
  projectId, canEdit, lists, onRefresh,
}: { projectId: string; canEdit: boolean; lists: ListRow[]; onRefresh: () => void }) {
  const [name, setName] = useState("");
  const [doubleOptIn, setDoubleOptIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openList, setOpenList] = useState<string | null>(null);
  const [subs, setSubs] = useState<{ email: string; name: string | null; status: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const create = async () => {
    if (!name.trim()) { setNotice("Give the list a name."); return; }
    const res = await fetch("/api/newsletter/lists", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, name: name.trim(), doubleOptIn }),
    });
    const data = await res.json();
    setNotice(res.ok ? "List created." : (data.error ?? "Failed."));
    setName("");
    onRefresh();
  };

  const openSubs = async (id: string) => {
    if (openList === id) { setOpenList(null); return; }
    setOpenList(id);
    const res = await fetch(`/api/newsletter/lists/${id}/subscribers?projectId=${projectId}&take=200`);
    const data = await res.json();
    setSubs(data.subscribers ?? []);
  };

  const importCsv = async (id: string, file: File) => {
    setImporting(id);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/newsletter/lists/${id}/import?projectId=${projectId}`, { method: "POST", body: form });
    const data = await res.json();
    setNotice(res.ok
      ? `Imported ${data.imported} subscribers (${data.errors} errors, ${data.duplicates} duplicates skipped).`
      : (data.error ?? "Import failed."));
    setImporting(null);
    onRefresh();
    if (openList === id) openSubs(id);
  };

  const filtered = subs.filter((s) =>
    !filter || s.email.toLowerCase().includes(filter.toLowerCase()) ||
    (s.name ?? "").toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className={`${CARD} h-fit p-5`}>
        <h3 className="mb-3 text-sm font-medium text-ink">New list</h3>
        <div className="grid gap-3">
          <Field label="Name"><TextInput value={name} onChange={setName} placeholder="Weekly readers" /></Field>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="h-4 w-4 accent-ink" checked={doubleOptIn} onChange={(e) => setDoubleOptIn(e.target.checked)} />
            Double opt-in
          </label>
          <button className={BTN_PRIMARY} onClick={create} disabled={!canEdit}>
            <Plus size={14} /> Create list
          </button>
          {notice && <p className="text-sm text-muted">{notice}</p>}
        </div>
      </div>
      <div className={`${CARD} lg:col-span-2`}>
        <div className="border-b border-line px-5 py-3 text-sm font-medium text-ink">Lists</div>
        <ul className="divide-y divide-line">
          {lists.map((l) => (
            <li key={l.id}>
              <div className="flex items-center gap-3 px-5 py-3">
                <Users size={16} className="text-muted" />
                <span className="text-sm text-ink">{l.name}</span>
                {l.doubleOptIn && <span className="rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">double opt-in</span>}
                <span className="text-xs text-muted">{l.subscribedCount} subscribed</span>
                <span className="ml-auto flex gap-2">
                  <button
                    className={BTN_GHOST}
                    onClick={() => { setImportTarget(l.id); fileRef.current?.click(); }}
                    disabled={!canEdit || importing === l.id}
                  >
                    {importing === l.id ? "Importing…" : "Import CSV"}
                  </button>
                  <button className={BTN_GHOST} onClick={() => openSubs(l.id)}>
                    {openList === l.id ? "Hide" : "Subscribers"}
                  </button>
                </span>
              </div>
              {openList === l.id && (
                <div className="border-t border-line px-5 py-3">
                  <input className={`${INPUT} mb-3 max-w-xs`} placeholder="Search subscribers…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                  <div className="max-h-64 overflow-auto rounded-lg border border-line">
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-line">
                        {filtered.map((s) => (
                          <tr key={s.email}>
                            <td className="px-3 py-1.5 text-ink">{s.email}</td>
                            <td className="px-3 py-1.5 text-muted">{s.name ?? "—"}</td>
                            <td className="px-3 py-1.5 text-right"><StatusBadge status={s.status} /></td>
                          </tr>
                        ))}
                        {filtered.length === 0 && (
                          <tr><td className="px-3 py-4 text-center text-muted">No subscribers yet.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </li>
          ))}
          {lists.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-muted">No lists yet — create one to start collecting subscribers.</li>
          )}
        </ul>
        <input
          ref={fileRef}
          type="file" accept=".csv" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && importTarget) importCsv(importTarget, f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Broadcasts tab
// ---------------------------------------------------------------------------

function BroadcastsTab({
  projectId, canEdit, broadcasts, templates, lists, domains, composerDoc, onRefresh,
}: {
  projectId: string;
  canEdit: boolean;
  broadcasts: BroadcastRow[];
  templates: TemplateRow[];
  lists: ListRow[];
  domains: DomainRow[];
  composerDoc: EmailTiptapDoc | null;
  onRefresh: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [listId, setListId] = useState("");
  const [domainId, setDomainId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [useComposer, setUseComposer] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [testFor, setTestFor] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const verifiedDomains = domains.filter((d) => d.status === "verified");

  const create = async () => {
    if (!subject.trim() || !listId || !domainId) { setNotice("Subject, list, and domain are required."); return; }
    if (!useComposer && !templateId) { setNotice("Pick a template or use the composer content."); return; }
    if (useComposer && !composerDoc?.content.length) { setNotice("The composer is empty."); return; }
    setBusy("create");
    const res = await fetch("/api/newsletter/broadcasts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId, subject: subject.trim(), listId, domainId,
        templateId: useComposer ? undefined : templateId,
        tiptap: useComposer ? composerDoc : undefined,
        scheduledAt: scheduledAt || undefined,
      }),
    });
    const data = await res.json();
    setNotice(res.ok ? "Broadcast created." : (data.error ?? "Failed."));
    if (res.ok) { setSubject(""); setScheduledAt(""); }
    setBusy(null);
    onRefresh();
  };

  const previewBroadcast = async (id: string) => {
    const res = await fetch(`/api/newsletter/broadcasts/${id}/preview?projectId=${projectId}`);
    if (res.ok) setPreview(await res.text());
  };
  const testSend = async (id: string) => {
    if (!testEmail.trim()) { setNotice("Enter a test email address."); return; }
    setBusy(`test-${id}`);
    const res = await fetch(`/api/newsletter/broadcasts/${id}/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, to: testEmail.trim() }),
    });
    const data = await res.json();
    setNotice(res.ok ? `Test sent to ${testEmail.trim()}.` : (data.error ?? "Test send failed."));
    setBusy(null);
    setTestFor(null);
    onRefresh();
  };
  const sendNow = async (id: string) => {
    if (!await confirmAction("Send this broadcast now?")) return;
    setBusy(`send-${id}`);
    const res = await fetch(`/api/newsletter/broadcasts/${id}/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    setNotice(res.ok ? `Sent to ${data.sent} subscriber${data.sent === 1 ? "" : "s"}.` : (data.error ?? "Send failed."));
    setBusy(null);
    onRefresh();
  };
  const cancel = async (id: string) => {
    if (!await confirmAction("Cancel this scheduled broadcast?")) return;
    const res = await fetch(`/api/newsletter/broadcasts/${id}?projectId=${projectId}`, { method: "DELETE" });
    setNotice(res.ok ? "Cancelled." : "Failed.");
    onRefresh();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className={`${CARD} h-fit p-5`}>
        <h3 className="mb-3 text-sm font-medium text-ink">New broadcast</h3>
        <div className="grid gap-3">
          <Field label="Subject"><TextInput value={subject} onChange={setSubject} placeholder="This week's updates" /></Field>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="h-4 w-4 accent-ink" checked={useComposer} onChange={(e) => setUseComposer(e.target.checked)} />
            Use current composer content
          </label>
          {!useComposer && (
            <Field label="Template">
              <select className={INPUT} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Select…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="List">
            <select className={INPUT} value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Select…</option>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.subscribedCount})</option>)}
            </select>
          </Field>
          <Field label="Sending domain">
            <select className={INPUT} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              <option value="">Select…</option>
              {verifiedDomains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
            </select>
          </Field>
          {domains.length > 0 && verifiedDomains.length === 0 && (
            <p className="flex items-start gap-1.5 text-xs text-ink">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              No verified domains yet — add and verify one in the Domains tab before sending.
            </p>
          )}
          <Field label="Schedule for (optional)">
            <input type="datetime-local" className={INPUT} value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </Field>
          <button className={BTN_PRIMARY} onClick={create} disabled={!canEdit || busy === "create"}>
            <Plus size={14} /> {scheduledAt ? "Schedule broadcast" : "Create draft"}
          </button>
          {notice && <p className="text-sm text-muted">{notice}</p>}
        </div>
      </div>

      <div className={`${CARD} lg:col-span-2`}>
        <div className="border-b border-line px-5 py-3 text-sm font-medium text-ink">Broadcasts</div>
        <ul className="divide-y divide-line">
          {broadcasts.map((b) => (
            <li key={b.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{b.subject}</span>
                <StatusBadge status={b.status} />
                <span className="text-xs text-muted">{b.list.name} · {b.domain.domain}</span>
                {b.testSentAt && <span className="inline-flex items-center gap-1 text-xs text-muted"><Check size={12} /> test sent</span>}
                {b.scheduledAt && <span className="inline-flex items-center gap-1 text-xs text-muted"><Clock size={12} /> {new Date(b.scheduledAt).toLocaleString()}</span>}
                <span className="ml-auto flex flex-wrap gap-2">
                  <button className={BTN_GHOST} onClick={() => previewBroadcast(b.id)}>
                    <Eye size={14} /> Preview
                  </button>
                  {canEdit && ["draft", "scheduled"].includes(b.status) && (
                    <>
                      <button className={BTN_GHOST} onClick={() => setTestFor(b.id)} disabled={busy === `test-${b.id}`}>
                        Test
                      </button>
                      <button className={BTN_PRIMARY} onClick={() => sendNow(b.id)} disabled={busy === `send-${b.id}`}>
                        <Send size={14} /> Send now
                      </button>
                      {b.status === "scheduled" && (
                        <button className={BTN_DANGER} onClick={() => cancel(b.id)}>Cancel</button>
                      )}
                    </>
                  )}
                </span>
              </div>
              {b.error && <p className="mt-1 text-xs text-failed-text">{b.error}</p>}
              {testFor === b.id && (
                <div className="mt-2 flex gap-2">
                  <input className={`${INPUT} max-w-xs`} placeholder="you@company.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
                  <button className={BTN_PRIMARY} onClick={() => testSend(b.id)} disabled={busy === `test-${b.id}`}>
                    {busy === `test-${b.id}` ? "Sending…" : "Send test"}
                  </button>
                </div>
              )}
            </li>
          ))}
          {broadcasts.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-muted">No broadcasts yet.</li>
          )}
        </ul>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation" onClick={() => setPreview(null)} onKeyDown={closeOnEscape(() => setPreview(null))}>
          <div
            className="h-[85vh] w-full max-w-3xl overflow-hidden rounded-lg bg-paper shadow-overlay"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "nl-pop 200ms cubic-bezier(0.2,0,0,1)", transformOrigin: "center" }}
          >
            <div className="flex items-center border-b border-line bg-canvas px-4 py-2">
              <span className="text-sm font-medium text-muted">Broadcast preview</span>
              <button className="ml-auto rounded-lg px-2 py-1 text-sm text-muted hover:bg-hover" onClick={() => setPreview(null)}>Close</button>
            </div>
            <iframe title="Broadcast preview" srcDoc={preview} className="h-full w-full" sandbox="" />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Domains & settings tab
// ---------------------------------------------------------------------------

function DomainsTab({
  workspaceId, canEdit, domains, settingsHint, defaultFromName, onRefresh,
}: {
  workspaceId: string;
  canEdit: boolean;
  domains: DomainRow[];
  settingsHint: string | null;
  defaultFromName: string | null;
  onRefresh: () => void;
}) {
  const [key, setKey] = useState("");
  const [fromName, setFromName] = useState(defaultFromName ?? "");
  const [newDomain, setNewDomain] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const saveSettings = async () => {
    setBusy("settings");
    setNotice(null);
    try {
      if (key.trim()) {
        const kr = await fetch("/api/newsletter/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, apiKey: key.trim() }),
        });
        const kd = await kr.json();
        if (!kr.ok) throw new Error(kd.error ?? "Key save failed.");
      }
      const fr = await fetch("/api/newsletter/settings", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, defaultFromName: fromName.trim() || null }),
      });
      const fd = await fr.json();
      if (!fr.ok) throw new Error(fd.error ?? "Settings save failed.");
      setNotice("Settings saved.");
      setKey("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(null);
    }
    onRefresh();
  };

  const addDomain = async () => {
    if (!newDomain.trim()) { setNotice("Enter a domain."); return; }
    setBusy("add");
    const res = await fetch("/api/newsletter/domains", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, domain: newDomain.trim() }),
    });
    const data = await res.json();
    setNotice(res.ok ? "Domain added — add the DNS records below, then verify." : (data.error ?? "Failed."));
    setNewDomain("");
    setBusy(null);
    onRefresh();
  };

  const verify = async (id: string) => {
    setBusy(id);
    const res = await fetch(`/api/newsletter/domains/${id}?workspaceId=${workspaceId}`, { method: "POST" });
    const data = await res.json();
    setNotice(res.ok ? `Verification result: ${data.status}.` : (data.error ?? "Failed."));
    setBusy(null);
    onRefresh();
  };
  const remove = async (id: string, domain: string) => {
    if (!await confirmAction(`Remove domain ${domain}?`)) return;
    const res = await fetch(`/api/newsletter/domains/${id}?workspaceId=${workspaceId}`, { method: "DELETE" });
    setNotice(res.ok ? "Domain removed." : "Failed.");
    onRefresh();
  };

  const copy = async (text: string, id: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
    setCopied(id);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className={`${CARD} h-fit p-5`}>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-ink">
          <Mail size={15} /> Sending settings
        </h3>
        <div className="grid gap-3">
          <Field label={settingsHint ? `Resend API key (saved: ${settingsHint})` : "Resend API key"}>
            <input type="password" className={INPUT} value={key} onChange={(e) => setKey(e.target.value)} placeholder="re_…" autoComplete="off" />
          </Field>
          <Field label="Default from name">
            <TextInput value={fromName} onChange={setFromName} placeholder="Acme News" />
          </Field>
          <button className={BTN_PRIMARY} onClick={saveSettings} disabled={!canEdit || busy === "settings"}>
            <Check size={14} /> Save settings
          </button>
          <p className="text-xs text-muted">
            Bring your own Resend key — it is stored encrypted. Webhook events update subscriber
            bounces and complaints automatically.
          </p>
          <hr className="border-line" />
          <Field label="Add sending domain">
            <div className="flex gap-2">
              <TextInput value={newDomain} onChange={setNewDomain} placeholder="news.example.com" />
              <button className={BTN_PRIMARY} onClick={addDomain} disabled={!canEdit || busy === "add"}>
                <Plus size={14} /> Add
              </button>
            </div>
          </Field>
          {notice && <p className="text-sm text-muted">{notice}</p>}
        </div>
      </div>

      <div className="lg:col-span-2 flex flex-col gap-4">
        {domains.map((d) => (
          <div key={d.id} className={`${CARD} p-5`}>
            <div className="mb-3 flex items-center gap-3">
              <Globe size={16} className="text-muted" />
              <span className="text-sm font-medium text-ink">{d.domain}</span>
              <StatusBadge status={d.status} />
              <span className="ml-auto flex gap-2">
                <button className={BTN_GHOST} onClick={() => verify(d.id)} disabled={!canEdit || busy === d.id}>
                  {busy === d.id ? "Verifying…" : "Verify now"}
                </button>
                <button className={BTN_DANGER} onClick={() => remove(d.id, d.domain)} disabled={!canEdit} aria-label={`Remove domain ${d.domain}`}>
                  <Trash size={14} aria-hidden />
                </button>
              </span>
            </div>
            <p className="mb-2 text-xs text-muted">Add these DNS records at your DNS provider, then verify:</p>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-canvas text-left text-muted">
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Value</th>
                    <th className="px-3 py-2 font-medium">Purpose</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.dnsRecords.map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 font-mono text-muted">{r.type}</td>
                      <td className="px-3 py-2 font-mono text-muted">{r.name}</td>
                      <td className="max-w-[280px] truncate px-3 py-2 font-mono text-muted" title={r.value}>{r.value}</td>
                      <td className="px-3 py-2 text-muted">{r.purpose === "dmarc-note" ? "DMARC" : r.purpose.toUpperCase()}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="rounded-full p-1 text-muted transition-colors duration-150 hover:text-ink"
                          onClick={() => copy(r.value, `${d.id}-${i}`)}
                          aria-label="Copy record value"
                        >
                          {copied === `${d.id}-${i}` ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {domains.length === 0 && (
          <div className={`${CARD} p-8 text-center text-sm text-muted`}>
            No sending domains yet. Add one to start — broadcasts require a verified domain.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Studio shell
// ---------------------------------------------------------------------------

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "compose", label: "Compose", icon: PenLine },
  { id: "templates", label: "Templates", icon: LayoutTemplate },
  { id: "lists", label: "Lists", icon: Users },
  { id: "broadcasts", label: "Broadcasts", icon: Send },
  { id: "domains", label: "Domains & settings", icon: Settings },
];

export default function NewsletterStudio(props: Props) {
  const [tab, setTab] = useState<Tab>("compose");
  const [templates, setTemplates] = useState(props.initialTemplates);
  const [lists, setLists] = useState(props.initialLists);
  const [domains, setDomains] = useState(props.initialDomains);
  const [broadcasts, setBroadcasts] = useState(props.initialBroadcasts);
  const [settingsHint, setSettingsHint] = useState(props.settingsHint);
  const [fromName, setFromName] = useState(props.defaultFromName);
  const [composerDoc, setComposerDoc] = useState<EmailTiptapDoc | null>(null);

  const refresh = useCallback(async () => {
    const q = `?projectId=${props.projectId}`;
    const wq = `?workspaceId=${props.workspaceId}`;
    const [t, l, d, b, s] = await Promise.all([
      fetch(`/api/newsletter/templates${q}`).then((r) => r.json()),
      fetch(`/api/newsletter/lists${q}`).then((r) => r.json()),
      fetch(`/api/newsletter/domains${wq}`).then((r) => r.json()),
      fetch(`/api/newsletter/broadcasts${q}`).then((r) => r.json()),
      fetch(`/api/newsletter/settings${wq}`).then((r) => r.json()),
    ]);
    if (t.templates) setTemplates(t.templates);
    if (l.lists) setLists(l.lists);
    if (d.domains) setDomains(d.domains);
    if (b.broadcasts) setBroadcasts(b.broadcasts);
    if (s.resendKeyHint !== undefined) setSettingsHint(s.resendKeyHint);
    if (s.defaultFromName !== undefined) setFromName(s.defaultFromName);
  }, [props.projectId, props.workspaceId]);

  const tabContent = useMemo(() => {
    switch (tab) {
      case "compose":
        return (
          <Composer
            projectId={props.projectId}
            canEdit={props.canEdit}
            brandKits={props.brandKits}
            templates={templates}
            onSaved={refresh}
            initialDoc={() => composerDoc}
            onUseInBroadcast={(doc) => { setComposerDoc(doc); setTab("broadcasts"); }}
          />
        );
      case "templates":
        return <TemplatesTab projectId={props.projectId} canEdit={props.canEdit} templates={templates} onRefresh={refresh} />;
      case "lists":
        return <ListsTab projectId={props.projectId} canEdit={props.canEdit} lists={lists} onRefresh={refresh} />;
      case "broadcasts":
        return (
          <BroadcastsTab
            projectId={props.projectId}
            canEdit={props.canEdit}
            broadcasts={broadcasts}
            templates={templates}
            lists={lists}
            domains={domains}
            composerDoc={composerDoc}
            onRefresh={refresh}
          />
        );
      case "domains":
        return (
          <DomainsTab
            workspaceId={props.workspaceId}
            canEdit={props.canEdit}
            domains={domains}
            settingsHint={settingsHint}
            defaultFromName={fromName}
            onRefresh={refresh}
          />
        );
    }
  }, [tab, props, templates, lists, domains, broadcasts, settingsHint, fromName, composerDoc, refresh]);

  return (
    <div>
      <style>{`@keyframes nl-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes nl-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }`}</style>
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition-colors ${
              tab === t.id
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </div>
      <div key={tab} style={{ animation: "nl-fade 150ms cubic-bezier(0.2,0,0,1)" }}>
        {tabContent}
      </div>
    </div>
  );
}
