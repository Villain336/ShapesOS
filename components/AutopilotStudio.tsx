// Marketr — content autopilot studio UI (milestone 18).
// Client island: rules (create/edit, cadence, auto-approve), approval queue
// (preview dialog, approve/reject/publish, bulk), activity (runs), kill switch.
//
// UI language: vault components only (Button, Card, ValuePill, Field,
// EmptyState, TaskRows, shadcn Tabs/Select/Checkbox/Switch/Dialog/Input).
// Phosphor icons only (duotone features, regular chrome).

"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/vault/atoms/Button";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { Field } from "@/components/vault/Field";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import TaskRows, { type TaskRow } from "@/components/vault/primitives/TaskRows";
import { Checkbox } from "@/components/vault/shadcn/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/vault/shadcn/dialog";
import { Input } from "@/components/vault/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";
import { Switch } from "@/components/vault/shadcn/switch";
import {
  TriangleAlert,
  Eye,
  Inbox,
  ListChecks,
  Activity as ActivityIcon,
  LoaderCircle,
  OctagonAlert,
  Pencil,
  Play,
  Plus,
  Trash,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

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

const QUEUE_TONES: Record<string, "neutral" | "green" | "orange" | "red" | "accent"> = {
  pending: "orange",
  approved: "green",
  rejected: "neutral",
  published: "accent",
  killed: "red",
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

function runTaskRow(run: RunRow): TaskRow {
  return {
    key: run.id,
    label: run.rule.name,
    amount: `${run.itemsGenerated} generated`,
    status: run.status === "completed" ? "done" : run.status === "running" ? "running" : "sequence",
    details: [
      { label: "Generated", meta: String(run.itemsGenerated) },
      { label: "Approved", meta: String(run.itemsApproved) },
      { label: "Published", meta: String(run.itemsPublished) },
      { label: "By", meta: run.createdBy ?? "system" },
      ...(run.error ? [{ label: "Error", meta: run.error }] : []),
    ],
  };
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

  const approveItem = (item: QueueItem) =>
    doAction(`approve-${item.id}`, () =>
      api(`/api/autopilot/items/${item.id}/approve`, { method: "POST", body: JSON.stringify({ projectId }) }),
    );

  const rejectItem = (item: QueueItem) => {
    const note = prompt("Rejection note (optional):");
    doAction(`reject-${item.id}`, () =>
      api(`/api/autopilot/items/${item.id}/reject`, { method: "POST", body: JSON.stringify({ projectId, note }) }),
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {killed && (
        <div className="flex items-start gap-2.5 rounded-card bg-red-tint px-4 py-3 text-sm text-red">
          <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Autopilot is <strong>killed</strong>
            {projectKilled && workspaceKilled ? " at project and workspace level" : projectKilled ? " for this project" : " at workspace level"}
            . Runs, approvals, and publishing are frozen. Release the kill switch below to resume (nothing resumes silently).
          </span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2.5 rounded-card bg-red-tint px-4 py-3 text-sm text-red">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button type="button" size="xs" variant="quiet" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div>
        <div className="flex items-end justify-between gap-2 border-b border-line">
          <div className="flex gap-1" role="tablist" aria-label="Autopilot">
            {(
              [
                { id: "queue", label: "Queue", icon: Inbox },
                { id: "rules", label: "Rules", icon: ListChecks },
                { id: "activity", label: "Activity", icon: ActivityIcon },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium capitalize transition-colors ${
                  tab === t.id
                    ? "border-accent text-accent-ink"
                    : "border-transparent text-ink-2 hover:text-ink"
                }`}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>
          <a
            href="#kill-switch"
            className={`mb-2 inline-flex items-center gap-1.5 text-[13px] font-medium ${killed ? "text-red" : "text-ink-3 hover:text-ink-2"}`}
          >
            <OctagonAlert className="h-4 w-4" />
            {killed ? "Kill switch ENGAGED" : "Kill switch"}
          </a>
        </div>

        {tab === "queue" && (
          <div className="pt-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={queueStatus} onValueChange={(v) => { if (v !== null) setQueueStatus(v); }}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["pending", "approved", "rejected", "published", "killed"].map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {canEdit && selected.size > 0 && (
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="accent" onClick={() => bulk("approve")} disabled={!!busy}>
                    Approve {selected.size}
                  </Button>
                  <Button type="button" size="sm" variant="accent" onClick={() => bulk("publish")} disabled={!!busy}>
                    Publish {selected.size}
                  </Button>
                </div>
              )}
              {busy && (
                <span className="inline-flex items-center gap-1.5 text-sm text-ink-3">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Working…
                </span>
              )}
            </div>

            {items.length === 0 ? (
              <EmptyState
                icon={<Inbox className="h-5 w-5" />}
                title={`No ${queueStatus} items`}
                description="Run a rule to generate drafts."
              />
            ) : (
              <div className="flex flex-col gap-2.5">
                {items.map((item) => (
                  <Card key={item.id} className="flex items-start gap-3 px-4 py-3.5">
                    {canEdit && (item.status === "pending" || item.status === "approved") && (
                      <Checkbox
                        checked={selected.has(item.id)}
                        onCheckedChange={() => toggleSelect(item.id)}
                        aria-label={`Select ${item.title}`}
                        className="mt-1"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        <span className="text-[15px] font-medium leading-snug text-ink">{item.title}</span>
                        <ValuePill tone={QUEUE_TONES[item.status] ?? "neutral"}>{item.status}</ValuePill>
                        {item.autoApproved && <ValuePill tone="orange">auto-approved</ValuePill>}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
                        <span>{KIND_LABELS[item.kind] ?? item.kind}</span>
                        <span aria-hidden="true">·</span>
                        <span>{item.rule.name}</span>
                        <span aria-hidden="true">·</span>
                        <span>{new Date(item.createdAt).toLocaleString()}</span>
                      </div>
                      {item.draftMarkdown && (
                        <p className="mt-2 line-clamp-2 max-w-[72ch] text-[13px] leading-relaxed text-ink-2">
                          {item.draftMarkdown.slice(0, 180)}
                          {item.draftMarkdown.length > 180 ? "…" : ""}
                        </p>
                      )}
                      {item.publishedUrl && (
                        <p className="mt-1.5 text-[12px] text-ink-2">→ {item.publishedUrl}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button type="button" size="sm" variant="quiet" onClick={() => setPreview(item)}>
                        <Eye className="h-3.5 w-3.5" /> Preview
                      </Button>
                      {canEdit && item.status === "pending" && (
                        <>
                          <Button type="button" size="sm" variant="accent" onClick={() => approveItem(item)}>
                            Approve
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => rejectItem(item)}>
                            Reject
                          </Button>
                        </>
                      )}
                      {canEdit && item.status === "approved" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="accent"
                          onClick={() => doAction(`publish-${item.id}`, () => api(`/api/autopilot/items/${item.id}/publish`, { method: "POST", body: JSON.stringify({ projectId }) }))}
                        >
                          Publish
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
          </div>
        )}

        {tab === "rules" && (
          <div className="pt-4">
          <div className="flex flex-col gap-4">
            {canEdit && !killed && (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="accent"
                  onClick={() => { setEditing(null); setShowRuleForm(true); }}
                >
                  <Plus className="h-3.5 w-3.5" /> New rule
                </Button>
              </div>
            )}
            {rules.length === 0 ? (
              <EmptyState
                icon={<ListChecks className="h-5 w-5" />}
                title="No autopilot rules yet"
                description="Create one to start generating drafts on a schedule."
                action={
                  canEdit && !killed ? (
                    <Button type="button" size="sm" variant="accent" onClick={() => { setEditing(null); setShowRuleForm(true); }}>
                      <Plus className="h-3.5 w-3.5" /> New rule
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="flex flex-col gap-2">
                {rules.map((rule) => (
                  <Card key={rule.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-ink">
                        {rule.name}
                        {!rule.enabled && <ValuePill tone="neutral" className="ml-2">disabled</ValuePill>}
                      </div>
                      <div className="mt-1 text-xs text-ink-3">
                        {SOURCE_LABELS[rule.source] ?? rule.source} · {rule.cadence} · max {rule.maxItemsPerRun}/run
                        {rule.autoApprove && (
                          <>
                            {" "}·{" "}
                            <ValuePill tone="orange">auto-approve ON</ValuePill>
                          </>
                        )}
                        {rule.lastRunAt && <span> · last run {new Date(rule.lastRunAt).toLocaleString()}</span>}
                        <span> · {rule._count.items} items</span>
                      </div>
                    </div>
                    {canEdit && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="accent"
                          onClick={() => doAction(`run-${rule.id}`, () => api("/api/autopilot/runs", { method: "POST", body: JSON.stringify({ projectId, ruleId: rule.id }) }))}
                          disabled={!!busy || killed || !rule.enabled}
                          title={killed ? "Kill switch is engaged" : "Run this rule now"}
                        >
                          <Play className="h-3.5 w-3.5" /> Run now
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => doAction(`toggle-${rule.id}`, () => api(`/api/autopilot/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ projectId, enabled: !rule.enabled }) }))}
                        >
                          {rule.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="quiet"
                          onClick={() => { setEditing(rule); setShowRuleForm(true); }}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-red"
                          onClick={async () => { if (await confirmAction(`Delete rule "${rule.name}"? Items and history stay.`)) doAction(`del-${rule.id}`, () => api(`/api/autopilot/rules/${rule.id}?projectId=${projectId}`, { method: "DELETE" })); }}
                        >
                          <Trash className="h-3.5 w-3.5" /> Delete
                        </Button>
                      </>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
          </div>
        )}

        {tab === "activity" && (
          <div className="pt-4">
          {runs.length === 0 ? (
            <EmptyState
              icon={<ActivityIcon className="h-5 w-5" />}
              title="No runs yet"
              description="Runs appear here once a rule executes."
            />
          ) : (
            <TaskRows variant="List" rows={runs.map(runTaskRow)} />
          )}
          </div>
        )}
      </div>

      {/* Approval gate: preview dialog */}
      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle>{preview.title}</DialogTitle>
                <DialogDescription>
                  {KIND_LABELS[preview.kind] ?? preview.kind} · {preview.rule.name} · {preview.status}
                  {preview.autoApproved && " · auto-approved"}
                </DialogDescription>
              </DialogHeader>
              {preview.reviewNote && (
                <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
                  <ValuePill tone="orange">Review note</ValuePill>
                  {preview.reviewNote}
                </p>
              )}
              <pre className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{preview.draftMarkdown ?? "(no draft)"}</pre>
              {canEdit && preview.status === "pending" && (
                <DialogFooter>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => { rejectItem(preview); setPreview(null); }}
                  >
                    Reject
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="accent"
                    onClick={() => { approveItem(preview); setPreview(null); }}
                  >
                    Approve
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Rule form dialog */}
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

      {/* Kill switch */}
      <div id="kill-switch" className="scroll-mt-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2 text-red">
              <OctagonAlert className="h-4 w-4" /> Kill switch
            </span>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <p className="text-[13px] text-ink-2">
            Engaging the kill switch immediately stops all scheduled autopilot activity: running runs are marked
            killed and pending/approved items are frozen. Nothing resumes silently — release it explicitly to restart.
            The kill is audit-logged and fires an alert.
          </p>
          <div className="flex flex-col gap-3">
            {canEdit && (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-ink">Project kill switch</div>
                  <div className="text-[12px] text-ink-3">Stops all autopilot activity for this project</div>
                </div>
                <Switch
                  checked={projectKilled}
                  onCheckedChange={(checked) =>
                    checked
                      ? setKillConfirm("project")
                      : doAction("unkill-project", () => api(`/api/autopilot/kill?projectId=${projectId}&scope=project`, { method: "DELETE" }))
                  }
                />
              </div>
            )}
            {isAdmin && (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-ink">Workspace kill switch</div>
                  <div className="text-[12px] text-ink-3">Stops autopilot across the entire workspace</div>
                </div>
                <Switch
                  checked={workspaceKilled}
                  onCheckedChange={(checked) =>
                    checked
                      ? setKillConfirm("workspace")
                      : doAction("unkill-workspace", () => api(`/api/autopilot/kill?projectId=${projectId}&scope=workspace`, { method: "DELETE" }))
                  }
                />
              </div>
            )}
          </div>
        </CardBody>
      </Card>
      </div>

      {/* Kill confirm gate */}
      <Dialog open={!!killConfirm} onOpenChange={(open) => { if (!open) setKillConfirm(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red">
              Confirm: kill autopilot for the {killConfirm === "workspace" ? "ENTIRE WORKSPACE" : "project"}?
            </DialogTitle>
            <DialogDescription>
              Running runs are marked killed and pending/approved items are frozen. The kill is audit-logged.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason (optional)">
            <Input
              value={killReason}
              onChange={(e) => setKillReason(e.target.value)}
              placeholder="Shown in the audit log"
            />
          </Field>
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={() => setKillConfirm(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="accent"
              onClick={() => doAction("kill", async () => {
                await api("/api/autopilot/kill", {
                  method: "POST",
                  body: JSON.stringify({ projectId, scope: killConfirm, reason: killReason || undefined }),
                });
                setKillConfirm(null);
                setKillReason("");
              })}
            >
              Confirm kill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit rule" : "New autopilot rule"}</DialogTitle>
        </DialogHeader>
        {formError && <p className="text-sm text-red">{formError}</p>}
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly decay refresh" />
          </Field>
          <Field label="Content source">
            <Select value={source} onValueChange={(v) => { if (v !== null) setSource(v); }}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SOURCE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {source === "programmatic_template" && (
            <Field label="Programmatic template">
              <Select value={templateId || "none"} onValueChange={(v) => setTemplateId(v === null || v === "none" ? "" : v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select a template…</SelectItem>
                  {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Cadence">
              <Select value={cadence} onValueChange={(v) => { if (v !== null) setCadence(v); }}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual only</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Max items per run">
              <Input type="number" min={1} max={50} value={maxItems} onChange={(e) => setMaxItems(parseInt(e.target.value, 10) || 1)} />
            </Field>
          </div>
          <Field label="Publish target">
            <Select value={targetKind} onValueChange={(v) => { if (v !== null) setTargetKind(v); }}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (queue only)</SelectItem>
                <SelectItem value="wordpress">WordPress</SelectItem>
                <SelectItem value="webflow">Webflow</SelectItem>
                <SelectItem value="marketr-site">ShapesOS site</SelectItem>
                <SelectItem value="csv">CSV export (internal)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {["wordpress", "webflow", "marketr-site"].includes(targetKind) && (
            <Field label="Target site">
              <Select value={siteId || "none"} onValueChange={(v) => setSiteId(v === null || v === "none" ? "" : v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Project default / first site</SelectItem>
                  {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} ({s.sourceType})</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <div className="flex items-start gap-2.5">
            <Switch checked={autoApprove} onCheckedChange={setAutoApprove} className="mt-0.5" />
            <div>
              <div className="text-[13px] font-medium text-ink">Auto-approve without human review</div>
              <div className="text-[12px] text-ink-3">Low-risk decay refreshes only; every auto-approval is audit-logged</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <span className="text-[13px] font-medium text-ink">Enabled</span>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" variant="accent" onClick={save} disabled={saving}>
            {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            {saving ? "Saving…" : editing ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
