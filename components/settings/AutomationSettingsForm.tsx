// Marketr — automation settings form (Phase 9 M6, docs/specs/SPEC-PHASE9.md §P9E).
// Client component: per-action Auto/Ask/Never policy table, workspace
// small-action threshold, and user-editable escalation rules.
// House style: dense tables, Agentic OS tokens, Lucide only, light mode.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BellRing,
  Bot,
  Check,
  Info,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";

type Behavior = "auto" | "ask" | "never";
type Tier = 0 | 1 | 2 | 3;

interface SettingRow {
  action: string;
  behavior: Behavior;
  thresholdCents: number | null;
}

interface KnownAction {
  action: string;
  label: string;
  description: string;
  tier: Tier;
}

interface SettingsPayload {
  settings: SettingRow[];
  defaults: {
    behaviors: Record<string, Behavior>;
    tier1Kinds: string[];
    thresholdCents: number;
    knownActions: KnownAction[];
  };
  thresholdCents: number;
}

type ConditionKind = "amount_above" | "unseen_treatment" | "no_source_record" | "external_audience";

interface EscalationRule {
  id: string;
  name: string;
  condition: { kind: ConditionKind; value?: number };
  action: "require_approval" | "notify";
  enabled: boolean;
  position: number;
}

const CONDITION_LABELS: Record<ConditionKind, string> = {
  amount_above: "Amount above",
  unseen_treatment: "Unseen treatment",
  no_source_record: "No source record",
  external_audience: "External audience",
};

function conditionText(rule: EscalationRule): string {
  switch (rule.condition.kind) {
    case "amount_above":
      return `Amount above $${((rule.condition.value ?? 0) / 100).toFixed(0)}`;
    case "unseen_treatment":
      return "Treatment never seen before";
    case "no_source_record":
      return "No source record attached";
    case "external_audience":
      return "Reaches an external audience";
  }
}

// ── Atoms (Agentic OS) ───────────────────────────────────────────────────────

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

// Tiers are categories (risk levels), not live agent states — neutral chips.
function TierBadge({ tier }: { tier: Tier }) {
  const labels: Record<Tier, string> = {
    0: "Tier 0 · Observe",
    1: "Tier 1 · Small",
    2: "Tier 2 · Ask",
    3: "Tier 3 · Never",
  };
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control">
      {labels[tier]}
    </span>
  );
}

// Rule effect: "Require approval" is a live approval gate → needs + edged
// triangle; "Notify" is configuration — neutral.
function EffectBadge({ effect }: { effect: "require_approval" | "notify" }) {
  if (effect === "require_approval") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-needs-tint px-1.5 py-0.5 text-[10px] font-medium leading-tight text-ink">
      <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Requires approval" />
        Require approval
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control">
      Notify
    </span>
  );
}

