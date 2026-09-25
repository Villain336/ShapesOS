// Marketr — Phase 6 L1: the citation-brief product (Tier 3 long-tail play).
//
// The Whitespark trick, built in-house: show exactly which directories the
// top-3 local competitors are listed on and the client isn't; pre-fill
// per-directory NAP payloads; track the manual-submission checklist; run a
// verification sweep that detects NAP drift. Priced as done-for-you or DIY —
// never as "automatic."

export interface DirectoryEntry {
  directory: string;
  prefilledNap: Record<string, string>;
  status: "pending" | "submitted" | "verified";
  verifiedAt: string | null;
}

/** Fixture: the long-tail directory catalog used for gap analysis. Marked as fixtures. */
export const DIRECTORY_FIXTURES: string[] = [
  "yelp", "facebook", "bbb", "tripadvisor", "healthgrades", "avvo", "houzz",
  "foursquare", "yellowpages", "mapquest", "citysearch", "merchantcircle",
  "chamberofcommerce", "hotfrog", "brownbook", "manta", "angieslist", "thumbtack",
];

/** Fixture: top-3 local competitors' directory presence vs. a client baseline. */
export interface CompetitorFixture {
  competitor: string;
  directories: string[];
}

export const COMPETITOR_GAP_FIXTURES: CompetitorFixture[] = [
  {
    competitor: "Competitor A (fixture)",
    directories: ["yelp", "facebook", "bbb", "tripadvisor", "foursquare", "yellowpages", "manta"],
  },
  {
    competitor: "Competitor B (fixture)",
    directories: ["yelp", "facebook", "bbb", "healthgrades", "mapquest", "hotfrog", "angieslist"],
  },
  {
    competitor: "Competitor C (fixture)",
    directories: ["yelp", "facebook", "bbb", "avvo", "houzz", "citysearch", "brownbook"],
  },
];

export interface CompetitorGap {
  directory: string;
  competitorsOn: string[];
  clientOn: boolean;
  priority: "high" | "medium" | "low";
}

/**
 * Competitor-gap analysis: directories the top-3 competitors are on that the
 * client is missing, ranked by how many competitors appear there.
 */
export function competitorGap(
  clientDirectories: string[],
  competitors: CompetitorFixture[] = COMPETITOR_GAP_FIXTURES,
): CompetitorGap[] {
  const client = new Set(clientDirectories.map((d) => d.toLowerCase()));
  const counts = new Map<string, string[]>();
  for (const c of competitors) {
    for (const d of c.directories) {
      const key = d.toLowerCase();
      if (client.has(key)) continue;
      if (!counts.has(key)) counts.set(key, []);
      counts.get(key)!.push(c.competitor);
    }
  }
  return [...counts.entries()]
    .map(([directory, competitorsOn]) => ({
      directory,
      competitorsOn,
      clientOn: false,
      priority: (competitorsOn.length >= 3 ? "high" : competitorsOn.length === 2 ? "medium" : "low") as "high" | "medium" | "low",
    }))
    .sort((a, b) => b.competitorsOn.length - a.competitorsOn.length || a.directory.localeCompare(b.directory));
}

/** Pre-fill a per-directory NAP payload from the client's canonical profile. */
export function prefillNapPayload(
  canonicalNap: { name?: string; address?: string; phone?: string; website?: string },
  directory: string,
): Record<string, string> {
  return {
    directory,
    name: canonicalNap.name ?? "",
    address: canonicalNap.address ?? "",
    phone: canonicalNap.phone ?? "",
    website: canonicalNap.website ?? "",
    note: "Manual submission: copy these fields exactly. Do not reformat the phone or address.",
  };
}

/** Build the tracked manual-submission checklist from a gap list. */
export function buildChecklist(
  gaps: CompetitorGap[],
  canonicalNap: { name?: string; address?: string; phone?: string; website?: string },
): DirectoryEntry[] {
  return gaps.map((g) => ({
    directory: g.directory,
    prefilledNap: prefillNapPayload(canonicalNap, g.directory),
    status: "pending",
    verifiedAt: null,
  }));
}

export function markDirectorySubmitted(entries: DirectoryEntry[], directory: string): DirectoryEntry[] {
  return entries.map((e) => (e.directory === directory && e.status === "pending" ? { ...e, status: "submitted" } : e));
}

export function markDirectoryVerified(entries: DirectoryEntry[], directory: string): DirectoryEntry[] {
  const now = new Date().toISOString();
  return entries.map((e) =>
    e.directory === directory && e.status !== "pending" ? { ...e, status: "verified", verifiedAt: now } : e,
  );
}

export interface NapDrift {
  directory: string;
  field: string;
  expected: string;
  observed: string;
}

export interface VerifySweepResult {
  sweptAt: string;
  directoriesChecked: number;
  drift: NapDrift[];
  clean: string[];
}

/**
 * Verification sweep: compare live snapshots against the pre-filled NAP
 * payloads and report drift per field. Drift = the listing no longer matches
 * the canonical NAP (aggregator overwrite, typo, stale phone).
 */
export function verifySweep(
  entries: DirectoryEntry[],
  liveSnapshots: Record<string, Record<string, string>>,
): VerifySweepResult {
  const drift: NapDrift[] = [];
  const clean: string[] = [];
  for (const entry of entries) {
    if (entry.status === "pending") continue;
    const live = liveSnapshots[entry.directory];
    if (!live) continue; // no snapshot — skip, don't invent drift
    let hasDrift = false;
    for (const field of ["name", "address", "phone", "website"] as const) {
      const expected = (entry.prefilledNap[field] ?? "").trim();
      const observed = (live[field] ?? "").trim();
      if (expected && observed && expected !== observed) {
        drift.push({ directory: entry.directory, field, expected, observed });
        hasDrift = true;
      }
    }
    if (!hasDrift) clean.push(entry.directory);
  }
  return {
    sweptAt: new Date().toISOString(),
    directoriesChecked: entries.filter((e) => e.status !== "pending").length,
    drift,
    clean,
  };
}

/** Brief-level checklist status derived from the entries. */
export function briefChecklistStatus(entries: DirectoryEntry[]): "draft" | "in_progress" | "verified" | "archived" {
  if (entries.length === 0) return "draft";
  if (entries.every((e) => e.status === "verified")) return "verified";
  if (entries.some((e) => e.status !== "pending")) return "in_progress";
  return "draft";
}
