// Marketr — shared request-body validation (Phase A hardening, Fix 6).
//
// validateBody(schema, body): safeParse a zod schema against an already-read
// body, with a JSON depth cap. Malformed bodies → 400, never 500. Error
// details carry field paths + messages only (never echoed values, so secrets
// in a bad body can't leak back in the response).

import { z } from "zod";
import { errorResponse } from "./errors";

export { z };

/** Objects nested deeper than this are rejected (stack/DoS guard). */
export const MAX_JSON_DEPTH = 20;

function depthOf(value: unknown, depth: number): number {
  if (depth > MAX_JSON_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const el of value) max = Math.max(max, depthOf(el, depth + 1));
    return max;
  }
  if (value !== null && typeof value === "object") {
    let max = depth;
    for (const k of Object.keys(value)) {
      max = Math.max(max, depthOf((value as Record<string, unknown>)[k], depth + 1));
    }
    return max;
  }
  return depth;
}

export type Validated<T> = { ok: true; data: T } | { ok: false; error: Response };

/**
 * Validate an already-parsed body. Returns { ok: true, data } (unknown fields
 * stripped by the schema) or { ok: false, error } (a 400 Response).
 */
export function validateBody<T>(schema: z.ZodType<T>, body: unknown): Validated<T> {
  if (body !== null && typeof body === "object" && depthOf(body, 0) > MAX_JSON_DEPTH) {
    return {
      ok: false,
      error: Response.json(
        { error: `Request body is too deeply nested (max depth ${MAX_JSON_DEPTH}).` },
        { status: 400 },
      ),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 10).map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    return {
      ok: false,
      error: Response.json({ error: "Invalid request body.", details }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Validate URL query parameters against a zod object schema. Empty values
 * count as absent; only the first value of a repeated key is used. Invalid
 * input → { ok: false, error } with a 400 from the shared error mapper
 * (lib/api/errors.ts), so `?take=abc`, `?limit=1.5` or an unknown enum
 * filter never reaches Prisma as a 500.
 */
export function parseQuery<T>(schema: z.ZodType<T>, searchParams: URLSearchParams): Validated<T> {
  const raw: Record<string, string> = {};
  for (const [k, v] of searchParams) {
    if (!(k in raw) && v !== "") raw[k] = v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: errorResponse(parsed.error) };
  return { ok: true, data: parsed.data };
}

/**
 * Integer query parameter for paging: absent → `def`; anything that isn't a
 * whole number ("abc", "1.5", "1e3") is a 400; in-range values pass and
 * out-of-range ones are clamped to [min, max] (the routes' long-standing
 * clamp behavior).
 */
export const intQuery = (def: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^-?\d{1,9}$/, "must be a whole number")
    .optional()
    .transform((v) => (v === undefined ? def : Math.min(max, Math.max(min, Number(v)))));

// --- reusable field schemas -------------------------------------------------

export const workspaceIdField = z.string().trim().min(1, "workspaceId is required").max(120);

export const idField = z.string().trim().min(1).max(120);

/** Non-empty trimmed string with a max length (names, labels, URLs...). */
export const boundedString = (max: number, what = "value") =>
  z.string().trim().min(1, `${what} is required`).max(max, `${what} is too long (max ${max} characters)`);

/** Optional trimmed string (empty → undefined). */
export const optionalString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length ? s : undefined))
    .optional();
