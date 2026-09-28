// Marketr — Phase 13B Worker 4: Brand Voice engine.
//
// Learns tone/style from the workspace's own content samples: vocabulary,
// sentence rhythm, formality, POV, humor. Pure heuristic analysis
// (analyzeSamples) — deterministic, no LLM call — so derivation is cheap and
// reproducible; the LLM-polished layer can sit on top later.
//
// Persistence (BrandVoiceProfile) and seed collection live here too; the API
// routes are thin wrappers around them.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { collectAllFiles, getSiteIdeProvider } from "@/lib/connectors/source";

/** Prisma JSON input cast for our structured dimension objects. */
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/** The dimensions JSON shape — see docs/phases/13b/DATA-MODEL.md contract. */
export interface VoiceDimensions {
  vocabulary: string[];
  rhythm: string;
  formality: string;
  pov: string;
  humor: string;
  doExamples: string[];
  dontExamples: string[];
}

export const EMPTY_DIMENSIONS: VoiceDimensions = {
  vocabulary: [],
  rhythm: "",
  formality: "",
  pov: "",
  humor: "",
  doExamples: [],
  dontExamples: [],
};

// ---------------------------------------------------------------------------
// Pure analysis (DB-free; unit-tested)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a,about,above,after,again,against,all,also,am,an,and,any,are,as,at,be," +
    "because,been,before,being,below,between,both,but,by,can,cannot,could," +
    "did,do,does,doing,down,during,each,even,every,few,for,from,further,had," +
    "has,have,having,he,her,here,hers,herself,him,himself,his,how,i,if,in," +
    "into,is,it,its,itself,just,like,make,made,may,me,more,most,must,my," +
    "myself,no,nor,not,now,of,off,on,once,only,or,other,ought,our,ours," +
    "ourselves,out,over,own,same,she,should,so,some,such,than,that,the," +
    "their,theirs,them,themselves,then,there,these,they,this,those,through," +
    "to,too,under,until,up,very,was,we,were,what,when,where,which,while,who," +
    "whom,why,with,would,you,your,yours,yourself,yourselves,will,well,one," +
    "two,new,way,get,let,us,let's,it's,that's,there's,don't,doesn't,didn't," +
    "can't,won't,isn't,aren't,wasn't,weren't,haven't,hasn't,hadn't,couldn't," +
    "shouldn't,wouldn't,might,mustn't,need,needs,needed,today,tomorrow,yesterday"
  ).split(","),
);

const FORMAL_MARKERS = [
  "therefore",
  "furthermore",
  "moreover",
  "nevertheless",
  "notwithstanding",
  "hereby",
  "pursuant",
  "utilize",
  "commence",
  "dear sir",
  "dear madam",
  "sincerely",
  "kind regards",
  "warm regards",
  "shall",
  "herein",
  "aforementioned",
];

const CASUAL_MARKERS = [
  "hey",
  "yeah",
  "yep",
  "gonna",
  "wanna",
  "awesome",
  "cool",
  "super ",
  "btw",
  "lol",
  "haha",
  "let's dive",
  "quick win",
];

const CONTRACTIONS = [
  "don't",
  "doesn't",
  "didn't",
  "can't",
  "won't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "it's",
  "that's",
  "there's",
  "you're",
  "we're",
  "they're",
  "i'm",
  "let's",
  "you'll",
  "we'll",
  "couldn't",
  "shouldn't",
  "wouldn't",
];

const HUMOR_MARKERS = [
  "haha",
  "lol",
  "joke",
  "funny",
  "laugh",
  "wink",
  "cheeky",
  "quirky",
  "playful",
  "pun",
  "😂",
  "😉",
];

function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/[.!?…]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'\-]*/g) ?? []).map((w) =>
    w.replace(/^['\-]+|['\-]+$/g, ""),
  );
}

function countMarker(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function pickDoExamples(sentences: string[]): string[] {
  // Representative sentences: closest to the median length, deduped.
  const scored = sentences
    .filter((s) => s.length <= 220)
    .map((s) => ({ s, len: s.split(/\s+/).length }));
  if (scored.length === 0) return [];
  const lens = scored.map((x) => x.len).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)]!;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of scored
    .slice()
    .sort((a, b) => Math.abs(a.len - median) - Math.abs(b.len - median))) {
    const key = x.s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x.s.slice(0, 160));
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Heuristic voice analysis over raw text samples. Deterministic:
 * same samples → same dimensions.
 */
