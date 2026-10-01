// Marketr — alert hub management UI (milestone 13).
// Client component: channels tab (admin+ for writes) + rules tab (editor+).
// Channel secrets are password fields; leaving them blank on edit keeps the
// stored secret. Secrets are never rendered back from the server.

"use client";

import { useState } from "react";
import { BellRing, Radio } from "lucide-react";

interface AlertChannel {
  id: string;
  name: string;
  type: "slack" | "telegram" | "email";
  hint: string;
  enabled: boolean;
  ruleCount: number;
}

interface RuleChannel {
  id: string;
  name: string;
  type: string;
  hint: string;
  enabled: boolean;
}

interface AlertRule {
  id: string;
  name: string;
  trigger: string;
  triggerLabel: string;
  conditions: Record<string, unknown>;
  cooldownSec: number;
  digest: string;
  quietHours: { start: string; end: string } | null;
  enabled: boolean;
  lastFiredAt: string | null;
  channels: RuleChannel[];
  eventCount: number;
}

interface Trigger {
  key: string;
  label: string;
  description: string;
  conditionKeys: string[];
  live: boolean;
}

interface Project {
  id: string;
  name: string;
}

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const inputCls =
  "w-full h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

// Spec switch (44x26 pill track, white 20px knob) with a visible label.
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors ${
          checked ? "bg-ink" : "bg-disabled-fg"
        }`}
      >
        <span
          className={`absolute top-[3px] h-5 w-5 rounded-full bg-white transition-all ${
            checked ? "left-[21px]" : "left-[3px]"
          }`}
        />
      </button>
      {label}
    </label>
  );
}

// Multi-select chip (black/white, aria-pressed).
function MultiChip({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`rounded-full px-3 py-1.5 text-sm font-medium aos-press ${
        pressed
          ? "bg-ink text-white"
          : "bg-paper text-muted shadow-outline hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

const TYPE_LABELS: Record<string, string> = { slack: "Slack", telegram: "Telegram", email: "Email" };

// ---------------------------------------------------------------- helpers

function fmtCooldown(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

// ---------------------------------------------------------------- channels

function ChannelForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: (AlertChannel & { type: "slack" | "telegram" | "email" }) | null;
  onSaved: (c: AlertChannel) => void;
  onCancel: () => void;
}) {
  const editing = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<"slack" | "telegram" | "email">(initial?.type ?? "slack");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    // Blank secret fields on edit = keep the stored secret.
    const config: Record<string, string> = {};
    if (type === "slack") {
      if (webhookUrl.trim() || !editing) config.webhookUrl = webhookUrl.trim();
    } else if (type === "telegram") {
      if (botToken.trim()) config.botToken = botToken.trim();
      if (chatId.trim()) config.chatId = chatId.trim();
      if (!editing && (!config.botToken || !config.chatId)) {
        setError("Bot token and chat ID are required");
        return;
      }
    } else {
      if (to.trim()) config.to = to.trim();
      if (cc.trim()) config.cc = cc.trim();
      if (!editing && !config.to) {
        setError("Recipient address is required");
        return;
      }
    }
    setSaving(true);
    try {
      const url = editing ? `/api/alert-channels/${initial.id}` : "/api/alert-channels";
      const body: Record<string, unknown> = { name: name.trim(), enabled };
      if (!editing) body.type = type;
      // Only send config when the user touched a secret field (edit), or always (create).
      if (!editing || Object.keys(config).length > 0) body.config = config;
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Save failed");
        return;
      }
      onSaved(json.channel);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      <h3 className="mb-3 text-sm font-semibold">{editing ? "Edit channel" : "New channel"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. #seo-alerts" />
        </div>
        <div>
          <label className={labelCls}>Type</label>
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as typeof type)} disabled={editing}>
            <option value="slack">Slack (incoming webhook)</option>
            <option value="telegram">Telegram (bot)</option>
            <option value="email">Email (SMTP)</option>
          </select>
        </div>
        {type === "slack" && (
          <div className="sm:col-span-2">
            <label className={labelCls}>Webhook URL {editing && "(blank = keep existing)"}</label>
            <input
              type="password"
              className={inputCls}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              autoComplete="new-password"
            />
          </div>
        )}
        {type === "telegram" && (
          <>
            <div>
              <label className={labelCls}>Bot token {editing && "(blank = keep)"}</label>
              <input
                type="password"
                className={inputCls}
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456:ABC-DEF…"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className={labelCls}>Chat ID {editing && "(blank = keep)"}</label>
              <input className={inputCls} value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" />
            </div>
          </>
        )}
        {type === "email" && (
          <>
            <div>
              <label className={labelCls}>To {editing && "(blank = keep)"}</label>
              <input className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} placeholder="ops@agency.com" />
            </div>
            <div>
              <label className={labelCls}>CC (optional)</label>
              <input className={inputCls} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="" />
            </div>
          </>
        )}
        <div className="flex items-end">
          <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button className={btnPrimary} onClick={save} disabled={saving}>
          {saving ? "Saving…" : editing ? "Save changes" : "Create channel"}
        </button>
        <button className={btnGhost} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- rules

