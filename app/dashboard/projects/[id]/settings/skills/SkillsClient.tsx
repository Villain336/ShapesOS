"use client";

// Marketr — project settings: Skills toggles (milestone 21, part D2).
// Enable/disable an installed workspace skill for this project via
// PUT /api/projects/[projectId]/skills { skillId, enabled }.
// When enabled, the skill's name + description are injected into Marketr's
// system prompt for this project's sessions (spec §6).

import { useState } from "react";
import { Warning } from "@/components/vault/phosphor";
import { Switch } from "@/components/vault/shadcn/switch";

export interface ProjectSkillRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  trustTier: string;
  enabled: boolean;
}

function trustTierLabel(tier: string): string {
  const t = tier.toLowerCase().replace(/_/g, "-");
  if (t === "built-in") return "Built-in";
  if (t === "pinned-url") return "Pinned URL";
  return tier;
}

export default function SkillsClient({
  projectId,
  canEdit,
  initialSkills,
}: {
  projectId: string;
  canEdit: boolean;
  initialSkills: ProjectSkillRow[];
}) {
  const [skills, setSkills] = useState(initialSkills);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(skill: ProjectSkillRow) {
    const next = !skill.enabled;
    setSkills((prev) =>
      prev.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)),
    );
    setPending(skill.id);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/skills`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: skill.id, enabled: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Toggle failed (${res.status})`);
      }
    } catch (e) {
      // Revert the optimistic update so the UI never lies.
      setSkills((prev) =>
        prev.map((s) => (s.id === skill.id ? { ...s, enabled: skill.enabled } : s)),
      );
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col">
      {skills.map((skill) => (
        <div
          key={skill.id}
          className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[13.5px] font-medium text-ink">{skill.name}</span>
              <span className="rounded-full bg-inset px-2 py-0.5 font-mono text-[11px] text-ink-3">
                v{skill.version}
              </span>
              <span className="rounded-full bg-inset px-2 py-0.5 text-[11px] text-ink-3">
                {trustTierLabel(skill.trustTier)}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-2">
              {skill.description}
            </p>
          </div>
          <Switch
            checked={skill.enabled}
            disabled={!canEdit || pending === skill.id}
            onCheckedChange={() => void toggle(skill)}
            aria-label={`Enable ${skill.name} for this project`}
          />
        </div>
      ))}
      {error && (
        <p className="flex items-center gap-1.5 pt-2 text-[12.5px] text-red">
          <Warning className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