// Permission segmented control: pill group on a neutral track.
// Ask = needs + black text, Auto = running, Never = ink.
function BehaviorControl({
  value,
  tier,
  onChange,
  disabled,
}: {
  value: Behavior;
  tier: Tier;
  onChange: (b: Behavior) => void;
  disabled?: boolean;
}) {
  const options: Behavior[] = ["auto", "ask", "never"];
  return (
    <div
      className="inline-flex rounded-full border border-line bg-canvas p-0.5"
      role="radiogroup"
      aria-label="Automation behavior"
    >
      {options.map((opt) => {
        const locked = tier === 3 && opt === "auto";
        const active = value === opt;
        const activeCls =
          opt === "ask"
            ? "bg-needs text-ink"
            : opt === "auto"
              ? "bg-running text-white"
              : "bg-ink text-white";
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || locked}
            title={locked ? "Tier 3 actions can never run automatically — this is un-overridable." : undefined}
            onClick={() => onChange(opt)}
            className={`h-7 min-w-[52px] rounded-full px-2 text-xs font-medium capitalize transition disabled:opacity-40 ${
              active
                ? activeCls
                : locked
                  ? "cursor-not-allowed text-subtle"
                  : "text-muted hover:text-ink"
            }`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

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
        aria-hidden="true"
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[21px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

function fmtDollars(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

// ── Form ─────────────────────────────────────────────────────────────────────

export default function AutomationSettingsForm() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [rules, setRules] = useState<EscalationRule[] | null>(null);
  const [tab, setTab] = useState<"policy" | "rules">("policy");
  const [thresholdInput, setThresholdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // New-rule form
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ConditionKind>("amount_above");
  const [newValue, setNewValue] = useState("100");
  const [newAction, setNewAction] = useState<"require_approval" | "notify">("require_approval");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, r] = await Promise.all([
        fetch("/api/automation/settings").then((res) => res.json()),
        fetch("/api/automation/rules").then((res) => res.json()),
      ]);
      if (s.error) throw new Error(s.error);
      if (r.error) throw new Error(r.error);
      setData(s as SettingsPayload);
      setThresholdInput(String((s as SettingsPayload).thresholdCents / 100));
      setRules(r.rules as EscalationRule[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load automation settings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byAction = useMemo(() => {
    const m = new Map<string, SettingRow>();
    for (const s of data?.settings ?? []) m.set(s.action, s);
    return m;
  }, [data]);

  async function putSetting(action: string, behavior: Behavior, thresholdCents: number | null) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/automation/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, behavior, thresholdCents }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Save failed.");
      setData((prev) => {
        if (!prev) return prev;
        const settings = prev.settings.filter((s) => s.action !== action);
        settings.push({ action, behavior: body.setting.behavior, thresholdCents: body.setting.thresholdCents });
        return { ...prev, settings };
      });
      setNotice(`Saved: ${action} → ${behavior}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function saveThreshold() {
    const dollars = Number(thresholdInput);
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 100000) {
      setError("Threshold must be a non-negative dollar amount.");
      return;
    }
    await putSetting("*", "ask", Math.round(dollars * 100));
  }

  async function putRules(next: EscalationRule[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/automation/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: next.map((r) => ({
            name: r.name,
            condition: r.condition,
            action: r.action,
            enabled: r.enabled,
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Save failed.");
      setRules(body.rules as EscalationRule[]);
      setNotice("Escalation rules saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function addRule() {
    if (!newName.trim()) {
      setError("Give the rule a name.");
      return;
    }
    const condition =
      newKind === "amount_above"
        ? { kind: newKind, value: Math.max(0, Math.round(Number(newValue || 0) * 100)) }
        : { kind: newKind };
    const next: EscalationRule[] = [
      ...(rules ?? []),
      {
        id: `new_${Date.now()}`,
        name: newName.trim(),
        condition,
        action: newAction,
        enabled: true,
        position: (rules ?? []).length,
      },
    ];
    setNewName("");
    setNewValue("100");
    putRules(next);
  }

  if (!data || !rules) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Loader2 size={16} className="aos-spin" />
        Loading automation settings…
      </div>
    );
  }

  const tabs = [
    { id: "policy" as const, label: "Per-action policy", icon: Bot },
    { id: "rules" as const, label: "Escalation rules", icon: BellRing },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Info note — tiers in plain language */}
      <div className="flex gap-2.5 rounded-lg border border-line bg-canvas p-3">
        <Info size={16} className="mt-0.5 shrink-0 text-subtle" />
        <p className="text-[13px] leading-relaxed text-muted">
          <span className="font-semibold text-ink">How automation works:</span>{" "}
          <span className="font-medium">Tier 0</span> actions (reads, drafts, analysis) always run.{" "}
          <span className="font-medium">Tier 1</span> small actions run on their own only where you
          set <span className="font-medium">Auto</span> — everything else asks you first.{" "}
          <span className="font-medium">Tier 2</span> always asks, every time.{" "}
          <span className="font-medium">Tier 3</span> (moving money, signing contracts, deleting
          data) can never run automatically — no toggle, no prompt, no exception. The agent cannot
          widen this list.
        </p>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 border-b border-line" role="tablist">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
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
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text"
        >
          <span className="h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-muted">
          <Check size={15} className="shrink-0 text-ink" />
          {notice}
        </div>
      )}

      {tab === "policy" && (
        <div className="flex flex-col gap-4">
          {/* Workspace threshold */}
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper p-3">
            <div className="min-w-[220px] flex-1">
              <div className="text-[13px] font-semibold text-ink">Small-action threshold</div>
              <div className="text-[12px] text-muted">
                Tier 1 actions at or under this amount may run automatically when set to Auto.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-md border border-line bg-canvas px-2 focus-within:border-focus focus-within:ring-[3px] focus-within:ring-[var(--aos-focus-halo)]">
                <span className="text-[13px] text-subtle">$</span>
                <input
                  value={thresholdInput}
                  onChange={(e) => setThresholdInput(e.target.value)}
                  inputMode="decimal"
                  aria-label="Small-action threshold in dollars"
                  data-focus-ring="container"
                  className="w-20 bg-transparent px-1 py-1.5 text-[13px] text-ink outline-none"
                />
              </div>
              <button onClick={saveThreshold} disabled={saving} className={btnPrimary}>
                <Save size={14} />
                Save
              </button>
            </div>
          </div>

          {/* Per-action table */}
          <div className="overflow-x-auto rounded-lg border border-line bg-paper">
            <table className="min-w-[720px] w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Your setting</th>
                  <th className="px-3 py-2 font-medium">Threshold</th>
                </tr>
              </thead>
              <tbody>
                {data.defaults.knownActions.map((a) => {
                  const row = byAction.get(a.action);
                  const behavior: Behavior =
                    row?.behavior ?? data.defaults.behaviors[a.action] ?? "ask";
                  return (
                    <tr
                      key={a.action}
                      className="border-b border-line last:border-0 hover:bg-hover-paper"
                    >
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-ink">{a.label}</div>
                        <div className="font-mono text-[11px] text-subtle">{a.action}</div>
                        <div className="max-w-[300px] text-[12px] text-muted">{a.description}</div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <TierBadge tier={a.tier} />
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <BehaviorControl
                          value={behavior}
                          tier={a.tier}
                          disabled={saving}
                          onChange={(b) =>
                            putSetting(a.action, b, row?.thresholdCents ?? null)
                          }
                        />
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {a.tier === 1 ? (
                          <div className="flex items-center rounded-md border border-line bg-canvas px-2 focus-within:border-focus focus-within:ring-[3px] focus-within:ring-[var(--aos-focus-halo)]">
                            <span className="text-[13px] text-subtle">$</span>
                            <input
                              defaultValue={row?.thresholdCents != null ? String(row.thresholdCents / 100) : ""}
                              placeholder={fmtDollars(data.thresholdCents)}
                              inputMode="decimal"
                              aria-label={`${a.label} threshold override in dollars`}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                const next =
                                  v === "" ? null : Math.round(Number(v) * 100);
                                if (v !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0)) return;
                                if (next !== (row?.thresholdCents ?? null)) {
                                  putSetting(a.action, behavior, next);
                                }
                              }}
                              data-focus-ring="container"
                              className="w-20 bg-transparent px-1 py-1.5 text-[13px] text-ink outline-none placeholder:text-subtle"
                            />
                          </div>
                        ) : (
                          <span className="text-[12px] text-subtle">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-muted">
            Leave a threshold blank to use the workspace default ({fmtDollars(data.thresholdCents)}).
            Tier 3 rows always show Never — that setting is locked by the safety core, not by this page.
          </p>
        </div>
      )}

      {tab === "rules" && (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-muted">
            Escalation rules stop the system on defined conditions instead of asking you about
            everything. Any rule with effect <span className="font-medium">Require approval</span>{" "}
            forces the action to Tier 2, even if its toggle is set to Auto.
          </p>

          <div className="overflow-x-auto rounded-lg border border-line bg-paper">
            <table className="min-w-[640px] w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Rule</th>
                  <th className="px-3 py-2 font-medium">Condition</th>
                  <th className="px-3 py-2 font-medium">Effect</th>
                  <th className="px-3 py-2 font-medium">Enabled</th>
                  <th className="px-3 py-2 font-medium" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr
                    key={rule.id}
                    className="border-b border-line last:border-0 hover:bg-hover-paper"
                  >
                    <td className="px-3 py-2.5 font-medium text-ink">{rule.name}</td>
                    <td className="px-3 py-2.5 text-muted">{conditionText(rule)}</td>
                    <td className="px-3 py-2.5">
                      <EffectBadge effect={rule.action} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Switch
                        checked={rule.enabled}
                        onChange={(v) =>
                          putRules(rules.map((r) => (r.id === rule.id ? { ...r, enabled: v } : r)))
                        }
                        label={`Enable ${rule.name}`}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => putRules(rules.filter((r) => r.id !== rule.id))}
                        aria-label={`Remove ${rule.name}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-subtle hover:bg-failed-tint hover:text-failed-text"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add rule */}
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-3">
            <div className="text-[13px] font-semibold text-ink">Add escalation rule</div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[160px] flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-muted">Name</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Big outreach blasts"
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Condition</span>
                <select
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value as ConditionKind)}
                  className={inputCls}
                >
                  {(Object.keys(CONDITION_LABELS) as ConditionKind[]).map((k) => (
                    <option key={k} value={k}>
                      {CONDITION_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              {newKind === "amount_above" && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Above ($)</span>
                  <input
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    inputMode="decimal"
                    className={`${inputCls} w-24`}
                  />
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Effect</span>
                <select
                  value={newAction}
                  onChange={(e) => setNewAction(e.target.value as "require_approval" | "notify")}
                  className={inputCls}
                >
                  <option value="require_approval">Require approval</option>
                  <option value="notify">Notify</option>
                </select>
              </label>
              <button onClick={addRule} disabled={saving} className={btnPrimary}>
                <Plus size={14} />
                Add rule
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