function RuleForm({
  initial,
  channels,
  triggers,
  projects,
  onSaved,
  onCancel,
}: {
  initial: AlertRule | null;
  channels: AlertChannel[];
  triggers: Trigger[];
  projects: Project[];
  onSaved: (r: AlertRule) => void;
  onCancel: () => void;
}) {
  const editing = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger ?? "rank_drop");
  const [channelIds, setChannelIds] = useState<string[]>(initial?.channels.map((c) => c.id) ?? []);
  const [projectIds, setProjectIds] = useState<string[]>(
    (initial?.conditions.projectIds as string[] | undefined) ?? [],
  );
  const [thresholdPositions, setThresholdPositions] = useState<number>(
    Number(initial?.conditions.thresholdPositions ?? 10),
  );
  const [severities, setSeverities] = useState<string[]>((initial?.conditions.severities as string[] | undefined) ?? []);
  const [cooldownMin, setCooldownMin] = useState(Math.round((initial?.cooldownSec ?? 3600) / 60));
  const [digest, setDigest] = useState(initial?.digest ?? "immediate");
  const [quietStart, setQuietStart] = useState(initial?.quietHours?.start ?? "");
  const [quietEnd, setQuietEnd] = useState(initial?.quietHours?.end ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const triggerDef = triggers.find((t) => t.key === trigger);
  const showThreshold = trigger === "rank_drop" || trigger === "rank_gain";
  const showSeverities = trigger === "fix_run";

  function toggle(list: string[], v: string, set: (l: string[]) => void) {
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  }

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (!channelIds.length) {
      setError("Pick at least one channel");
      return;
    }
    const conditions: Record<string, unknown> = {};
    if (projectIds.length) conditions.projectIds = projectIds;
    if (showThreshold) conditions.thresholdPositions = Math.max(1, thresholdPositions || 10);
    if (showSeverities && severities.length) conditions.severities = severities;
    setSaving(true);
    try {
      const url = editing ? `/api/alert-rules/${initial.id}` : "/api/alert-rules";
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          trigger,
          conditions,
          cooldownSec: Math.max(0, cooldownMin || 0) * 60,
          digest,
          quietHours: quietStart && quietEnd ? { start: quietStart, end: quietEnd } : null,
          channelIds,
          enabled,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Save failed");
        return;
      }
      onSaved(json.rule);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      <h3 className="mb-3 text-sm font-semibold">{editing ? "Edit rule" : "New rule"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Big rank drops" />
        </div>
        <div>
          <label className={labelCls}>Trigger</label>
          <select className={inputCls} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            {triggers.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
                {t.live ? "" : " (coming soon)"}
              </option>
            ))}
          </select>
          {triggerDef && <p className="mt-1 text-xs text-muted">{triggerDef.description}</p>}
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>Channels</label>
          <div className="flex flex-wrap gap-2">
            {channels
              .filter((c) => c.enabled)
              .map((c) => (
                <MultiChip
                  key={c.id}
                  pressed={channelIds.includes(c.id)}
                  onToggle={() => toggle(channelIds, c.id, setChannelIds)}
                >
                  {c.name} <span className="opacity-70">({TYPE_LABELS[c.type]})</span>
                </MultiChip>
              ))}
            {!channels.some((c) => c.enabled) && <p className="text-sm text-muted">Create and enable a channel first.</p>}
          </div>
        </div>
        {projects.length > 0 && (
          <div className="sm:col-span-2">
            <label className={labelCls}>Projects (empty = all)</label>
            <div className="flex flex-wrap gap-2">
              {projects.map((p) => (
                <MultiChip
                  key={p.id}
                  pressed={projectIds.includes(p.id)}
                  onToggle={() => toggle(projectIds, p.id, setProjectIds)}
                >
                  {p.name}
                </MultiChip>
              ))}
            </div>
          </div>
        )}
        {showThreshold && (
          <div>
            <label className={labelCls}>Threshold (positions)</label>
            <input
              type="number"
              min={1}
              className={inputCls}
              value={thresholdPositions}
              onChange={(e) => setThresholdPositions(Number(e.target.value))}
            />
          </div>
        )}
        {showSeverities && (
          <div>
            <label className={labelCls}>Severities</label>
            <div className="flex gap-3 pt-2">
              {["info", "warn", "critical"].map((sev) => (
                <MultiChip
                  key={sev}
                  pressed={severities.includes(sev)}
                  onToggle={() => toggle(severities, sev, setSeverities)}
                >
                  {sev[0].toUpperCase() + sev.slice(1)}
                </MultiChip>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className={labelCls}>Cooldown (minutes, anti-spam)</label>
          <input
            type="number"
            min={0}
            className={inputCls}
            value={cooldownMin}
            onChange={(e) => setCooldownMin(Number(e.target.value))}
          />
        </div>
        <div>
          <label className={labelCls}>Delivery</label>
          <select className={inputCls} value={digest} onChange={(e) => setDigest(e.target.value)}>
            <option value="immediate">Immediate</option>
            <option value="daily_digest">Daily digest</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Quiet hours (UTC, optional)</label>
          <div className="flex items-center gap-2">
            <input type="time" className={inputCls} value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
            <span className="text-muted">–</span>
            <input type="time" className={inputCls} value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
          </div>
        </div>
        <div className="flex items-end">
          <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button className={btnPrimary} onClick={save} disabled={saving}>
          {saving ? "Saving…" : editing ? "Save changes" : "Create rule"}
        </button>
        <button className={btnGhost} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ manager

export default function AlertManager({
  initialChannels,
  initialRules,
  triggers,
  projects,
  canManageChannels,
}: {
  initialChannels: AlertChannel[];
  initialRules: AlertRule[];
  triggers: Trigger[];
  projects: Project[];
  canManageChannels: boolean;
}) {
  const [tab, setTab] = useState<"channels" | "rules">("rules");
  const [channels, setChannels] = useState<AlertChannel[]>(initialChannels);
  const [rules, setRules] = useState<AlertRule[]>(initialRules);
  const [editingChannel, setEditingChannel] = useState<AlertChannel | "new" | null>(null);
  const [editingRule, setEditingRule] = useState<AlertRule | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggleChannel(c: AlertChannel) {
    setBusy(c.id);
    setError(null);
    try {
      const res = await fetch(`/api/alert-channels/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !c.enabled }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Update failed");
        return;
      }
      setChannels((cs) => cs.map((x) => (x.id === c.id ? json.channel : x)));
    } finally {
      setBusy(null);
    }
  }

  async function deleteChannel(c: AlertChannel) {
    if (!confirm(`Delete channel "${c.name}"? Rules using it will lose that channel.`)) return;
    setBusy(c.id);
    try {
      const res = await fetch(`/api/alert-channels/${c.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json();
        setError(json.error ?? "Delete failed");
        return;
      }
      setChannels((cs) => cs.filter((x) => x.id !== c.id));
    } finally {
      setBusy(null);
    }
  }

  async function toggleRule(r: AlertRule) {
    setBusy(r.id);
    setError(null);
    try {
      const res = await fetch(`/api/alert-rules/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Update failed");
        return;
      }
      setRules((rs) => rs.map((x) => (x.id === r.id ? json.rule : x)));
    } finally {
      setBusy(null);
    }
  }

  async function deleteRule(r: AlertRule) {
    if (!confirm(`Delete rule "${r.name}"?`)) return;
    setBusy(r.id);
    try {
      const res = await fetch(`/api/alert-rules/${r.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json();
        setError(json.error ?? "Delete failed");
        return;
      }
      setRules((rs) => rs.filter((x) => x.id !== r.id));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-line">
        {(
          [
            { id: "rules", label: "Rules", icon: BellRing },
            { id: "channels", label: "Channels", icon: Radio },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
                tab === t.id
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {tab === "channels" && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">
              Destinations for alerts. Secrets are stored encrypted and never shown back.
              {!canManageChannels && " Channel management requires an admin."}
            </p>
            {canManageChannels && !editingChannel && (
              <button className={btnPrimary} onClick={() => setEditingChannel("new")}>
                New channel
              </button>
            )}
          </div>

          {editingChannel && (
            <ChannelForm
              initial={editingChannel === "new" ? null : editingChannel}
              onSaved={(c) => {
                setChannels((cs) =>
                  editingChannel === "new" ? [...cs, c] : cs.map((x) => (x.id === c.id ? c : x)),
                );
                setEditingChannel(null);
              }}
              onCancel={() => setEditingChannel(null)}
            />
          )}

          {channels.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-line bg-paper p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{c.name}</span>
                  <span className={chipCls}>{TYPE_LABELS[c.type]}</span>
                  {!c.enabled && <span className={chipCls}>disabled</span>}
                </div>
                <p className="mt-1 font-mono text-xs text-muted">{c.hint || "—"}</p>
                <p className="mt-1 text-xs text-muted">
                  {c.ruleCount} rule{c.ruleCount === 1 ? "" : "s"}
                </p>
              </div>
              {canManageChannels && (
                <div className="flex gap-2">
                  <button className={btnGhost} onClick={() => toggleChannel(c)} disabled={busy === c.id}>
                    {c.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className={btnGhost} onClick={() => setEditingChannel(c)}>
                    Edit
                  </button>
                  <button className={btnDeny} onClick={() => deleteChannel(c)} disabled={busy === c.id}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
          {!channels.length && <p className="text-sm text-muted">No channels yet — create one to start receiving alerts.</p>}
        </div>
      )}

      {tab === "rules" && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">What fires, where it goes, and how often.</p>
            {!editingRule && (
              <button className={btnPrimary} onClick={() => setEditingRule("new")}>
                New rule
              </button>
            )}
          </div>

          {editingRule && (
            <RuleForm
              initial={editingRule === "new" ? null : editingRule}
              channels={channels}
              triggers={triggers}
              projects={projects}
              onSaved={(r) => {
                setRules((rs) => (editingRule === "new" ? [...rs, r] : rs.map((x) => (x.id === r.id ? r : x))));
                setEditingRule(null);
              }}
              onCancel={() => setEditingRule(null)}
            />
          )}

          {rules.map((r) => (
            <div key={r.id} className="rounded-lg border border-line bg-paper p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{r.name}</span>
                    {!r.enabled && <span className={chipCls}>disabled</span>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{r.triggerLabel}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.channels.map((c) => (
                      <span key={c.id} className={chipCls}>
                        {c.name} <span className="text-subtle">({TYPE_LABELS[c.type] ?? c.type})</span>
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    cooldown {fmtCooldown(r.cooldownSec)} · {r.digest === "daily_digest" ? "daily digest" : "immediate"}
                    {r.quietHours ? ` · quiet ${r.quietHours.start}–${r.quietHours.end} UTC` : ""}
                    {r.lastFiredAt ? ` · last fired ${new Date(r.lastFiredAt).toLocaleString()}` : " · never fired"}
                    {" · "}
                    {r.eventCount} events
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button className={btnGhost} onClick={() => toggleRule(r)} disabled={busy === r.id}>
                    {r.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className={btnGhost} onClick={() => setEditingRule(r)}>
                    Edit
                  </button>
                  <button className={btnDeny} onClick={() => deleteRule(r)} disabled={busy === r.id}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
          {!rules.length && <p className="text-sm text-muted">No rules yet — create one to get notified when things change.</p>}
        </div>
      )}
    </div>
  );
}
