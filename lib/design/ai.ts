// Marketr — Phase 11 "Canvas": AI design-generation helpers (pure, testable).
//
// buildDesignPrompt constrains the model to emit a DesignDocument-shaped JSON
// object (see lib/design/types.ts). The server route validates the result with
// validateDesignDocument and retries once with the validation error fed back.

const ELEMENT_FIELD_DOC = `
Element types (every element needs: id, type, name, x, y, rotation, opacity, visible, locked):
- text:   + text, fontFamily, fontSize, fontStyle ("normal"|"bold"|"italic"|"bold-italic"), fill (hex), align ("left"|"center"|"right"), lineHeight, letterSpacing, width (wrap width, optional)
- rect:   + width, height, fill (hex), cornerRadius
- ellipse:+ radiusX, radiusY, fill (hex)
- line:   + points [x1,y1,x2,y2,...] relative to x/y, stroke (hex), strokeWidth
- svg:    + path (raw SVG path data, 24x24 viewBox), width, height, fill (hex)
NOTE: do NOT emit image elements — there is no valid src available. Compose with shapes and text.

Template variables: a text element's text may contain {{variable}} placeholders
(name = letters/digits/underscore, e.g. {{headline}}, {{product}}, {{date}}).
Use them when the request mentions personalization, variants, or batch output —
e.g. write "{{headline}}" as the headline text so one template can generate many
variants. Only use variables the request implies; never invent values for them.

Fonts: use only Inter, Arial, Helvetica, Georgia. Colors: hex strings.
IDs: unique strings like "ai-1", "ai-2". Page: {id, name, width, height, background (hex), elements}.
Coordinates: x/y are the element's top-left (text/rect/svg/image) or center (ellipse); keep everything inside the page bounds.
`.trim();

export const MAX_AI_ELEMENTS = 16;

/**
 * Build the constrained prompt for "generate design". The model must return
 * ONLY a JSON object matching the schema — no prose, no markdown fences.
 */
export function buildDesignPrompt(
  userPrompt: string,
  width: number,
  height: number,
): string {
  return [
    "You are a marketing design assistant inside the ShapesOS canvas editor.",
    "Generate a design for the request below and return it as a single JSON object — nothing else, no prose, no markdown fences.",
    "",
    "Schema:",
    "{",
    '  "schemaVersion": 1,',
    '  "pages": [ <one page> ]',
    "}",
    ELEMENT_FIELD_DOC,
    "",
    "Rules:",
    `- Page size is exactly ${width} x ${height}. One page only.`,
    `- At most ${MAX_AI_ELEMENTS} elements. Layer order: background shapes first, headline text prominent and centered, supporting copy below.`,
    "- Write REAL marketing copy in the requested voice — never lorem ipsum, never placeholder text.",
    "- Keep text inside the page: estimate text block width from fontSize (avg char ~0.55 * fontSize) and set width accordingly.",
    "- Use a restrained palette: one light background, one dark ink, one accent.",
    "- rotation is almost always 0; opacity 1; visible true; locked false.",
    "",
    "Request:",
    userPrompt.trim(),
  ].join("\n");
}

/**
 * Extract the first JSON object from model output. Handles markdown fences
 * and leading/trailing prose. Returns undefined when nothing parses.
 */
export function extractJsonObject(text: string): unknown | undefined {
  const cleaned = text
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  const slice = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(slice) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Build the constrained prompt for batch "Fill from brief": the model must
 * return ONLY a JSON array of row objects — no prose, no markdown fences.
 * Each row maps every variable name to a value. The route validates the
 * rows against the variable list and rejects anything off-schema.
 */
export function buildBatchFillPrompt(
  brief: string,
  variables: string[],
  count: number,
): string {
  return [
    "You are a marketing copy assistant inside the ShapesOS canvas editor.",
    "Given a creative brief and a list of template variables, write distinct, on-brief values for each variable.",
    "Return ONLY a JSON array — nothing else, no prose, no markdown fences.",
    "",
    `Variables: ${variables.map((v) => `{{${v}}}`).join(", ")}`,
    `Rows to produce: exactly ${count}.`,
    "Rules:",
    "- Each array item is an object with EXACTLY these keys: " +
      variables.map((v) => `"${v}"`).join(", ") +
      ". No extra keys, no missing keys.",
    "- Values are short marketing copy strings (a word to a sentence), never lorem ipsum.",
    "- Make every row distinct — vary the angle, offer, or wording across rows.",
    "- Keep values plain text: no markdown, no quotes around the whole value.",
    "",
    "Brief:",
    brief.trim(),
  ].join("\n");
}

/** Human-friendly label for AI sizes offered in the panel. */
export const AI_DESIGN_SIZES = [
  { key: "square", label: "Square 1080×1080", width: 1080, height: 1080 },
  { key: "story", label: "Story 1080×1920", width: 1080, height: 1920 },
  { key: "landscape", label: "Landscape 1920×1080", width: 1920, height: 1080 },
  { key: "wide", label: "Wide banner 1200×628", width: 1200, height: 628 },
] as const;
