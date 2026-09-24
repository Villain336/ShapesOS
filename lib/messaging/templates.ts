// Marketr — R3 nurture template rendering.
//
// `{{placeholder}}` substitution from Lead fields. Values are HTML-escaped
// when rendering email (so template markup survives while lead data can't
// inject tags); SMS/voice render as plain text without escaping.

export type TemplateValues = {
  firstName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  unsubscribeUrl?: string | null;
  [key: string]: string | null | undefined;
};

/** Placeholder names the builder surfaces as insertable chips. */
export const TEMPLATE_PLACEHOLDERS = [
  "firstName",
  "company",
  "email",
  "phone",
  "unsubscribeUrl",
] as const;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Derive firstName from a full name; falls back to "" (not "there") so
 *  templates can decide how to greet. */
export function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ?? "";
}

export function leadTemplateValues(lead: {
  name?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
}): TemplateValues {
  return {
    firstName: firstNameOf(lead.name),
    company: lead.company ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
  };
}

/**
 * Render `{{placeholder}}` tokens against values. Unknown tokens are left
 * untouched (so a typo surfaces in the approval preview instead of silently
 * vanishing). Set `escape: true` for email HTML bodies.
 */
export function renderTemplate(
  template: string,
  values: TemplateValues,
  opts: { escape?: boolean } = {},
): string {
  const escape = opts.escape ?? false;
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (!(key in values) || values[key] == null) return match;
    const raw = String(values[key]);
    return escape ? escapeHtml(raw) : raw;
  });
}

/** List the placeholder names used in a template (for builder hints). */
export function templatePlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    found.add(m[1]);
  }
  return [...found];
}
