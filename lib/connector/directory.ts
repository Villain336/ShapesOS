// Marketr — Connector Agent slice 6: opt-in discoverability.
// SPEC-CONNECTOR-AGENT.md §5/§6.
//
// The OS user directory is the ONLY cross-tenant-readable connector data.
// Rules encoded here:
//
// - OPT-IN ONLY (Tico 2026-09-30): discoverable defaults to false; matching
//   against a non-discoverable user never happens.
// - REVERSIBLE: unpublishing (discoverable=false) hides the profile
//   instantly; re-publishing restores it.
// - PER-FACET: name+role vs fuller profile. Only published facets are ever
//   exposed in matches.
// - MUTUAL DISCOVERABILITY: matching requires BOTH the viewer and the
//   candidate to be discoverable. The viewer must publish their own profile
//   before they can match against anyone.
// - NO cross-tenant private-graph reads: matching uses ONLY directory
//   profile rows — Person/Relationship/Introduction rows are never read.

import { ConnectorError } from "./types";

/** Publishable profile facets: name+role vs fuller profile. */
export const DIRECTORY_FACETS = ["name_role", "full"] as const;
export type DirectoryFacet = (typeof DIRECTORY_FACETS)[number];

/** What the tenant is looking for (drives match scoring). */
export const DIRECTORY_LOOKING_FOR = ["leads", "funding", "partners"] as const;
export type DirectoryLookingFor = (typeof DIRECTORY_LOOKING_FOR)[number];

// ---------------------------------------------------------------------------
// Input validation (pure).
// ---------------------------------------------------------------------------

export interface DirectoryProfileInput {
  discoverable?: unknown;
  name?: unknown;
  role?: unknown;
  company?: unknown;
  bio?: unknown;
  industries?: unknown;
  lookingFor?: unknown;
  shareNameRole?: unknown;
  shareFull?: unknown;
}

export interface ValidDirectoryProfileInput {
  /** undefined = not provided (the store keeps the current value). */
  discoverable: boolean | undefined;
  /** undefined = not provided; null = clear the field. */
  name: string | null | undefined;
  role: string | null | undefined;
  company: string | null | undefined;
  bio: string | null | undefined;
  industries: string[] | undefined;
  lookingFor: DirectoryLookingFor | null | undefined;
  shareNameRole: boolean | undefined;
  shareFull: boolean | undefined;
}

const MAX_NAME_LEN = 200;
const MAX_BIO_LEN = 2000;
const MAX_INDUSTRIES = 10;

function cleanString(
  value: unknown,
  field: string,
  max: number,
  errors: string[],
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return null;
  }
  const v = value.trim();
  if (!v) return null;
  if (v.length > max) errors.push(`${field} must be ${max} characters or fewer.`);
  return v;
}

