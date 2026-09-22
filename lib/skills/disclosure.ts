// Marketr — skills library: progressive-disclosure prompt injection
// (spec §6 "Skill loading (agent runtime)").
// Session start injects name+description (~100 tokens each); the agent
// loads the full SKILL.md via loadSkillBySlug only when it matches one.

import type { PrismaClient } from "@prisma/client";

/** ~60 words ≈ 100 tokens. Long descriptions are cut here, never mid-word. */
export const DISCLOSURE_WORD_LIMIT = 60;

function truncateWords(text: string, limit: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(" ");
  return `${words.slice(0, limit).join(" ")}…`;
}

/**
 * Build the "## AVAILABLE SKILLS" system-prompt section: one
 * `name: description` line per skill, each ~100 tokens.
 */
export function skillManifestSection(
  skills: Array<{ name: string; description: string }>,
): string {
  const header = "## AVAILABLE SKILLS";
  if (skills.length === 0) {
    return `${header}\n\nNo skills are installed for this project.`;
  }
  const lines = skills.map(
    (s) => `${s.name}: ${truncateWords(s.description, DISCLOSURE_WORD_LIMIT)}`,
  );
  return `${header}\n\n${lines.join("\n")}`;
}

/**
 * Load a skill's full SKILL.md by slug, scoped to the workspace.
 * Returns null when no such skill exists (the agent must not hallucinate one).
 */
export async function loadSkillBySlug(
  db: PrismaClient,
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  const skill = await db.skill.findFirst({ where: { workspaceId, slug } });
  return skill?.skillMd ?? null;
}
