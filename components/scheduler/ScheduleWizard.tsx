// Marketr — new-schedule wizard (Phase B, W2).
// Skill picker (project-enabled skills only), trigger = cron builder or
// event source + config, approval mode, concurrency cap. Warm Operator, no emoji.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Notice, btnCls, cardCls, inputCls, primaryBtnCls, type NoticeState } from "@/components/settings/ui";
import TimezoneField, { useBrowserTimeZone } from "./TimezoneField";
import { Clock } from "lucide-react";
import { Field } from "@/components/aos/Controls";

interface SkillOption {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

const CRON_PRESETS = [
  { key: "daily", label: "Daily at 9:00 AM", expr: "0 9 * * *" },
  { key: "weekly", label: "Weekly on Monday at 9:00 AM", expr: "0 9 * * 1" },
  { key: "monthly", label: "Monthly on the 1st at 9:00 AM", expr: "0 9 1 * *" },
  { key: "custom", label: "Custom expression", expr: "" },
] as const;

const EVENT_SOURCES = [
  { source: "rank_drop", label: "Rank drop", description: "A tracked keyword falls more than N positions." },
  { source: "new_backlink", label: "New backlink", description: "A new backlink to the domain is detected." },
  { source: "connector_error", label: "Connector error", description: "A connector sync or refresh fails." },
  { source: "content_decay", label: "Content decay", description: "A page's traffic decay flag is raised." },
  { source: "content_published", label: "Content published", description: "A content item is published." },
] as const;

// Select labels match the kit Field label (text-md, semibold, ink).
const selectLabelCls = "flex flex-col gap-2 text-md font-semibold text-ink";
const selectCls = `${inputCls} h-control w-full text-base font-normal`;

const APPROVAL_MODES = [
  { mode: "supervised", label: "Supervised", description: "Notify and wait — every run needs your approval before anything executes." },
  { mode: "scheduled", label: "Scheduled", description: "Run on trigger and report — results land in run history." },
  { mode: "autopilot", label: "Autopilot", description: "Run silently — for trusted, low-risk skills." },
] as const;

export default function ScheduleWizard({
  projectId,
  workspaceId,
}: {
  projectId: string;
  workspaceId: string;
}) {
  const router = useRouter();
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillId, setSkillId] = useState("");
  const [triggerType, setTriggerType] = useState<"cron" | "event">("cron");
  const [preset, setPreset] = useState<string>("daily");
  const [customExpr, setCustomExpr] = useState("");
  // Presets say "9:00 AM": default to the creator's own zone (null = untouched).
  const detectedZone = useBrowserTimeZone();
  const [timezoneChoice, setTimezoneChoice] = useState<string | null>(null);
  const timezone = timezoneChoice ?? detectedZone;
  const [eventSource, setEventSource] = useState<string>("rank_drop");
  const [dropThreshold, setDropThreshold] = useState(3);
  const [minDropPct, setMinDropPct] = useState(20);
  const [domain, setDomain] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [approvalMode, setApprovalMode] = useState<string>("supervised");
  const [concurrencyLimit, setConcurrencyLimit] = useState(4);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  // Field-level errors (kit Field: red square + text, aria-invalid).
  const [cronError, setCronError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/projects/${projectId}/skills`);
    const j = await r.json();
    if (r.ok) {
      const enabled = (j.skills ?? []).filter((s: SkillOption) => s.enabled);
      setSkills(enabled);
      setSkillId((prev) => prev || enabled[0]?.id || "");
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const cronExpr = preset === "custom" ? customExpr.trim() : (CRON_PRESETS.find((p) => p.key === preset)?.expr ?? "");

  function eventConfig(): Record<string, unknown> {
    if (eventSource === "rank_drop") return { dropThreshold };
    if (eventSource === "content_decay") return { minDropPct };
    if (eventSource === "new_backlink") return domain.trim() ? { domain: domain.trim() } : {};
    if (eventSource === "connector_error") return connectionId.trim() ? { connectionId: connectionId.trim() } : {};
    return {};
  }

  async function submit() {
    setBusy(true);
    setNotice(null);
    if (!skillId) {
      setNotice({ kind: "error", message: "Pick a skill first." });
      setBusy(false);
      return;
    }
    const body: Record<string, unknown> = {
      workspaceId,
      projectId,
      skillId,
      triggerType,
      approvalMode,
      concurrencyLimit,
    };
    if (triggerType === "cron") {
      if (!cronExpr) {
        setCronError("Enter a cron expression (5 fields: minute hour day month weekday).");
        setBusy(false);
        return;
      }
      body.cronExpr = cronExpr;
      body.timezone = timezone.trim() || "UTC";
    } else {
      body.eventSource = eventSource;
      body.eventConfig = eventConfig();
    }
    const r = await fetch("/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setNotice({ kind: "error", message: j.error ?? "Failed to create schedule" });
      return;
    }
    router.push(`/dashboard/projects/${projectId}/automations/schedules/${j.schedule.id}`);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <Notice notice={notice} />

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink">1. Skill</h2>
        <p className="mt-1 text-xs text-muted">Only skills enabled for this project can be scheduled.</p>
        {skills.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No skills are enabled for this project yet. Enable one under the project's skill settings first.
          </p>
        ) : (
          <select className={`${inputCls} mt-3 w-full`} value={skillId} onChange={(e) => setSkillId(e.target.value)}>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink">2. Trigger</h2>
        <div className="mt-3 flex gap-2">
          {(["cron", "event"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTriggerType(t)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                triggerType === t
                  ? "bg-ink text-white"
                  : "bg-paper text-ink shadow-control hover:shadow-outline"
              }`}
            >
              {t === "cron" ? "Schedule" : "Event"}
            </button>
          ))}
        </div>

        {triggerType === "cron" ? (
          <div className="mt-4 flex flex-col gap-3">
            <label className={selectLabelCls}>
              Cadence
              <select className={selectCls} value={preset} onChange={(e) => setPreset(e.target.value)}>
                {CRON_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {preset === "custom" && (
              <Field
                label="Cron expression"
                value={customExpr}
                onChange={(e) => {
                  setCustomExpr(e.target.value);
                  if (cronError) setCronError(null);
                }}
                placeholder="0 9 * * 1"
                leading={<Clock className="size-4" aria-hidden />}
                inputClassName="aos-mono"
                helper="5 fields: minute hour day month weekday."
                error={cronError}
              />
            )}
            {preset !== "custom" && (
              <p className="font-mono text-xs text-muted">
                Expression: <span className="text-ink">{cronExpr}</span>
              </p>
            )}
            <TimezoneField value={timezone} onChange={setTimezoneChoice} />
            <p className="text-xs text-muted">
              If the scheduler restarts and misses a window, the run fires once and is marked missed — missed windows are never replayed in bulk.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <label className={selectLabelCls}>
              Event source
              <select className={selectCls} value={eventSource} onChange={(e) => setEventSource(e.target.value)}>
                {EVENT_SOURCES.map((s) => (
                  <option key={s.source} value={s.source}>
                    {s.label} — {s.description}
                  </option>
                ))}
              </select>
            </label>
            {eventSource === "rank_drop" && (
              <Field
                label="Fire when a keyword drops more than"
                type="number"
                min={1}
                max={100}
                className="max-w-60"
                trailing="positions"
                value={dropThreshold}
                onChange={(e) => setDropThreshold(Number(e.target.value) || 3)}
              />
            )}
            {eventSource === "content_decay" && (
              <Field
                label="Fire when traffic drops more than"
                type="number"
                min={0}
                max={100}
                className="max-w-60"
                trailing="%"
                value={minDropPct}
                onChange={(e) => setMinDropPct(Number(e.target.value) || 20)}
              />
            )}
            {eventSource === "new_backlink" && (
              <Field
                label="Only for domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.com"
                helper="Optional. Leave empty for every domain in the project."
              />
            )}
            {eventSource === "connector_error" && (
              <Field
                label="Only for connection ID"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                inputClassName="aos-mono"
                helper="Optional. Leave empty for every connection."
              />
            )}
          </div>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink">3. Approval mode</h2>
        <div className="mt-3 flex flex-col gap-2">
          {APPROVAL_MODES.map((m) => (
            <label key={m.mode} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${approvalMode === m.mode ? "border-ink bg-hover-paper" : "border-line bg-paper"}`}>
              <input
                type="radio"
                name="approvalMode"
                value={m.mode}
                checked={approvalMode === m.mode}
                onChange={() => setApprovalMode(m.mode)}
                className="mt-1"
              />
              <span>
                <span className="text-sm font-medium text-ink">{m.label}</span>
                <span className="block text-xs text-muted">{m.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-ink">4. Parallelism</h2>
        <Field
          label="Max parallel sub-agents"
          type="number"
          min={1}
          max={16}
          className="mt-3 max-w-60"
          value={concurrencyLimit}
          onChange={(e) => setConcurrencyLimit(Math.min(16, Math.max(1, Number(e.target.value) || 4)))}
          helper="1 to 16. The workspace default is 4."
        />
      </section>

      <div className="flex gap-2">
        <button className={primaryBtnCls} disabled={busy || !skillId} onClick={submit}>
          {busy ? "Creating…" : "Create schedule"}
        </button>
        <button type="button" className={btnCls} onClick={() => router.back()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
