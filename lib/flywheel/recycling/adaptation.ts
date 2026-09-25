// Marketr — Phase 7 F2: deterministic channel-pair adaptation rules.
//
// Rules-based first (SPEC §2/F2): every source→target pair the pipeline
// supports has an explicit, code-level rule — aspect ratio, copy-density
// ceilings, allowed CTA mechanics, and human-readable notes. The pipeline's
// job is brief-generation and routing, NOT unsupervised art direction.
// Anything not in the table below is rejected loudly.

import {
  type ChannelName, type CopyDensityCeiling, type VariantSpec,
  isChannelName,
} from "./types";

export const RULES_VERSION = "f2-rules-v1";

export class UnsupportedChannelPairError extends Error {
  readonly source: string;
  readonly target: string;
  constructor(source: string, target: string) {
    super(
      `No recycling rule for "${source}" → "${target}". ` +
      `Supported pairs: ${SUPPORTED_PAIRS.join(", ")}. ` +
      `Unmapped pairs are refused — the pipeline does not improvise art direction.`,
    );
    this.name = "UnsupportedChannelPairError";
    this.source = source;
    this.target = target;
  }
}

interface PairRule {
  aspectRatio: string;
  copy: CopyDensityCeiling;
  ctaFormats: string[];
  notes: string[];
}

/**
 * The rule table. Conventions:
 * - Billboard/DOOH: ≤7 words is the industry legibility rule (readable at
 *   speed/distance); CTA is QR/pURL only — no phone numbers, no fine print.
 * - Email: 600px fixed width, single primary CTA, button copy ≤4 words.
 * - Landing: one idea per page; hero headline ≤10 words; single primary CTA
 *   above the fold; everything else is supporting.
 * - Paid social/display ("ad"): primary text ≤25 words, headline ≤5 words,
 *   CTA = platform button labels only (the platform, not Marketr, renders it).
 * - Organic social: ≤25 words, ≤3 hashtags, CTA = link sticker / QR.
 * - SMS: ≤160 chars; CTA = shortlink + keyword. v1 does not recycle INTO sms
 *   from creative-heavy sources (copy-only pairs only).
 * - CTV: :15/:30 broadcast specs; v1 accepts video→ctv only (needs the
 *   Phase-7 F4 creative validator downstream — noted, not assumed).
 */
