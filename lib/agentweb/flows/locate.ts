// ShapesOS — Phase 21A round 2 (WS=agentweb): self-healing locators (PURE).
//
// A taught flow names a control by what it IS (role, name, field name, link address), not by a ref
// that is only valid for one snapshot. Running it again, the page may have changed. Order:
//   1. attribute   the field's name attribute / the link's address (survives a relabel)
//   2. role-name   same role, same name (case and spacing aside)
//   3. fuzzy       same role, a close name (most words shared)
//   4. text        any control with that exact name (the role changed)
// Two equally good matches at the first level that has any is NOT resolved: it is a "human check"
// (the run stops and asks), never a guess. Nothing found is the same.

import type { ElementInfo } from "../types";
import type { Locator } from "./spec";

export type LocateHow = "attribute" | "role-name" | "fuzzy" | "text";

export type LocateResult =
  | { ok: true; element: ElementInfo; how: LocateHow }
  | { ok: false; reason: "ambiguous" | "not_found"; candidates: ElementInfo[] };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textarea"]);
const STOP = new Set(["a", "an", "the", "to", "of", "and", "for", "in", "on", "now"]);

function tokens(s: string): string[] {
  return norm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOP.has(t));
}

/** Share of the taught name's words that the candidate's name also has (0..1). */
function overlap(taught: string, candidate: string): number {
  const a = tokens(taught);
  if (a.length === 0) return 0;
  const b = new Set(tokens(candidate));
  return a.filter((t) => b.has(t)).length / a.length;
}

function hrefKey(href?: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

export interface LocateOptions {
  /** "field": only typing targets (never a button matched by text). */
  needs?: "field" | "any";
}

export function resolveLocator(locator: Locator, controls: readonly ElementInfo[], opts: LocateOptions = {}): LocateResult {
  const pool = controls.filter((c) => (opts.needs === "field" ? FIELD_ROLES.has(c.role) || c.tag === "input" || c.tag === "textarea" : true));
  const enabledFirst = (xs: ElementInfo[]) => {
    const on = xs.filter((x) => !x.disabled);
    return on.length > 0 ? on : xs;
  };
  const decide = (found: ElementInfo[], how: LocateHow): LocateResult | null => {
    if (found.length === 0) return null;
    const best = enabledFirst(found);
    return best.length === 1 ? { ok: true, element: best[0], how } : { ok: false, reason: "ambiguous", candidates: best.slice(0, 5) };
  };

  // 1. a stable attribute
  if (locator.fieldName) {
    const hit = decide(
      pool.filter((c) => c.fieldName === locator.fieldName && (!locator.inputType || !c.type || c.type === locator.inputType)),
      "attribute",
    );
    if (hit) return hit;
  } else if (locator.href) {
    const want = hrefKey(locator.href);
    const hit = want ? decide(pool.filter((c) => hrefKey(c.href) === want), "attribute") : null;
    if (hit) return hit;
  }

  // 2. role and name
  const name = norm(locator.name);
  if (name) {
    const sameRole = pool.filter((c) => c.role === locator.role);
    const exact = decide(sameRole.filter((c) => norm(c.name) === name), "role-name");
    if (exact) return exact;
    // 3. a close name in the same role (at least two shared words, or all of a one-word name)
    const scored = sameRole
      .map((c) => ({ c, s: overlap(locator.name, c.name) }))
      .filter((x) => x.s >= 0.75 && (tokens(locator.name).length === 1 || x.s * tokens(locator.name).length >= 2))
      .sort((a, b) => b.s - a.s);
    if (scored.length > 0) {
      const top = scored.filter((x) => x.s === scored[0].s).map((x) => x.c);
      const hit = decide(top, "fuzzy");
      if (hit) return hit;
    }
    // 4. the text alone (the role changed)
    const text = decide(pool.filter((c) => norm(c.name) === name), "text");
    if (text) return text;
  }
  return { ok: false, reason: "not_found", candidates: [] };
}