export function analyzeSamples(samples: string[]): VoiceDimensions {
  const texts = samples.map((s) => s.trim()).filter((s) => s.length >= 40);
  if (texts.length === 0) return { ...EMPTY_DIMENSIONS };

  const combined = texts.join("\n");
  const lower = combined.toLowerCase();
  const sents = texts.flatMap(sentencesOf);
  const words = wordsOf(lower).filter((w) => w.length >= 4 && !STOPWORDS.has(w));

  // --- vocabulary: top distinctive words by frequency ---
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const vocabulary = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([w]) => w);

  // --- rhythm: mean sentence length in words ---
  const wordCounts = sents.map((s) => s.split(/\s+/).length);
  const avgLen =
    wordCounts.length > 0
      ? wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length
      : 0;
  const rhythm =
    avgLen < 10
      ? `short and punchy — sentences average ${avgLen.toFixed(0)} words`
      : avgLen <= 18
        ? `balanced — sentences average ${avgLen.toFixed(0)} words`
        : `long and flowing — sentences average ${avgLen.toFixed(0)} words`;

  // --- formality ---
  const formal = FORMAL_MARKERS.reduce((n, m) => n + countMarker(lower, m), 0);
  const casual =
    CASUAL_MARKERS.reduce((n, m) => n + countMarker(lower, m), 0) +
    CONTRACTIONS.reduce((n, m) => n + countMarker(lower, m), 0) * 0.5;
  const excl = (combined.match(/!/g) ?? []).length;
  const formalityScore = formal - casual - excl * 0.25;
  const formality =
    formalityScore >= 2
      ? "formal — precise, professional diction; avoids contractions"
      : formalityScore <= -3
        ? "casual — conversational, contractions and exclamations welcome"
        : "business-casual — warm and direct, professional but not stiff";

  // --- POV ---
  const povCounts: Array<[string, number, string]> = [
    ["first-person plural (we/our)", countMarker(lower, " we ") + countMarker(lower, " our ") + countMarker(lower, " us "), "Don't switch to a detached third-person voice; keep the collective \"we\"."],
    ["second person (you/your)", countMarker(lower, " you ") + countMarker(lower, " your "), "Don't narrate from the sidelines; speak directly to the reader as \"you\"."],
    ["first-person singular (I/my)", countMarker(lower, " i ") + countMarker(lower, " my "), "Don't dilute the personal voice with a corporate \"we\"."],
    ["third person", countMarker(lower, " they ") + countMarker(lower, " their ") + countMarker(lower, " the company "), "Don't get chummy with \"we\"/\"you\"; keep a neutral third-person distance."],
  ];
  povCounts.sort((a, b) => b[1] - a[1]);
  const pov = povCounts[0]![1] > 0 ? povCounts[0]![0] : "mixed / no dominant POV";

  // --- humor ---
  const humorHits = HUMOR_MARKERS.reduce((n, m) => n + countMarker(lower, m), 0);
  const humor =
    humorHits >= 3 || excl >= Math.max(3, sents.length * 0.4)
      ? "playful — exclamation, energy, light jokes land here"
      : humorHits >= 1
        ? "dry wit — occasional wry aside, never slapstick"
        : "serious and straightforward — no jokes, let the substance carry it";

  // --- dont examples: the opposites of what the voice is ---
  const dontExamples: string[] = [];
  if (avgLen < 10)
    dontExamples.push("Don't write long, winding sentences — keep it tight and punchy.");
  else if (avgLen > 18)
    dontExamples.push("Don't chop the rhythm into fragments — let sentences breathe.");
  if (formality.startsWith("formal"))
    dontExamples.push('Don\'t use slang or contractions ("gonna", "awesome").');
  else if (formality.startsWith("casual"))
    dontExamples.push('Don\'t use stiff corporate language ("pursuant to", "hereby").');
  if (pov.startsWith("first-person plural"))
    dontExamples.push("Don't switch to a detached third-person voice.");
  else if (pov.startsWith("second person"))
    dontExamples.push("Don't narrate from the sidelines — address the reader directly.");
  if (humor.startsWith("serious"))
    dontExamples.push("Don't crack jokes or force playfulness; stay measured.");
  else if (humor.startsWith("playful"))
    dontExamples.push("Don't be dry and corporate — bring the energy.");

  return {
    vocabulary,
    rhythm,
    formality,
    pov,
    humor,
    doExamples: pickDoExamples(sents),
    dontExamples: dontExamples.slice(0, 4),
  };
}

/** 0..1 confidence in a derivation, driven by sample volume. */
export function derivationConfidence(samples: string[]): number {
  const words = samples.reduce((n, s) => n + wordsOf(s).length, 0);
  if (words < 200) return 0.3;
  if (words < 1000) return 0.6;
  if (words < 3000) return 0.8;
  return 0.9;
}