const PAIRS: Record<string, PairRule> = {
  // ---- from mail (direct mailer winners) ----
  "mail>billboard": {
    aspectRatio: "48:14",
    copy: { maxWords: 7, maxLines: 2 },
    ctaFormats: ["qr"],
    notes: [
      "Billboard legibility: readable at 500ft / highway speed.",
      "No phone numbers, no URLs in text — QR only.",
      "Brand + one idea. Nothing else survives the glance.",
    ],
  },
  "mail>dooh": {
    aspectRatio: "16:9",
    copy: { maxWords: 7, maxLines: 2 },
    ctaFormats: ["qr", "purl"],
    notes: [
      "Same 7-word ceiling as billboard; motion allowed but the still frame must carry the message.",
      "QR sized for the viewing distance of the placement.",
    ],
  },
  "mail>email": {
    aspectRatio: "600px-email",
    copy: { maxWords: 150, maxLines: 12 },
    ctaFormats: ["button", "purl"],
    notes: [
      "Mailer hero becomes the email hero block; offer terms move to the pre-footer.",
      "Single primary CTA button, ≤4 words on the button.",
    ],
  },
  "mail>social": {
    aspectRatio: "1:1",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["link_sticker", "qr"],
    notes: [
      "Mailer headline becomes the caption hook; hero art becomes the 1:1 still.",
      "≤3 hashtags. Link sticker or QR — never a raw URL in caption.",
    ],
  },
  "mail>sms": {
    aspectRatio: "text",
    copy: { maxWords: 30, maxLines: 4 },
    ctaFormats: ["shortlink"],
    notes: [
      "Copy-only recycle: the mailer's offer in ≤160 chars. Shortlink + opt-out footer required.",
    ],
  },

  // ---- from ad (winning paid creative) ----
  "ad>email": {
    aspectRatio: "600px-email",
    copy: { maxWords: 150, maxLines: 12 },
    ctaFormats: ["button", "purl"],
    notes: [
      "Winning ad headline becomes the subject-line family + email H1.",
      "Ad proof points become the email body; single CTA button.",
    ],
  },
  "ad>landing": {
    aspectRatio: "responsive",
    copy: { maxWords: 300, maxLines: 40 },
    ctaFormats: ["button", "purl"],
    notes: [
      "Ad promise becomes the hero headline (≤10 words); proof becomes the page.",
      "One primary CTA above the fold; message match with the ad is mandatory.",
    ],
  },
  "ad>social": {
    aspectRatio: "4:5",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["link_sticker", "platform_cta"],
    notes: [
      "Ad creative reframes to 4:5; primary text becomes the caption.",
      "Keep the winning hook verbatim — do not paraphrase what won.",
    ],
  },
  "ad>dooh": {
    aspectRatio: "16:9",
    copy: { maxWords: 7, maxLines: 2 },
    ctaFormats: ["qr"],
    notes: [
      "Only the ad's single strongest frame + headline survive the 7-word ceiling.",
      "QR sized for placement distance.",
    ],
  },

  // ---- from social (organic winners) ----
  "social>email": {
    aspectRatio: "600px-email",
    copy: { maxWords: 150, maxLines: 12 },
    ctaFormats: ["button"],
    notes: ["Winning post becomes the email story block; engagement proof (comments) becomes social proof."],
  },
  "social>ad": {
    aspectRatio: "4:5",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["platform_cta"],
    notes: [
      "Organic winner graduates to paid: keep hook and format verbatim for the first test.",
      "CTA = platform button labels only.",
    ],
  },
  "social>landing": {
    aspectRatio: "responsive",
    copy: { maxWords: 300, maxLines: 40 },
    ctaFormats: ["button"],
    notes: ["Post thread becomes the page narrative; top comments become the FAQ."],
  },

  // ---- from email ----
  "email>ad": {
    aspectRatio: "1:1",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["platform_cta"],
    notes: ["Subject-line winner becomes the ad headline; top-performing block becomes the creative."],
  },
  "email>landing": {
    aspectRatio: "responsive",
    copy: { maxWords: 300, maxLines: 40 },
    ctaFormats: ["button"],
    notes: ["Email narrative expands to the page; the email CTA becomes the page's primary CTA."],
  },
  "email>social": {
    aspectRatio: "1:1",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["link_sticker"],
    notes: ["Highest-click block becomes the post; keep the subject line as the hook."],
  },

  // ---- from landing (web page winners) ----
  "landing>ad": {
    aspectRatio: "1:1",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["platform_cta"],
    notes: ["Hero headline becomes ad headline verbatim; hero visual becomes the creative."],
  },
  "landing>social": {
    aspectRatio: "4:5",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["link_sticker"],
    notes: ["Page sections become a carousel; headline becomes the caption hook."],
  },
  "landing>email": {
    aspectRatio: "600px-email",
    copy: { maxWords: 150, maxLines: 12 },
    ctaFormats: ["button"],
    notes: ["Page narrative compresses to the email arc; page CTA becomes the email CTA."],
  },

  // ---- from video (long-form / brand film) ----
  "video>ad": {
    aspectRatio: "16:9",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["platform_cta", "end_card"],
    notes: [
      ":15 cutdown maximum — the film's single strongest beat.",
      "End-card CTA; captions burned in (sound-off default).",
    ],
  },
  "video>social": {
    aspectRatio: "9:16",
    copy: { maxWords: 25, maxLines: 4 },
    ctaFormats: ["link_sticker"],
    notes: ["Vertical reframe; captions burned in; hook in the first 2 seconds."],
  },
  "video>ctv": {
    aspectRatio: "16:9",
    copy: { maxWords: 12, maxLines: 3 },
    ctaFormats: ["qr", "voice"],
    notes: [
      ":15/:30 broadcast cut; downstream F4 creative validator must pass before any buy.",
      "QR sized for couch distance; voice CTA spoken, not on-screen text.",
    ],
  },
};

export const SUPPORTED_PAIRS = Object.keys(PAIRS).sort();

/** Deterministic rule lookup. Throws on unknown pairs — never improvises. */
export function ruleFor(source: string, target: string): PairRule {
  if (!isChannelName(source) || !isChannelName(target)) {
    throw new UnsupportedChannelPairError(source, target);
  }
  const rule = PAIRS[`${source}>${target}`];
  if (!rule) throw new UnsupportedChannelPairError(source, target);
  return rule;
}

/** Build the deterministic variant specs for a brief. Pure — no I/O. */
export function adaptBrief(sourceChannel: ChannelName, targetChannels: ChannelName[]): Record<string, VariantSpec> {
  if (targetChannels.length === 0) {
    throw new UnsupportedChannelPairError(sourceChannel, "(no targets)");
  }
  const seen = new Set<string>();
  const specs: Record<string, VariantSpec> = {};
  for (const target of targetChannels) {
    if (!isChannelName(target)) throw new UnsupportedChannelPairError(sourceChannel, target);
    if (seen.has(target)) continue; // dedupe; the spec is per channel
    seen.add(target);
    const rule = ruleFor(sourceChannel, target);
    specs[target] = {
      targetChannel: target,
      aspectRatio: rule.aspectRatio,
      copyDensityCeiling: { ...rule.copy },
      ctaFormats: [...rule.ctaFormats],
      notes: [...rule.notes],
      supervisedRewrite: { headline: true, cta: true },
      rulesVersion: RULES_VERSION,
    };
  }
  return specs;
}
