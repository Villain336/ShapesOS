// Marketr — Phase 13D Worker B: pronunciation dictionary.
//
// Per-workspace pronunciation dictionary (product names, people) applied to
// voiceover scripts BEFORE synthesis so the TTS engine says brand terms
// correctly. Seeded from the 13B company knowledge graph; human-editable
// after seeding.
//
// SUBSTITUTION CONTRACT (applyPronunciation):
//   - Entries are applied longest-term-first, case-insensitively, on
//     word boundaries (\b…\b), so "ProMax" never corrupts "ProMax Plus"
//     and "ai" never rewrites "said".
//   - The phonetic text REPLACES the term verbatim in the script; the
//     returned script is what gets sent to VoiceStudio.
//   - The job records the applied snapshot [{term, phonetic}] on
//     VoiceoverJob.pronunciation for audit/reproducibility.
//   - TTS engines (VoiceStudio) have no SSML phoneme tag on the
//     OpenAI-compatible path, so "phonetic" here is a plain-text respelling
//     the engine reads naturally (e.g. term "Marketr" → "marketer").

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { BadRequestError } from "@/lib/api/errors";

export interface PronunciationEntryInput {
  term: string;
  phonetic: string;
  source?: "knowledge_graph" | "manual";
}

export interface PronunciationEntryRow {
  id: string;
  term: string;
  phonetic: string;
  source: string;
  updatedAt: Date;
}

const entrySelect = {
  id: true,
  term: true,
  phonetic: true,
  source: true,
  updatedAt: true,
} as const;

function normTerm(term: string): string {
  return term.trim();
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function listEntries(
  workspaceId: string,
): Promise<PronunciationEntryRow[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.pronunciationEntry.findMany({
      where: { workspaceId },
      orderBy: { term: "asc" },
      select: entrySelect,
    }),
  );
}

export async function upsertEntry(
  workspaceId: string,
  input: PronunciationEntryInput,
): Promise<PronunciationEntryRow> {
  const term = normTerm(input.term);
  const phonetic = input.phonetic.trim();
  if (!term) throw new BadRequestError("Pronunciation term is required.");
  if (!phonetic) throw new BadRequestError("Phonetic respelling is required.");
  if (term.length > 120 || phonetic.length > 200) {
    throw new BadRequestError("Term/phonetic too long.");
  }
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.pronunciationEntry.upsert({
      where: { workspaceId_term: { workspaceId, term } },
      create: {
        workspaceId,
        term,
        phonetic,
        source: input.source ?? "manual",
      },
      update: { phonetic, source: input.source ?? "manual" },
      select: entrySelect,
    }),
  );
}

export async function deleteEntry(
  workspaceId: string,
  entryId: string,
): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.pronunciationEntry.deleteMany({ where: { id: entryId, workspaceId } }),
  );
}

// ── Seeding from the 13B knowledge graph ───────────────────────────────────
//
// Sources: CompanyKnowledge titles for kinds product / competitor / pillar /
// audience (these carry the brand's product, people, and market names), plus
// the BrandVoiceProfile vocabulary list. phonetic = term by default; the
// human edits the respelling after.
//
// Idempotent: @@unique([workspaceId, term]) — re-seeding never duplicates.

interface SeedResult {
  inserted: number;
  skippedExisting: number;
  terms: string[];
}

const STOPWORDS = new Set(
  "the,a,an,of,for,and,to,in,on,with,our,we,you,your,by,at,from,as,is,are,vs,that,this,these,those,via,per,pro,plus,max,mini,lite,go,new,all,any,each,every,more,most,less,least,only,just,like,how,why,what,when,where,which,who,whom,whose,will,would,can,could,should,may,might,must,shall,do,does,did,done,be,been,being,have,has,had,having,not,no,nor,so,such,than,then,there,their,them,they,its,it,into,over,under,about,between,through,during,before,after,above,below,between,out,up,down,off,again,once,here,now,today,tm,inc,llc,co,ltd,corp".split(
    ",",
  ),
);

