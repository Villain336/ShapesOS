// Marketr — skills library: shared type shapes (spec §6 data model, §11).
// Server-side only; no UI, no network. Prisma model types are derived from
// the client in the modules that touch the database.

/** The portable frontmatter contract every SKILL.md carries. */
export interface SkillManifest {
  /** Display name, e.g. "SEO Audit". */
  name: string;
  /** One-to-two sentence summary (≤ 500 chars). Shown in the agent prompt. */
  description: string;
  /** Defaults to "1.0.0" when the frontmatter omits it. */
  version?: string;
  /** Tool names the skill may invoke, e.g. "google-search-console.query". */
  declaredTools?: string[];
}

/** A fully parsed SKILL.md: manifest plus the markdown body below the fence. */
export interface ParsedSkill {
  manifest: SkillManifest;
  /** Markdown body after the closing `---` fence. */
  body: string;
}

/** A built-in pack shipped in code (lib/skills/registry.ts). */
export interface RegistryPack {
  /** Stable install key; also the default slug, e.g. "seo-audit". */
  key: string;
  name: string;
  description: string;
  version: string;
  declaredTools: string[];
  /** Full SKILL.md text (frontmatter + body). Must parse cleanly. */
  skillMd: string;
}

/** Preview produced by previewFromUrl before a URL install is confirmed. */
export interface UrlSkillPreview {
  name: string;
  description: string;
  version: string;
  /** Pinned commit SHA, or null when it could not be resolved (with a warning). */
  sha: string | null;
  skillMd: string;
  warnings: string[];
}
