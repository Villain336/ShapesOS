// ShapesOS — Phase 19B (WS=panel): Dress Rehearsal persona spec.
// Commercial layer (entitlement dress_rehearsal, Pro and above). Company-authored;
// see lib/panel/README.md for the licence boundary.
//
// Ported from the Pre Launch Panel prototype (src/persona/types.ts + the
// founder-edit half of src/persona/derive.ts). The spec is the founder's
// handle on a persona: veto and edit act on these fields, never on prose. The
// raw interview stays in the memory stream; the spec is derived from it.
//
// What changed versus the prototype:
//   * the hand-rolled validator is a zod schema (PersonaSpecSchema); the
//     issue paths keep the prototype's "identity.name" / "knownObjections[0].severity"
//     shape so error messages stay readable;
//   * founder edits are a zod schema too (PersonaEditsSchema), so a route can
//     parse untrusted JSON with the same rules the spec uses.
// Pure: no database, no model calls.

import { z } from "zod";

const nonEmpty = z.string().trim().min(1, "must be a non-empty string");
const unit = z.number({ error: "must be a number" }).min(0, "must be in [0, 1]").max(1, "must be in [0, 1]");

export const BigFiveSchema = z.object({
  openness: unit,
  conscientiousness: unit,
  extraversion: unit,
  agreeableness: unit,
  neuroticism: unit,
});
export type BigFive = z.infer<typeof BigFiveSchema>;

export const PersonaIdentitySchema = z.object({
  name: nonEmpty,
  role: nonEmpty,
  company: z.string().optional(),
  age: z.number().min(0, "must be in [0, 130]").max(130, "must be in [0, 130]").optional(),
  location: z.string().optional(),
});
export type PersonaIdentity = z.infer<typeof PersonaIdentitySchema>;

export const PersonaPreferencesSchema = z.object({
  likes: z.array(z.string()),
  dislikes: z.array(z.string()),
  interests: z.array(z.string()),
});
export type PersonaPreferences = z.infer<typeof PersonaPreferencesSchema>;

export const PersonaBehaviorsSchema = z.object({
  general: z.array(z.string()),
  routines: z.array(z.string()),
});
export type PersonaBehaviors = z.infer<typeof PersonaBehaviorsSchema>;

export const PersonaBudgetSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter ISO code (e.g. USD)"),
  monthlyMax: z.number().min(0, "must be >= 0").max(Number.MAX_SAFE_INTEGER),
  /** true = will never exceed monthlyMax, period. */
  hardCap: z.boolean(),
  notes: z.string().optional(),
});
export type PersonaBudget = z.infer<typeof PersonaBudgetSchema>;

export const ObjectionSeveritySchema = z.enum(["low", "medium", "high"], { error: 'must be "low", "medium" or "high"' });
export type ObjectionSeverity = z.infer<typeof ObjectionSeveritySchema>;

export const KnownObjectionSchema = z.object({
  text: nonEmpty,
  severity: ObjectionSeveritySchema,
  /** Interview transcript this objection was drawn from (the citation). */
  sourceTranscriptId: z.string().optional(),
});
export type KnownObjection = z.infer<typeof KnownObjectionSchema>;

export const PersonaSpecSchema = z.object({
  identity: PersonaIdentitySchema,
  /** What this person is trying to achieve (drives the walk). */
  goals: z.array(z.string()).min(1, "must not be empty"),
  occupation: nonEmpty,
  bigFive: BigFiveSchema,
  preferences: PersonaPreferencesSchema,
  skills: z.array(z.string()),
  beliefs: z.array(z.string()),
  behaviors: PersonaBehaviorsSchema,
  budget: PersonaBudgetSchema,
  /** 0 = credulous, 1 = hostile skeptic. */
  skepticism: unit,
  /** Objections known from calibration data — never invented. */
  knownObjections: z.array(KnownObjectionSchema),
  /** Interview transcripts this persona was calibrated on (citations). */
  sourceTranscriptIds: z.array(z.string()),
});
export type PersonaSpec = z.infer<typeof PersonaSpecSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

export class PersonaValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Invalid persona spec: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "PersonaValidationError";
    this.issues = issues;
  }
}

/** "knownObjections[0].severity" from zod's ["knownObjections", 0, "severity"]. */
function pathOf(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

/** Validate a full persona spec. Returns the issues (empty = valid). */
export function validatePersonaSpec(spec: unknown): ValidationIssue[] {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return [{ path: "", message: "spec must be an object" }];
  }
  const r = PersonaSpecSchema.safeParse(spec);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: pathOf(i.path), message: i.message }));
}

/** Throws PersonaValidationError when the spec is invalid. */
export function assertValidPersonaSpec(spec: unknown): asserts spec is PersonaSpec {
  const issues = validatePersonaSpec(spec);
  if (issues.length > 0) throw new PersonaValidationError(issues);
}

