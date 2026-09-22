// Marketr — skills library: SKILL.md frontmatter parsing (spec §7 MVP scope).
// Deliberately dependency-free: parses the small YAML subset Marketr supports
// (scalar `key: value` lines + simple `- item` arrays). Anything fancier is
// rejected with a specific, human-readable error.

import type { ParsedSkill, SkillManifest } from "./types";

export const MAX_DESCRIPTION_LENGTH = 500;
export const DEFAULT_VERSION = "1.0.0";

export type SkillParseResult =
  | { ok: true; value: ParsedSkill }
  | { ok: false; errors: string[] };

/** Split raw text into lines, tolerating CRLF. */
function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

function isFenceLine(line: string): boolean {
  return line.trim() === "---";
}

/** Strip one pair of matching single or double quotes from a scalar. */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse the frontmatter block lines into raw key/value entries.
 * Values are strings or string[] (for dash-array blocks). Returns parse
 * errors for malformed lines. Inline YAML arrays (`[a, b]`) are NOT
 * supported — use dash lists.
 */
function parseBlock(lines: string[]): { fields: Map<string, string | string[]>; errors: string[] } {
  const fields = new Map<string, string | string[]>();
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon === -1) {
      errors.push(`frontmatter line ${i + 1} is not a "key: value" pair: "${line.trim()}"`);
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (!key) {
      errors.push(`frontmatter line ${i + 1} has an empty key`);
      continue;
    }
    if (fields.has(key)) {
      errors.push(`duplicate field '${key}' in frontmatter`);
      continue;
    }

    const rest = line.slice(colon + 1);
    if (rest.trim() !== "") {
      // Inline flow arrays are not part of the supported subset.
      const scalar = rest.trim();
      if (scalar.startsWith("[") && scalar.endsWith("]")) {
        errors.push(
          `field '${key}' uses an inline array; use a dash list instead:\n  ${key}:\n    - item1\n    - item2`,
        );
        continue;
      }
      fields.set(key, unquote(scalar));
      continue;
    }

    // Empty value: collect the following dash-array block (indented or not).
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length && /^\s*-\s/.test(lines[j])) {
      items.push(unquote(lines[j].replace(/^\s*-\s*/, "")));
      j++;
    }
    i = j - 1;
    fields.set(key, items);
  }

  return { fields, errors };
}

/**
 * Parse a SKILL.md document. The document must start with a `---` YAML
 * frontmatter fence; `name` and `description` are required; `version`
 * defaults to "1.0.0"; `tools` (dash list) becomes `declaredTools`.
 */
export function parseSkillMd(skillMd: string): SkillParseResult {
  const errors: string[] = [];

  if (!skillMd || skillMd.trim() === "") {
    return { ok: false, errors: ["SKILL.md is empty"] };
  }

  const lines = linesOf(skillMd);
  if (!isFenceLine(lines[0])) {
    return { ok: false, errors: ["frontmatter missing: no --- fence"] };
  }

  const closeIdx = lines.findIndex((l, i) => i > 0 && isFenceLine(l));
  if (closeIdx === -1) {
    return { ok: false, errors: ["frontmatter missing: unterminated --- fence"] };
  }

  const { fields, errors: blockErrors } = parseBlock(lines.slice(1, closeIdx));
  errors.push(...blockErrors);

  // --- required fields -----------------------------------------------------
  const rawName = fields.get("name");
  if (rawName === undefined || (typeof rawName === "string" && rawName.trim() === "")) {
    errors.push("field 'name' is required");
  } else if (Array.isArray(rawName)) {
    errors.push("field 'name' must be a string, not a list");
  }

  const rawDescription = fields.get("description");
  if (rawDescription === undefined || (typeof rawDescription === "string" && rawDescription.trim() === "")) {
    errors.push("field 'description' is required");
  } else if (Array.isArray(rawDescription)) {
    errors.push("field 'description' must be a string, not a list");
  } else if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `field 'description' must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${rawDescription.length})`,
    );
  }

  // --- optional fields ------------------------------------------------------
  let version = DEFAULT_VERSION;
  const rawVersion = fields.get("version");
  if (rawVersion !== undefined) {
    if (Array.isArray(rawVersion)) {
      errors.push("field 'version' must be a string, not a list");
    } else if (rawVersion.trim() === "") {
      errors.push("field 'version' must not be empty");
    } else {
      version = rawVersion.trim();
    }
  }

  let declaredTools: string[] = [];
  const rawTools = fields.get("tools");
  if (rawTools !== undefined) {
    if (!Array.isArray(rawTools)) {
      errors.push("field 'tools' must be a dash list, one tool per line");
    } else if (rawTools.some((t) => t.trim() === "")) {
      errors.push("field 'tools' must not contain empty entries");
    } else {
      declaredTools = rawTools.map((t) => t.trim());
    }
  }

  const body = lines.slice(closeIdx + 1).join("\n").trim();
  if (body === "") {
    errors.push("skill body is empty: add guidance after the closing --- fence");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const manifest: SkillManifest = {
    name: (rawName as string).trim(),
    description: (rawDescription as string).trim(),
    version,
    declaredTools,
  };
  return { ok: true, value: { manifest, body } };
}