/** Candidate brand-ish terms: capitalized words / CamelCase / ALLCAPS tokens. */
function candidateTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;|/()—–:"]+/)) {
    const token = raw.trim();
    if (token.length < 2 || token.length > 60) continue;
    if (STOPWORDS.has(token.toLowerCase())) continue;
    if (/^[A-Z][a-zA-Z0-9'.-]*$/.test(token) || /^[A-Z]{2,}[0-9]*$/.test(token)) {
      out.push(token.replace(/[.'-]+$/, ""));
    }
  }
  return out;
}

export async function seedFromKnowledgeGraph(
  workspaceId: string,
): Promise<SeedResult> {
  const terms = new Set<string>();

  // Product / competitor / pillar / audience names from the 13B knowledge
  // graph — the structured company knowledge document (spec §2).
  const knowledge = await withWorkspaceScope(workspaceId, (tx) =>
    tx.companyKnowledge.findMany({
      where: {
        workspaceId,
        kind: { in: ["product", "competitor", "pillar", "audience"] },
      },
      select: { title: true, body: true },
    }),
  );
  for (const k of knowledge) {
    for (const t of candidateTerms(k.title ?? "")) terms.add(t);
    const body = k.body as Record<string, unknown> | null;
    if (body && typeof body === "object") {
      for (const key of ["name", "company", "brand", "founder"]) {
        const v = body[key];
        if (typeof v === "string") {
          for (const t of candidateTerms(v)) terms.add(t);
        }
      }
    }
  }

  // BrandVoiceProfile learned vocabulary (may carry product-flavored terms).
  try {
    const profile = await withWorkspaceScope(workspaceId, (tx) =>
      tx.brandVoiceProfile.findUnique({ where: { workspaceId } }),
    );
    const dims = profile?.dimensions as { vocabulary?: unknown } | null;
    if (dims && Array.isArray(dims.vocabulary)) {
      for (const v of dims.vocabulary) {
        if (typeof v === "string") {
          for (const t of candidateTerms(v)) terms.add(t);
        }
      }
    }
  } catch {
    // Brand voice profile is optional input; never fail the seed on it.
  }

  let inserted = 0;
  let skippedExisting = 0;
  const rows = [...terms].map((term) => ({
    workspaceId,
    term,
    phonetic: term, // human-editable after seeding
    source: "knowledge_graph",
  }));
  if (rows.length > 0) {
    // @@unique([workspaceId, term]) — skipDuplicates makes re-seeding a
    // no-op for existing terms: no duplicates, ever.
    const res = await withWorkspaceScope(workspaceId, (tx) =>
      tx.pronunciationEntry.createMany({ data: rows, skipDuplicates: true }),
    );
    inserted = res.count;
    skippedExisting = rows.length - res.count;
  }
  return { inserted, skippedExisting, terms: [...terms] };
}

// ── Substitution ─────────────────────────────────────────────────────────

export interface AppliedPronunciation {
  term: string;
  phonetic: string;
}

export interface PronunciationApplied {
  script: string;
  applied: AppliedPronunciation[];
}

/** Escape for RegExp literal use. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substitute phonetics into the script per the substitution contract above.
 * Longest-term-first, case-insensitive, word-boundary matching.
 */
export function applyPronunciation(
  script: string,
  entries: { term: string; phonetic: string }[],
): PronunciationApplied {
  const sorted = [...entries]
    .filter((e) => e.term.trim() && e.phonetic.trim())
    .sort((a, b) => b.term.length - a.term.length);
  const applied: AppliedPronunciation[] = [];
  let out = script;
  for (const e of sorted) {
    const term = e.term.trim();
    const re = new RegExp(`\\b${esc(term)}\\b`, "gi");
    if (re.test(out)) {
      out = out.replace(re, e.phonetic.trim());
      applied.push({ term, phonetic: e.phonetic.trim() });
    }
  }
  return { script: out, applied };
}
