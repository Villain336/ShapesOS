"use client";

// Marketr — project settings: Skills toggles (milestone 21, part D2).
// Enable/disable an installed workspace skill for this project via
// PUT /api/projects/[id]/skills { skillId, enabled }.
// When enabled, the skill's name + description are injected into Marketr's
// system prompt for this project's sessions (spec §6).

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
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
              <span className="text-[0.84375rem] font-medium text-ink">{skill.name}</span>
              <span className="rounded-full bg-inset px-2 py-0.5 font-mono text-[0.6875rem] text-ink-3">
                v{skill.version}
              </span>
              <span className="rounded-full bg-inset px-2 py-0.5 text-[0.6875rem] text-ink-3">
                {trustTierLabel(skill.trustTier)}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[0.78125rem] text-ink-2">
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
        <p className="flex items-center gap-1.5 pt-2 text-[0.78125rem] text-red">
          <TriangleAlert className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