// ---------------------------------------------------------------------------
// Seed collection: website content + existing campaigns/docs
// ---------------------------------------------------------------------------

export interface VoiceSeed {
  samples: string[];
  sources: string[];
}

const TEXT_EXTS = new Set([".html", ".htm", ".md", ".mdx", ".txt"]);

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Seed samples from the workspace's own content:
 *  1. website content (site IDE working copies — text files, tags stripped)
 *  2. existing campaigns (names + stage copy)
 *  3. existing content docs (ContentItem drafts/published bodies)
 *
 * Returns samples + human-readable provenance strings (stored in
 * BrandVoiceProfile.derivedFrom per the data-model contract).
 */
export async function collectVoiceSeedSamples(
  workspaceId: string,
): Promise<VoiceSeed> {
  const samples: string[] = [];
  const sources: string[] = [];

  await withWorkspaceScope(workspaceId, async (tx) => {
    // 1. Website content via the site IDE provider (local working copies).
    try {
      const sites = await tx.site.findMany({
        where: { project: { workspaceId } },
        select: { id: true, name: true },
        take: 5,
      });
      for (const site of sites) {
        try {
          const provider = await getSiteIdeProvider({ id: site.id } as never);
          const files = await collectAllFiles(provider);
          const textFiles = files
            .filter((f) => {
              const dot = f.lastIndexOf(".");
              return dot >= 0 && TEXT_EXTS.has(f.slice(dot).toLowerCase());
            })
            .slice(0, 12);
          for (const f of textFiles) {
            try {
              const read = await provider.readFile(f);
              const text = stripTags(read.content).slice(0, 4000);
              if (text.length >= 200) {
                samples.push(text);
                sources.push(`site:${site.name}:${f}`);
              }
            } catch {
              /* unreadable file — skip */
            }
          }
        } catch {
          /* site working copy unavailable — skip */
        }
      }
    } catch {
      /* sites unavailable — campaigns/docs still seed the profile */
    }

    // 2. Campaigns: names + stage copy.
    const campaigns = await tx.growthCampaign.findMany({
      where: { workspaceId },
      select: { name: true, stages: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    for (const c of campaigns) {
      const stageText = Array.isArray(c.stages)
        ? c.stages
            .map((s) =>
              typeof s === "object" && s !== null
                ? Object.values(s as Record<string, unknown>)
                    .filter((v) => typeof v === "string")
                    .join(" ")
                : "",
            )
            .join(" ")
        : "";
      const doc = `${c.name}. ${stageText}`.trim();
      if (doc.length >= 60) {
        samples.push(doc.slice(0, 2000));
        sources.push(`campaign:${c.name}`);
      }
    }

    // 3. Content docs: existing drafts / published bodies.
    const items = await tx.contentItem.findMany({
      where: { project: { workspaceId }, bodyMarkdown: { not: null } },
      select: { bodyMarkdown: true },
      orderBy: { updatedAt: "desc" },
      take: 15,
    });
    for (const item of items) {
      const body = (item.bodyMarkdown ?? "").slice(0, 4000);
      if (body.length >= 200) {
        samples.push(body);
        sources.push("content_item");
      }
    }
  });

  return { samples, sources };
}

// ---------------------------------------------------------------------------
// Persistence helpers (all RLS-scoped)
// ---------------------------------------------------------------------------

export interface DerivedVoice {
  dimensions: VoiceDimensions;
  derivedFrom: { samples: string[]; editCount: number; lastDerivedAt: string };
  confidence: number;
}

export async function getVoiceProfile(workspaceId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.brandVoiceProfile.findUnique({ where: { workspaceId } }),
  );
}

/**
 * Derive (or re-derive) the voice profile from explicit samples or, when
 * omitted, from the workspace's own content. Honors the pin: a pinned
 * profile is read-only to the learner — derivation results land in
 * pendingUpdates for user review instead of overwriting dimensions.
 */
export async function deriveAndStoreVoiceProfile(
  workspaceId: string,
  samples?: string[],
  editCount = 0,
): Promise<DerivedVoice & { applied: boolean }> {
  let seed = samples;
  let sourceLabels: string[];
  if (!seed || seed.length === 0) {
    const collected = await collectVoiceSeedSamples(workspaceId);
    seed = collected.samples;
    sourceLabels = collected.sources;
  } else {
    sourceLabels = seed.map((_, i) => `provided_sample_${i + 1}`);
  }
  if (seed.length === 0) {
    throw new Error("No content samples available to derive a voice profile.");
  }

  const dimensions = analyzeSamples(seed);
  const confidence = derivationConfidence(seed);
  const derivedFrom = {
    samples: sourceLabels,
    editCount,
    lastDerivedAt: new Date().toISOString(),
  };

  const existing = await getVoiceProfile(workspaceId);
  const pendingShape = {
    proposedAt: new Date().toISOString(),
    dimensions,
    rationale: `Re-derived from ${seed.length} sample(s).`,
  };

  if (existing?.pinnedByUser) {
    // Pinned = read-only to the learner: proposal goes to pendingUpdates.
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.brandVoiceProfile.update({
        where: { workspaceId },
        data: { pendingUpdates: json(pendingShape) },
      }),
    );
    return { dimensions, derivedFrom, confidence, applied: false };
  }

  await withWorkspaceScope(workspaceId, (tx) =>
    tx.brandVoiceProfile.upsert({
      where: { workspaceId },
      update: { dimensions: json(dimensions), derivedFrom: json(derivedFrom), confidence, pendingUpdates: Prisma.JsonNull },
      create: { workspaceId, dimensions: json(dimensions), derivedFrom: json(derivedFrom), confidence },
    }),
  );
  return { dimensions, derivedFrom, confidence, applied: true };
}

/** Apply pendingUpdates (user accept) — merges into dimensions, clears pending. */
export async function approvePendingVoiceUpdates(workspaceId: string) {
  const existing = await getVoiceProfile(workspaceId);
  if (!existing) throw new Error("No voice profile for this workspace.");
  const pending = existing.pendingUpdates as unknown as {
    dimensions?: Partial<VoiceDimensions>;
  } | null;
  if (!pending?.dimensions) throw new Error("No pending updates to approve.");
  const merged: VoiceDimensions = {
    ...(existing.dimensions as unknown as VoiceDimensions),
    ...pending.dimensions,
  };
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.brandVoiceProfile.update({
      where: { workspaceId },
      data: { dimensions: json(merged), pendingUpdates: Prisma.JsonNull, confidence: 0.95 },
    }),
  );
}

