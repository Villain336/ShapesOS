// Marketr — content autopilot studio UI (milestone 18).
// Client island: rules (create/edit, cadence, auto-approve), approval queue
// (preview drawer, approve/reject/publish, bulk), activity (runs), kill switch.

"use client";

import { useEffect, useState } from "react";

export interface RuleRow {
  id: string;
  name: string;
  source: string;
  programmaticTemplateId: string | null;
  cadence: string;
  maxItemsPerRun: number;
  autoApprove: boolean;
  publishTarget: { kind?: string; siteId?: string | null } | null;
  enabled: boolean;
  lastRunAt: string | null;
  _count: { items: number };
}

export interface QueueItem {
  id: string;
  runId: string;
  kind: string;
  sourceRef: string;
  title: string;
  draftJson: unknown;
  draftMarkdown: string | null;
  status: string;
  autoApproved: boolean;
  reviewNote: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  rule: { id: string; name: string };
}

export interface RunRow {
  id: string;
  status: string;
  itemsGenerated: number;
  itemsApproved: number;
  itemsPublished: number;
  createdBy: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  rule: { id: string; name: string };
}

export interface KillRow {
  scopeKey: string;
  killed: boolean;
}

interface Props {
  projectId: string;
  canEdit: boolean;
  isAdmin: boolean;
  initialRules: RuleRow[];
  templates: { id: string; name: string }[];
  sites: { id: string; name: string; sourceType: string }[];
  initialKill: KillRow[];
}

const SOURCE_LABELS: Record<string, string> = {
  decay_refresh: "Content decay refreshes",
  programmatic_template: "Programmatic template pages",
  keyword_opportunity: "Keyword opportunities",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-900/40 text-amber-300",
  approved: "bg-emerald-900/40 text-emerald-300",
  rejected: "bg-zinc-700/40 text-zinc-400",
  published: "bg-sky-900/40 text-sky-300",
  killed: "bg-red-900/40 text-red-300",
};