/** Parse untrusted JSON into a spec (drops unknown keys) or throw PersonaValidationError. */
export function parsePersonaSpec(spec: unknown): PersonaSpec {
  assertValidPersonaSpec(spec);
  return PersonaSpecSchema.parse(spec);
}

/**
 * Is this persona calibrated on interviews? The honesty rule ("no calibration
 * data → no verdicts") starts here: a persona without a source transcript can
 * walk a page but never receives a verdict (lib/panel/verdicts.ts).
 */
export function isCalibratedSpec(spec: Pick<PersonaSpec, "sourceTranscriptIds">): boolean {
  return spec.sourceTranscriptIds.some((id) => id.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/**
 * A composable persona element. Present fields merge into a base spec:
 * later fragments win on scalars, arrays union (deduped), objects merge
 * field by field. fragmentName / description are metadata only.
 */
export interface PersonaFragment {
  fragmentName: string;
  description?: string;
  identity?: Partial<PersonaIdentity>;
  goals?: string[];
  occupation?: string;
  bigFive?: Partial<BigFive>;
  preferences?: Partial<PersonaPreferences>;
  skills?: string[];
  beliefs?: string[];
  behaviors?: Partial<PersonaBehaviors>;
  budget?: Partial<PersonaBudget>;
  skepticism?: number;
  knownObjections?: KnownObjection[];
  sourceTranscriptIds?: string[];
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function union<T>(base: T[], add: T[] | undefined, key?: (t: T) => string): T[] {
  const seen = new Set(base.map((t) => (key ? key(t) : String(t))));
  const out = [...base];
  for (const item of add ?? []) {
    const k = key ? key(item) : String(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/** A deep copy of a spec (arrays and nested objects), never sharing the caller's objects. */
export function cloneSpec(base: PersonaSpec): PersonaSpec {
  return {
    identity: { ...base.identity },
    goals: [...base.goals],
    occupation: base.occupation,
    bigFive: { ...base.bigFive },
    preferences: {
      likes: [...base.preferences.likes],
      dislikes: [...base.preferences.dislikes],
      interests: [...base.preferences.interests],
    },
    skills: [...base.skills],
    beliefs: [...base.beliefs],
    behaviors: { general: [...base.behaviors.general], routines: [...base.behaviors.routines] },
    budget: { ...base.budget },
    skepticism: base.skepticism,
    knownObjections: base.knownObjections.map((o) => ({ ...o })),
    sourceTranscriptIds: [...base.sourceTranscriptIds],
  };
}

/** Merge fragments into a base spec (never mutates the base). */
export function mergeFragments(base: PersonaSpec, fragments: PersonaFragment[]): PersonaSpec {
  const merged = cloneSpec(base);
  for (const f of fragments) {
    if (f.identity) {
      for (const k of ["name", "role", "company", "age", "location"] as const) {
        const v = f.identity[k];
        if (v !== undefined) (merged.identity as Record<string, unknown>)[k] = v;
      }
    }
    if (f.goals !== undefined) merged.goals = union(merged.goals, f.goals);
    if (f.occupation !== undefined) merged.occupation = f.occupation;
    if (f.bigFive) {
      for (const trait of Object.keys(f.bigFive) as (keyof BigFive)[]) {
        const v = f.bigFive[trait];
        if (v !== undefined) merged.bigFive[trait] = clamp01(v);
      }
    }
    if (f.preferences) {
      for (const k of ["likes", "dislikes", "interests"] as const) {
        if (f.preferences[k] !== undefined) merged.preferences[k] = union(merged.preferences[k], f.preferences[k]);
      }
    }
    if (f.skills !== undefined) merged.skills = union(merged.skills, f.skills);
    if (f.beliefs !== undefined) merged.beliefs = union(merged.beliefs, f.beliefs);
    if (f.behaviors) {
      if (f.behaviors.general !== undefined) merged.behaviors.general = union(merged.behaviors.general, f.behaviors.general);
      if (f.behaviors.routines !== undefined) merged.behaviors.routines = union(merged.behaviors.routines, f.behaviors.routines);
    }
    if (f.budget) {
      for (const k of ["currency", "monthlyMax", "hardCap", "notes"] as const) {
        const v = f.budget[k];
        if (v !== undefined) (merged.budget as Record<string, unknown>)[k] = v;
      }
    }
    if (f.skepticism !== undefined) merged.skepticism = clamp01(f.skepticism);
    if (f.knownObjections !== undefined) merged.knownObjections = union(merged.knownObjections, f.knownObjections, (o) => o.text);
    if (f.sourceTranscriptIds !== undefined) merged.sourceTranscriptIds = union(merged.sourceTranscriptIds, f.sourceTranscriptIds);
  }
  return merged;
}

/** Built-in starter fragments (founders can compose their own). */
export const FRAGMENTS: Record<string, PersonaFragment> = {
  "hostile-cfo": {
    fragmentName: "hostile-cfo",
    description: "Demands ROI proof before anything else; allergic to vague claims.",
    occupation: "Chief Financial Officer",
    skepticism: 0.95,
    bigFive: { conscientiousness: 0.9, agreeableness: 0.2 },
    goals: ["cut costs", "prove ROI before any purchase"],
    preferences: { dislikes: ["vague marketing claims", "unpriced tiers"] },
    beliefs: ["Every purchase must pay for itself within one quarter"],
    knownObjections: [{ text: "Show me the ROI math or this conversation is over.", severity: "high" }],
  },
  "price-sensitive-bootstrapper": {
    fragmentName: "price-sensitive-bootstrapper",
    description: "Founder spending their own money; every dollar is scrutinized.",
    budget: { monthlyMax: 50, hardCap: true, notes: "Self-funded; no room for waste" },
    skepticism: 0.7,
    preferences: { dislikes: ["annual-only billing", "per-seat pricing"] },
    knownObjections: [{ text: "Why would I pay for this when the free tier covers my needs?", severity: "high" }],
  },
  "burned-by-competitor": {
    fragmentName: "burned-by-competitor",
    description: "Was misled by a competitor's claims before; trust must be earned.",
    skepticism: 0.85,
    beliefs: ["Vendor claims about setup time are lies until proven otherwise"],
    knownObjections: [{ text: "Your competitor also promised 'setup in 5 minutes'. It took 3 weeks.", severity: "high" }],
  },
};

// ---------------------------------------------------------------------------
// Founder edits (veto / refine)
// ---------------------------------------------------------------------------

/**
 * The founder's edit handle. Arrays replace wholesale (the founder's word is
 * authoritative); scalars overwrite; nested objects apply field by field.
 * Values are type-checked here; ranges are checked when the edited spec is
 * re-validated, so a bad edit is rejected loudly.
 */
export const PersonaEditsSchema = z
  .object({
    identity: PersonaIdentitySchema.partial().extend({ name: z.string().optional(), role: z.string().optional() }),
    goals: z.array(z.string()),
    occupation: z.string(),
    bigFive: z.object({ openness: z.number(), conscientiousness: z.number(), extraversion: z.number(), agreeableness: z.number(), neuroticism: z.number() }).partial(),
    preferences: z.object({ likes: z.array(z.string()), dislikes: z.array(z.string()), interests: z.array(z.string()) }).partial(),
    skills: z.array(z.string()),
    beliefs: z.array(z.string()),
    behaviors: z.object({ general: z.array(z.string()), routines: z.array(z.string()) }).partial(),
    budget: z.object({ currency: z.string(), monthlyMax: z.number(), hardCap: z.boolean(), notes: z.string() }).partial(),
    skepticism: z.number(),
    knownObjections: z.array(z.object({ text: z.string(), severity: z.string(), sourceTranscriptId: z.string().optional() })),
    sourceTranscriptIds: z.array(z.string()),
  })
  .partial();

export interface PersonaEdits {
  identity?: Partial<PersonaIdentity>;
  goals?: string[];
  occupation?: string;
  bigFive?: Partial<BigFive>;
  preferences?: Partial<PersonaPreferences>;
  skills?: string[];
  beliefs?: string[];
  behaviors?: Partial<PersonaBehaviors>;
  budget?: Partial<PersonaBudget>;
  skepticism?: number;
  knownObjections?: KnownObjection[];
  sourceTranscriptIds?: string[];
}

function applyPartial<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const out = { ...base };
  if (!patch) return out;
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const v = patch[key];
    if (v !== undefined) (out as Record<string, unknown>)[key as string] = v;
  }
  return out;
}

/** Apply founder edits and re-validate. Never mutates the input; throws PersonaValidationError. */
export function applyFounderEdits(spec: PersonaSpec, edits: PersonaEdits): PersonaSpec {
  const out: PersonaSpec = {
    identity: applyPartial(spec.identity, edits.identity),
    goals: [...(edits.goals ?? spec.goals)],
    occupation: edits.occupation ?? spec.occupation,
    bigFive: applyPartial(spec.bigFive, edits.bigFive),
    preferences: {
      likes: [...(edits.preferences?.likes ?? spec.preferences.likes)],
      dislikes: [...(edits.preferences?.dislikes ?? spec.preferences.dislikes)],
      interests: [...(edits.preferences?.interests ?? spec.preferences.interests)],
    },
    skills: [...(edits.skills ?? spec.skills)],
    beliefs: [...(edits.beliefs ?? spec.beliefs)],
    behaviors: {
      general: [...(edits.behaviors?.general ?? spec.behaviors.general)],
      routines: [...(edits.behaviors?.routines ?? spec.behaviors.routines)],
    },
    budget: applyPartial(spec.budget, edits.budget),
    skepticism: edits.skepticism ?? spec.skepticism,
    knownObjections: (edits.knownObjections ?? spec.knownObjections).map((o) => ({ ...o })),
    sourceTranscriptIds: [...(edits.sourceTranscriptIds ?? spec.sourceTranscriptIds)],
  };
  assertValidPersonaSpec(out);
  return out;
}