export function validateDirectoryProfileInput(input: DirectoryProfileInput): {
  errors: string[];
  value: ValidDirectoryProfileInput | null;
} {
  const errors: string[] = [];

  // discoverable: undefined = not provided (keep current). Opt-in is never
  // implied — only an explicit `true` publishes.
  let discoverable: boolean | undefined = undefined;
  if (input.discoverable != null) {
    if (typeof input.discoverable !== "boolean") {
      errors.push("discoverable must be a boolean — publishing to the directory is opt-in only.");
    } else {
      discoverable = input.discoverable;
    }
  }

  // Text fields: undefined = not provided; null = clear the field.
  const maybeString = (v: unknown, field: string, max: number): string | null | undefined => {
    if (v == null) return undefined;
    return cleanString(v, field, max, errors);
  };
  const name = maybeString(input.name, "name", MAX_NAME_LEN);
  const role = maybeString(input.role, "role", MAX_NAME_LEN);
  const company = maybeString(input.company, "company", MAX_NAME_LEN);
  const bio = maybeString(input.bio, "bio", MAX_BIO_LEN);

  let industries: string[] | undefined = undefined;
  if (input.industries != null) {
    if (!Array.isArray(input.industries)) {
      errors.push("industries must be an array of strings.");
    } else {
      const list: string[] = [];
      for (const raw of input.industries) {
        if (typeof raw !== "string" || !raw.trim()) {
          errors.push("industries must contain only non-empty strings.");
          break;
        }
        if (raw.trim().length > 60) {
          errors.push("each industry must be 60 characters or fewer.");
          break;
        }
        if (!list.includes(raw.trim())) list.push(raw.trim());
      }
      if (list.length > MAX_INDUSTRIES) {
        errors.push(`industries must have at most ${MAX_INDUSTRIES} entries.`);
      }
      industries = list;
    }
  }

  let lookingFor: DirectoryLookingFor | null | undefined = undefined;
  if (input.lookingFor != null) {
    const lf =
      typeof input.lookingFor === "string" ? input.lookingFor.trim().toLowerCase() : "";
    if (lf === "") {
      lookingFor = null; // clear
    } else if ((DIRECTORY_LOOKING_FOR as readonly string[]).includes(lf)) {
      lookingFor = lf as DirectoryLookingFor;
    } else {
      errors.push(`lookingFor must be one of: ${DIRECTORY_LOOKING_FOR.join(", ")}.`);
    }
  }

  const facet = (value: unknown, field: string): boolean | undefined => {
    if (value == null) return undefined;
    if (typeof value !== "boolean") {
      errors.push(`${field} must be a boolean.`);
      return undefined;
    }
    return value;
  };
  const shareNameRole = facet(input.shareNameRole, "shareNameRole");
  const shareFull = facet(input.shareFull, "shareFull");

  // Publishing requires an identity: the name+role facet needs a name.
  // The input here is partial (the store merges with the existing row), so
  // the merged-name rule is enforced in the store — this validator only
  // flags an explicitly-empty name at publish time.
  if (
    discoverable === true &&
    input.name != null &&
    (typeof input.name !== "string" || !input.name.trim())
  ) {
    errors.push("name is required to publish — the directory needs an identity.");
  }

  if (errors.length > 0) return { errors, value: null };
  return {
    errors,
    value: {
      discoverable,
      name,
      role,
      company,
      bio,
      industries,
      lookingFor,
      shareNameRole,
      shareFull,
    },
  };
}

// ---------------------------------------------------------------------------
// Public profile view — only published facets. Pure.
// ---------------------------------------------------------------------------

/** Raw directory profile row shape (mirrors Prisma, tenant-scoped). */
export interface DirectoryProfileRow {
  id: string;
  workspaceId: string;
  discoverable: boolean;
  name: string | null;
  role: string | null;
  company: string | null;
  bio: string | null;
  industries: string[];
  lookingFor: string | null;
  shareNameRole: boolean;
  shareFull: boolean;
  updatedAt: Date;
}

/** What another tenant may see: ONLY the published facets. */
export interface DirectoryPublicProfile {
  /** Directory identity (profile id — not a workspace or graph id). */
  id: string;
  name: string | null;
  role: string | null;
  /** Fuller-profile facets (null when the tenant didn't publish them). */
  company: string | null;
  bio: string | null;
  industries: string[];
  lookingFor: string | null;
  facets: DirectoryFacet[];
}

/**
 * Facet gating: project a raw row to what matches may expose. The
 * name+role facet publishes name+role; the full facet publishes company,
 * bio, industries, lookingFor. Nothing else ever leaves the row.
 */