const KIND_LABELS: Record<string, string> = {
  decay_refresh: "Decay refresh",
  programmatic_page: "Programmatic page",
  keyword_brief: "Keyword brief",
};

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export default function AutopilotStudio({ projectId, canEdit, isAdmin, initialRules, templates, sites, initialKill }: Props) {
  const [tab, setTab] = useState<"rules" | "queue" | "activity">("queue");
  const [rules, setRules] = useState<RuleRow[]>(initialRules);
  const [queueStatus, setQueueStatus] = useState("pending");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [kill, setKill] = useState<KillRow[]>(initialKill);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<QueueItem | null>(null);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [editing, setEditing] = useState<RuleRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [killConfirm, setKillConfirm] = useState<"project" | "workspace" | null>(null);
  const [killReason, setKillReason] = useState("");

  const projectKilled = kill.some((k) => k.scopeKey === `project:${projectId}` && k.killed);
  const workspaceKilled = kill.some((k) => !k.scopeKey.startsWith("project:") && k.killed);
  const killed = projectKilled || workspaceKilled;

  async function refresh() {
    try {
      const [r, k] = await Promise.all([
        api(`/api/autopilot/rules?projectId=${projectId}`),
        api(`/api/autopilot/kill?projectId=${projectId}`),
      ]);
      setRules(r.rules);
      const ks: KillRow[] = [];
      if (r.kill) setKill(r.kill);
      if (k) {
        if (k.projectKilled) ks.push({ scopeKey: `project:${projectId}`, killed: true });
        if (k.workspaceKilled) ks.push({ scopeKey: `workspace:kill`, killed: true });
        if (ks.length) setKill(ks);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    }
  }

  async function loadQueue() {
    try {
      const data = await api(`/api/autopilot/queue?projectId=${projectId}&status=${queueStatus}`);
      setItems(data.items);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Queue load failed");
    }
  }

  async function loadRuns() {
    try {
      const data = await api(`/api/autopilot/runs?projectId=${projectId}`);
      setRuns(data.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Runs load failed");
    }
  }

  useEffect(() => {
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStatus]);

  useEffect(() => {
    if (tab === "activity") loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function doAction(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await Promise.all([refresh(), loadQueue(), loadRuns()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  async function bulk(action: "approve" | "publish") {
    const ids = [...selected];
    if (!ids.length) return;
    await doAction(`bulk-${action}`, async () => {
      for (const id of ids) {
        await api(`/api/autopilot/items/${id}/${action}`, {
          method: "POST",
          body: JSON.stringify({ projectId }),
        });
      }
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {killed && (
        <div className="rounded-lg border border-red-700 bg-red-950/50 px-4 py-3 text-sm text-red-200">
          🛑 Autopilot is <strong>killed</strong>
          {projectKilled && workspaceKilled ? " at project and workspace level" : projectKilled ? " for this project" : " at workspace level"}
          . Runs, approvals, and publishing are frozen. Release the kill switch below to resume (nothing resumes silently).
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
          <button className="ml-3 underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="flex gap-2 border-b border-zinc-800">
        {(["queue", "rules", "activity"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize ${tab === t ? "border-b-2 border-zinc-100 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            {t}
          </button>
        ))}
        <div className="ml-auto pb-2">
          <a href="#kill-switch" className={`text-sm font-semibold ${killed ? "text-red-400" : "text-zinc-400 hover:text-zinc-200"}`}>
            {killed ? "🛑 Kill switch ENGAGED" : "Kill switch"}
          </a>
        </div>
      </div>

      {tab === "queue" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={queueStatus}
              onChange={(e) => setQueueStatus(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200"
            >
              {["pending", "approved", "rejected", "published", "killed"].map((s) => (
                <option key={s} value={s} className="capitalize">{s}</option>
              ))}
            </select>
            {canEdit && selected.size > 0 && (
              <div className="flex gap-2">
                <button
                  onClick={() => bulk("approve")}
                  disabled={!!busy}
                  className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  Approve {selected.size}
                </button>
                <button
                  onClick={() => bulk("publish")}
                  disabled={!!busy}
                  className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
                >
                  Publish {selected.size}
                </button>
              </div>
            )}
            {busy && <span className="text-sm text-zinc-500">Working…</span>}
          </div>

          {items.length === 0 && <p className="text-sm text-zinc-500">No {queueStatus} items. Run a rule to generate drafts.</p>}
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                {canEdit && (item.status === "pending" || item.status === "approved") && (
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelect(item.id)} className="h-4 w-4" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-zinc-100">{item.title}</div>
                  <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-zinc-500">
                    <span className={`rounded px-1.5 py-0.5 ${STATUS_COLORS[item.status] ?? ""}`}>{item.status}</span>
                    <span>{KIND_LABELS[item.kind] ?? item.kind}</span>
                    <span>{item.rule.name}</span>
                    {item.autoApproved && <span className="text-amber-400">auto-approved</span>}
                    {item.publishedUrl && <span className="text-sky-400">→ {item.publishedUrl}</span>}
                  </div>
                </div>
                <button onClick={() => setPreview(item)} className="text-sm text-zinc-400 hover:text-zinc-100">Preview</button>
                {canEdit && item.status === "pending" && (
                  <>
                    <button
                      onClick={() => doAction(`approve-${item.id}`, () => api(`/api/autopilot/items/${item.id}/approve`, { method: "POST", body: JSON.stringify({ projectId }) }))}
                      className="rounded-md bg-emerald-700 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-600"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => { const note = prompt("Rejection note (optional):"); doAction(`reject-${item.id}`, () => api(`/api/autopilot/items/${item.id}/reject`, { method: "POST", body: JSON.stringify({ projectId, note }) })); }}
                      className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      Reject
                    </button>
                  </>
                )}
                {canEdit && item.status === "approved" && (
                  <button
                    onClick={() => doAction(`publish-${item.id}`, () => api(`/api/autopilot/items/${item.id}/publish`, { method: "POST", body: JSON.stringify({ projectId }) }))}
                    className="rounded-md bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600"
                  >
                    Publish
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "rules" && (
        <div className="flex flex-col gap-4">
          {canEdit && !killed && (
            <div>
              <button
                onClick={() => { setEditing(null); setShowRuleForm(true); }}
                className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
              >
                + New rule
              </button>
            </div>
          )}
          {rules.length === 0 && <p className="text-sm text-zinc-500">No autopilot rules yet. Create one to start.</p>}
          <div className="flex flex-col gap-2">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                <div className="flex-1">
                  <div className="text-sm font-medium text-zinc-100">
                    {rule.name}
                    {!rule.enabled && <span className="ml-2 text-xs text-zinc-500">(disabled)</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {SOURCE_LABELS[rule.source] ?? rule.source} · {rule.cadence} · max {rule.maxItemsPerRun}/run
                    {rule.autoApprove && <span className="text-amber-400"> · auto-approve ON</span>}
                    {rule.lastRunAt && <span> · last run {new Date(rule.lastRunAt).toLocaleString()}</span>}
                    <span> · {rule._count.items} items</span>
                  </div>
                </div>
                {canEdit && (
                  <>
                    <button
                      onClick={() => doAction(`run-${rule.id}`, () => api("/api/autopilot/runs", { method: "POST", body: JSON.stringify({ projectId, ruleId: rule.id }) }))}
                      disabled={!!busy || killed || !rule.enabled}
                      className="rounded-md bg-zinc-700 px-3 py-1 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-40"
                      title={killed ? "Kill switch is engaged" : "Run this rule now"}
                    >
                      Run now
                    </button>
                    <button
                      onClick={() => doAction(`toggle-${rule.id}`, () => api(`/api/autopilot/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ projectId, enabled: !rule.enabled }) }))}
                      className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:border-zinc-500"
                    >
                      {rule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => { setEditing(rule); setShowRuleForm(true); }}
                      className="text-sm text-zinc-400 hover:text-zinc-100"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => { if (confirm(`Delete rule "${rule.name}"? Items and history stay.`)) doAction(`del-${rule.id}`, () => api(`/api/autopilot/rules/${rule.id}?projectId=${projectId}`, { method: "DELETE" })); }}
                      className="text-sm text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "activity" && (
        <div className="flex flex-col gap-2">
          {runs.length === 0 && <p className="text-sm text-zinc-500">No runs yet.</p>}
          {runs.map((run) => (
            <div key={run.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[run.status] ?? "bg-zinc-700/40 text-zinc-400"}`}>{run.status}</span>
                <span className="text-sm font-medium text-zinc-100">{run.rule.name}</span>
                <span className="ml-auto text-xs text-zinc-500">
                  {new Date(run.startedAt).toLocaleString()} · by {run.createdBy ?? "system"}
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {run.itemsGenerated} generated · {run.itemsApproved} approved · {run.itemsPublished} published
                {run.error && <span className="text-red-400"> · {run.error}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {showRuleForm && (
        <RuleForm
          projectId={projectId}
          templates={templates}
          sites={sites}
          editing={editing}
          onClose={() => { setShowRuleForm(false); setEditing(null); }}
          onSaved={() => { setShowRuleForm(false); setEditing(null); refresh(); }}
        />
      )}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={() => setPreview(null)}>
          <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">{preview.title}</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  {KIND_LABELS[preview.kind]} · {preview.rule.name} · {preview.status}
                  {preview.autoApproved && " · auto-approved"}
                </p>
              </div>
              <button onClick={() => setPreview(null)} className="text-zinc-500 hover:text-zinc-200">✕</button>
            </div>
            {preview.reviewNote && <p className="mt-3 text-sm text-amber-300">Review note: {preview.reviewNote}</p>}
            <pre className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{preview.draftMarkdown ?? "(no draft)"}</pre>
          </div>
        </div>
      )}

      {/* Kill switch */}
      <div id="kill-switch" className="rounded-lg border border-red-900 bg-red-950/20 p-5">
        <h2 className="text-lg font-semibold text-red-300">🛑 Kill switch</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Engaging the kill switch immediately stops all scheduled autopilot activity: running runs are marked
          killed and pending/approved items are frozen. Nothing resumes silently — release it explicitly to restart.
          The kill is audit-logged and fires an alert.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {canEdit && !projectKilled && (
            <button
              onClick={() => setKillConfirm("project")}
              className="rounded-md bg-red-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-red-600"
            >
              KILL AUTOPILOT — this project
            </button>
          )}
          {isAdmin && !workspaceKilled && (
            <button
              onClick={() => setKillConfirm("workspace")}
              className="rounded-md border-2 border-red-600 px-5 py-2 text-sm font-bold text-red-300 hover:bg-red-900/40"
            >
              KILL AUTOPILOT — entire workspace
            </button>
          )}
          {canEdit && projectKilled && (
            <button
              onClick={() => doAction("unkill-project", () => api(`/api/autopilot/kill?projectId=${projectId}&scope=project`, { method: "DELETE" }))}
              className="rounded-md bg-emerald-700 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              Release project kill switch
            </button>
          )}
          {isAdmin && workspaceKilled && (
            <button
              onClick={() => doAction("unkill-workspace", () => api(`/api/autopilot/kill?projectId=${projectId}&scope=workspace`, { method: "DELETE" }))}
              className="rounded-md bg-emerald-700 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              Release workspace kill switch
            </button>
          )}
        </div>
        {killConfirm && (
          <div className="mt-4 rounded-md border border-red-800 bg-red-950/60 p-4">
            <p className="text-sm font-semibold text-red-200">
              Confirm: kill autopilot for the {killConfirm === "workspace" ? "ENTIRE WORKSPACE" : "project"}?
            </p>
            <input
              value={killReason}
              onChange={(e) => setKillReason(e.target.value)}
              placeholder="Reason (optional, shown in the audit log)"
              className="mt-3 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => doAction("kill", async () => {
                  await api("/api/autopilot/kill", {
                    method: "POST",
                    body: JSON.stringify({ projectId, scope: killConfirm, reason: killReason || undefined }),
                  });
                  setKillConfirm(null);
                  setKillReason("");
                })}
                className="rounded-md bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-600"
              >
                Confirm kill
              </button>
              <button onClick={() => setKillConfirm(null)} className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RuleForm({ projectId, templates, sites, editing, onClose, onSaved }: {
  projectId: string;
  templates: { id: string; name: string }[];
  sites: { id: string; name: string; sourceType: string }[];
  editing: RuleRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [source, setSource] = useState(editing?.source ?? "decay_refresh");
  const [templateId, setTemplateId] = useState(editing?.programmaticTemplateId ?? "");
  const [cadence, setCadence] = useState(editing?.cadence ?? "manual");
  const [maxItems, setMaxItems] = useState(editing?.maxItemsPerRun ?? 5);
  const [autoApprove, setAutoApprove] = useState(editing?.autoApprove ?? false);
  const [targetKind, setTargetKind] = useState(editing?.publishTarget?.kind ?? "none");
  const [siteId, setSiteId] = useState(editing?.publishTarget?.siteId ?? "");
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        projectId,
        name,
        source,
        programmaticTemplateId: source === "programmatic_template" ? templateId : undefined,
        cadence,
        maxItemsPerRun: maxItems,
        autoApprove,
        enabled,
        publishTarget: targetKind === "none" ? undefined : { kind: targetKind, siteId: siteId || undefined },
      };
      if (editing) {
        await api(`/api/autopilot/rules/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/api/autopilot/rules", { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-lg border border-zinc-700 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-zinc-100">{editing ? "Edit rule" : "New autopilot rule"}</h2>
        {formError && <p className="mt-2 text-sm text-red-400">{formError}</p>}
        <div className="mt-4 flex flex-col gap-4">
          <label className="text-sm text-zinc-300">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} mt-1`} placeholder="Weekly decay refresh" />
          </label>
          <label className="text-sm text-zinc-300">
            Content source
            <select value={source} onChange={(e) => setSource(e.target.value)} className={`${inputCls} mt-1`}>
              {Object.entries(SOURCE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {source === "programmatic_template" && (
            <label className="text-sm text-zinc-300">
              Programmatic template
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={`${inputCls} mt-1`}>
                <option value="">Select a template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <div className="grid grid-cols-2 gap-4">
            <label className="text-sm text-zinc-300">
              Cadence
              <select value={cadence} onChange={(e) => setCadence(e.target.value)} className={`${inputCls} mt-1`}>
                <option value="manual">Manual only</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="text-sm text-zinc-300">
              Max items per run
              <input type="number" min={1} max={50} value={maxItems} onChange={(e) => setMaxItems(parseInt(e.target.value, 10) || 1)} className={`${inputCls} mt-1`} />
            </label>
          </div>
          <label className="text-sm text-zinc-300">
            Publish target
            <select value={targetKind} onChange={(e) => setTargetKind(e.target.value)} className={`${inputCls} mt-1`}>
              <option value="none">None (queue only)</option>
              <option value="wordpress">WordPress</option>
              <option value="webflow">Webflow</option>
              <option value="marketr-site">Marketr site</option>
              <option value="csv">CSV export (internal)</option>
            </select>
          </label>
          {["wordpress", "webflow", "marketr-site"].includes(targetKind) && (
            <label className="text-sm text-zinc-300">
              Target site
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={`${inputCls} mt-1`}>
                <option value="">Project default / first site</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.sourceType})</option>)}
              </select>
            </label>
          )}
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} className="mt-1 h-4 w-4" />
            <span>
              Auto-approve without human review <span className="text-amber-400">(low-risk decay refreshes only; every auto-approval is audit-logged)</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
            Enabled
          </label>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving} className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50">
              {saving ? "Saving…" : editing ? "Save changes" : "Create rule"}
            </button>
            <button onClick={onClose} className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