/** Reject (discard) the learner's pending voice updates. */
export async function rejectPendingVoiceUpdates(workspaceId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.brandVoiceProfile.update({
      where: { workspaceId },
      data: { pendingUpdates: Prisma.JsonNull },
    }),
  );
}

/** Manual dimension update (user edit, not learner derivation). */
export async function updateVoiceDimensions(
  workspaceId: string,
  partial: Partial<VoiceDimensions>,
) {
  const existing = await getVoiceProfile(workspaceId);
  const base: VoiceDimensions = existing
    ? (existing.dimensions as unknown as VoiceDimensions)
    : { ...EMPTY_DIMENSIONS };
  const merged = { ...base, ...partial };
  const editProvenance = {
    samples: ["manual_edit"],
    editCount: 0,
    lastDerivedAt: new Date().toISOString(),
  };
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.brandVoiceProfile.upsert({
      where: { workspaceId },
      update: {
        dimensions: json(merged),
        derivedFrom: json(editProvenance),
      },
      create: {
        workspaceId,
        dimensions: json(merged),
        derivedFrom: json(editProvenance),
        confidence: 1.0,
      },
    }),
  );
}

/** Pin / unpin the profile (learner may not touch pinned profiles). */
export async function setVoicePinned(workspaceId: string, pinned: boolean) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.brandVoiceProfile.upsert({
      where: { workspaceId },
      update: { pinnedByUser: pinned },
      create: {
        workspaceId,
        dimensions: { ...EMPTY_DIMENSIONS },
        derivedFrom: { samples: [], editCount: 0, lastDerivedAt: new Date().toISOString() },
        confidence: 0,
        pinnedByUser: pinned,
      },
    }),
  );
}

/** Render the profile as a prompt section (used by prompt-context.ts). */
export function renderVoiceSection(dimensions: VoiceDimensions | null): string {
  if (!dimensions || (!dimensions.vocabulary?.length && !dimensions.formality))
    return "";
  const lines = [
    "## BRAND VOICE — write everything in this voice",
    `Vocabulary: ${dimensions.vocabulary.slice(0, 12).join(", ") || "(not yet derived)"}`,
    `Rhythm: ${dimensions.rhythm || "(not yet derived)"}`,
    `Formality: ${dimensions.formality || "(not yet derived)"}`,
    `Point of view: ${dimensions.pov || "(not yet derived)"}`,
    `Humor: ${dimensions.humor || "(not yet derived)"}`,
  ];
  if (dimensions.doExamples?.length)
    lines.push(
      "DO write like this:",
      ...dimensions.doExamples.map((e) => `  - "${e}"`),
    );
  if (dimensions.dontExamples?.length)
    lines.push(
      "DON'T write like this:",
      ...dimensions.dontExamples.map((e) => `  - ${e}`),
    );
  return lines.join("\n");
}