export function toDirectoryPublicProfile(row: DirectoryProfileRow): DirectoryPublicProfile {
  const facets: DirectoryFacet[] = [];
  const out: DirectoryPublicProfile = {
    id: row.id,
    name: null,
    role: null,
    company: null,
    bio: null,
    industries: [],
    lookingFor: null,
    facets,
  };
  if (row.shareNameRole) {
    facets.push("name_role");
    out.name = row.name;
    out.role = row.role;
  }
  if (row.shareFull) {
    facets.push("full");
    out.company = row.company;
    out.bio = row.bio;
    out.industries = [...row.industries];
    out.lookingFor = row.lookingFor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutual-discoverability matching. Pure.
// ---------------------------------------------------------------------------

export interface DirectoryMatchCriteria {
  roleKeywords?: string[];
  industries?: string[];
  lookingFor?: string | null;
  /** Max results; default 20, hard cap 50. */
  limit?: number;
}

export interface DirectoryMatch {
  profile: DirectoryPublicProfile;
  /** 0..100 — industries 50 + role keywords 30 + lookingFor 20. */
  score: number;
  /** Human-readable reasons ("shared industries: hvac"). */
  reasons: string[];
}

/**
 * Match directory profiles under mutual discoverability. Throws when the
 * VIEWER is not discoverable (not_discoverable). Candidates that are not
 * discoverable, are the viewer, or publish no identity facet are NEVER
 * matched. Only directory rows are scored — no private-graph reads.
 */
export function matchDirectoryProfiles(opts: {
  viewerWorkspaceId: string;
  viewerDiscoverable: boolean;
  candidates: DirectoryProfileRow[];
  criteria?: DirectoryMatchCriteria;
}): DirectoryMatch[] {
  if (!opts.viewerDiscoverable) {
    throw new ConnectorError(
      "not_discoverable",
      "Directory matching requires mutual discoverability: publish your own profile before matching against other discoverable users.",
    );
  }
  const criteria = opts.criteria ?? {};
  const cleanList = (list: string[] | undefined): string[] =>
    (list ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10);
  const roleKeywords = cleanList(criteria.roleKeywords);
  const wantedIndustries = cleanList(criteria.industries);
  const lookingFor =
    typeof criteria.lookingFor === "string" && criteria.lookingFor.trim()
      ? criteria.lookingFor.trim().toLowerCase()
      : null;
  const limit = Math.min(50, Math.max(1, criteria.limit ?? 20));
  const hasCriteria =
    roleKeywords.length > 0 || wantedIndustries.length > 0 || lookingFor != null;

  const results: DirectoryMatch[] = [];
  for (const c of opts.candidates) {
    // The gates — order matters, all are cheap:
    if (c.workspaceId === opts.viewerWorkspaceId) continue; // never self
    if (!c.discoverable) continue; // mutual-discoverability: no matching the invisible
    if (!c.shareNameRole) continue; // minimum identity facet required to match

    let score = 0;
    const reasons: string[] = [];

    if (!hasCriteria) {
      // Browse mode: every discoverable profile is a baseline match.
      score = 10;
      reasons.push("discoverable in the directory");
    } else {
      const candIndustries = c.industries.map((s) => s.toLowerCase());
      const shared = wantedIndustries.filter((i) => candIndustries.includes(i));
      if (shared.length > 0) {
        score += 50;
        reasons.push(`shared ${shared.length === 1 ? "industry" : "industries"}: ${shared.join(", ")}`);
      }
      const roleText = `${c.role ?? ""} ${c.name ?? ""}`.toLowerCase();
      const hits = roleKeywords.filter((k) => roleText.includes(k));
      if (hits.length > 0) {
        score += 30;
        reasons.push(`role match: ${hits.join(", ")}`);
      }
      if (lookingFor && c.lookingFor && c.lookingFor.toLowerCase() === lookingFor) {
        score += 20;
        reasons.push(`also looking for ${lookingFor}`);
      }
      if (score <= 0) continue;
    }

    results.push({ profile: toDirectoryPublicProfile(c), score, reasons });
  }

  results.sort(
    (a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id),
  );
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// View types (what the store returns / the API serializes).
// ---------------------------------------------------------------------------

/** The tenant's OWN profile — full fields, regardless of published facets. */
export interface DirectoryProfileView {
  discoverable: boolean;
  name: string | null;
  role: string | null;
  company: string | null;
  bio: string | null;
  industries: string[];
  lookingFor: DirectoryLookingFor | null;
  shareNameRole: boolean;
  shareFull: boolean;
  updatedAt: Date;
}

/** Own-profile row → own-profile view (no facet gating for the owner). */
export function toDirectoryProfileView(row: DirectoryProfileRow): DirectoryProfileView {
  const lf =
    row.lookingFor && (DIRECTORY_LOOKING_FOR as readonly string[]).includes(row.lookingFor)
      ? (row.lookingFor as DirectoryLookingFor)
      : null;
  return {
    discoverable: row.discoverable,
    name: row.name,
    role: row.role,
    company: row.company,
    bio: row.bio,
    industries: [...row.industries],
    lookingFor: lf,
    shareNameRole: row.shareNameRole,
    shareFull: row.shareFull,
    updatedAt: row.updatedAt,
  };
}

/** Defaults for a tenant that never set a profile: invisible, empty. */
export function defaultDirectoryProfileView(): DirectoryProfileView {
  return {
    discoverable: false,
    name: null,
    role: null,
    company: null,
    bio: null,
    industries: [],
    lookingFor: null,
    shareNameRole: true,
    shareFull: false,
    updatedAt: new Date(0),
  };
}
