"use client";

// Marketr — project settings: Automation client (milestone 21, part D2).
// approvalModeOverride follows the trust ladder (spec §13): supervised →
// scheduled → manual-only. Skill tool actions follow the same ladder —
// nothing a skill does can outrun the project's approval mode.

import { useState } from "react";
import { CheckCircle, ShieldCheck, Warning } from "@/components/vault/phosphor";
import { Field } from "@/components/vault/Field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";
import { cn } from "@/lib/utils";

const MODES = [
  {
    value: "inherit",
    label: "Inherit from workspace",
    description: "Use the workspace default approval mode.",
  },
  {
    value: "supervised",
    label: "Supervised",
    description:
      "Marketr drafts and prepares; nothing consequential runs without your approval.",
  },
  {
    value: "scheduled",
    label: "Scheduled",
    description:
      "Approved automations may run on a schedule; anything new still needs a sign-off.",
  },
  {
    value: "manual-only",
    label: "Manual-only",
    description:
      "Every agent action — including skill tool calls — waits for explicit approval.",
  },
] as const;

type SaveState = "idle" | "saving" | "saved" | "error";

export default function AutomationClient({
  projectId,
  canEdit,
  initialOverride,
  workspaceDefault,
}: {
  projectId: string;
  canEdit: boolean;
  initialOverride: string | null;
  workspaceDefault: string;
}) {
  const [mode, setMode] = useState(initialOverride ?? "inherit");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const overridden = initialOverride !== null;

  async function change(next: string) {
    setMode(next);
    setState("saving");
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalModeOverride: next === "inherit" ? null : next,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Save failed (${res.status})`);
      }
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  const active = MODES.find((m) => m.value === mode) ?? MODES[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-accent-ink" weight="duotone" />
        <span className="text-[13px] text-ink-2">
          {overridden ? (
            <>
              Overriding the workspace default of{" "}
              <span className="font-medium text-ink">{workspaceDefault}</span>
            </>
          ) : (
            <>
              Inherited from workspace:{" "}
              <span className="font-medium text-ink">{workspaceDefault}</span>
            </>
          )}
        </span>
      </div>

      <Field label="Approval mode" htmlFor="approval-mode">
        <Select
          value={mode}
          onValueChange={(v) => void change(v ?? "inherit")}
          disabled={!canEdit || state === "saving"}
        >
          <SelectTrigger id="approval-mode" className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
                {m.value === "inherit" ? ` (${workspaceDefault})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <p className="max-w-prose text-[13px] leading-relaxed text-ink-2">
        {active.description}
      </p>

      <div className="rounded-control bg-inset p-4">
        <h4 className="text-[13px] font-medium text-ink">The trust ladder</h4>
        <ol className="mt-2 flex list-none flex-col gap-1.5 text-[12.5px] text-ink-2">
          <li>
            <span className="font-medium text-ink">Supervised.</span> Marketr
            proposes, you approve — drafts, publishes, and sends all wait for a
            click.
          </li>
          <li>
            <span className="font-medium text-ink">Scheduled.</span> Routines you
            already approved run on their own cadence; new actions still need
            approval.
          </li>
          <li>
            <span className="font-medium text-ink">Manual-only.</span> The
            strictest rung: every tool call, including skill tool actions,
            requires explicit approval first.
          </li>
        </ol>
        <p className="mt-2 text-[12.5px] text-ink-3">
          Skill tool actions always follow this mode — a skill can never act
          more freely than the project allows.
        </p>
      </div>

      {state === "saved" && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-green">
          <CheckCircle className="size-3.5" weight="duotone" />
          Saved
        </p>
      )}
      {state === "error" && error && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-red">
          <Warning className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
