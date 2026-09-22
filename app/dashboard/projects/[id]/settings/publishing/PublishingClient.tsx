"use client";

// Marketr — project settings: Publishing client (milestone 21, part D2).
// Toggles which publish destinations Marketr may use for this project.
// Unchecked = disallowed. Persisted via PUT /api/projects/[projectId]/settings.

import { useState } from "react";
import { CheckCircle, Warning } from "@/components/vault/phosphor";
import { Checkbox } from "@/components/vault/shadcn/checkbox";

const CONTROLS = [
  {
    key: "allowWordpressPublish",
    label: "WordPress publish",
    description: "Marketr may publish posts and pages to the connected WordPress site.",
  },
  {
    key: "allowWebflowPublish",
    label: "Webflow publish",
    description: "Marketr may publish to the connected Webflow site.",
  },
  {
    key: "allowHostingDeploy",
    label: "Hosting deploy",
    description: "Marketr may deploy sites and landing pages it builds.",
  },
  {
    key: "allowNewsletterSend",
    label: "Newsletter send",
    description: "Marketr may send newsletter broadcasts to subscribers.",
  },
] as const;

type SaveState = "idle" | "saving" | "saved" | "error";

export default function PublishingClient({
  projectId,
  canEdit,
  initialControls,
}: {
  projectId: string;
  canEdit: boolean;
  initialControls: Record<string, boolean>;
}) {
  const [controls, setControls] = useState<Record<string, boolean>>(initialControls);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: string) {
    const next = { ...controls, [key]: !controls[key] };
    setControls(next);
    setState("saving");
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publishingControls: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Save failed (${res.status})`);
      }
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setControls(controls); // revert
      setState("error");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  return (
    <div className="flex flex-col">
      {CONTROLS.map((c) => (
        <label
          key={c.key}
          className="flex cursor-pointer items-start gap-3 border-b border-line py-3 last:border-b-0"
        >
          <Checkbox
            checked={controls[c.key] === true}
            disabled={!canEdit || state === "saving"}
            onCheckedChange={() => void toggle(c.key)}
            aria-label={c.label}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium text-ink">{c.label}</span>
            <span className="mt-0.5 block text-[12.5px] text-ink-2">
              {c.description}
            </span>
          </span>
        </label>
      ))}

      <p className="mt-3 text-[12.5px] text-ink-3">
        Approval mode (Automation tab) still governs whether each publish needs
        your sign-off — these controls only set which destinations are allowed
        at all.
      </p>

      {state === "saved" && (
        <p className="flex items-center gap-1.5 pt-2 text-[12.5px] text-green">
          <CheckCircle className="size-3.5" weight="duotone" />
          Saved
        </p>
      )}
      {state === "error" && error && (
        <p className="flex items-center gap-1.5 pt-2 text-[12.5px] text-red">
          <Warning className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
