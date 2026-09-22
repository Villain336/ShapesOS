// Marketr — ad brief → prompt composition (milestone 21).
//
// Structured briefs become provider prompts with brand constraints (M12
// brand kit) and channel format specs baked in. Pure functions: fully
// unit-testable with no network.

export interface AdBrief {
  product: string;
  audience: string;
  hook: string;
  offer?: string;
  cta: string;
  tone?: string;
  /** Free-form do-not-include notes. */
  negativePrompt?: string;
}

export interface BrandConstraints {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  tone?: string | null;
  /** True when the brand kit has a logo to reference for placement. */
  hasLogo: boolean;
}

/** Aspect-ratio specs per placement family. */
export const ASPECT_RATIOS = {
  "1:1": { label: "Square", dims: "1080×1080", suits: ["Feed", "Carousel"] },
  "4:5": { label: "Portrait", dims: "1080×1350", suits: ["Instagram feed", "Facebook feed"] },
  "9:16": { label: "Vertical", dims: "1080×1920", suits: ["Reels", "TikTok", "Shorts", "Stories"] },
  "16:9": { label: "Landscape", dims: "1920×1080", suits: ["YouTube", "LinkedIn", "Display"] },
} as const;

export type AspectRatio = keyof typeof ASPECT_RATIOS;

/** Channel → recommended aspect ratios (first = primary). */
export const CHANNEL_FORMATS: Record<string, AspectRatio[]> = {
  instagram: ["4:5", "1:1", "9:16"],
  facebook: ["4:5", "1:1", "16:9"],
  tiktok: ["9:16"],
  youtube: ["16:9", "9:16"],
  linkedin: ["1:1", "16:9"],
  twitter: ["16:9", "1:1"],
  threads: ["1:1", "4:5"],
  bluesky: ["1:1", "16:9"],
  pinterest: ["9:16", "1:1"],
};

export const MAX_VARIANTS = 8;

/**
 * Cost estimates in cents per generation job — ILLUSTRATIVE CONSTANTS from
 * provider docs as of the milestone build, NOT live prices. Reverify before
 * billing; actuals are recorded from provider responses when available.
 */
export const ESTIMATED_COST_CENTS = { image: 50, video: 200 } as const;

export function estimateCostCents(type: "image" | "video", variants: number): number {
  return ESTIMATED_COST_CENTS[type] * variants;
}

/** Hook-angle rotations so N variants don't all say the same thing. */
const ANGLE_ROTATIONS = [
  "Problem-first: open on the pain point, then resolve it.",
  "Benefit-first: lead with the transformation or outcome.",
  "Social proof: imply real customers and results.",
  "Urgency: the offer is time- or quantity-limited.",
  "Curiosity gap: tease without revealing the full mechanism.",
  "Comparison: contrast the old way with the new way.",
];

/**
 * Compose the final generation prompt from a brief, brand constraints, and
 * the target format. Brand colors/fonts and logo placement are baked in so
 * the provider can't invent an off-brand look.
 */
export function buildAdPrompt(
  brief: AdBrief,
  brand: BrandConstraints,
  type: "image" | "video",
  aspectRatio: AspectRatio,
  variantIndex: number,
): { prompt: string; negativePrompt: string } {
  const spec = ASPECT_RATIOS[aspectRatio];
  const angle = ANGLE_ROTATIONS[variantIndex % ANGLE_ROTATIONS.length];
  const colors = Object.entries(brand.colors)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const fonts = Object.entries(brand.fonts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  const tone = brief.tone ?? brand.tone ?? "confident, modern";

  const parts = [
    `Create a ${type === "video" ? "short advertising video" : "digital ad image"} in ${aspectRatio} (${spec.label}, ${spec.dims}).`,
    `Product: ${brief.product}.`,
    `Audience: ${brief.audience}.`,
    `Hook: ${brief.hook}.`,
    `Creative angle for this variant: ${angle}`,
  ];
  if (brief.offer) parts.push(`Offer to feature: ${brief.offer}.`);
  parts.push(`Call to action: ${brief.cta}.`);
  parts.push(`Tone: ${tone}.`);
  if (colors) parts.push(`Brand palette (use these colors, do not invent others): ${colors}.`);
  if (fonts) parts.push(`Typography style: ${fonts}.`);
  if (brand.hasLogo) parts.push("Leave a clean, uncluttered corner for the brand logo placement.");
  parts.push("No spelling errors. No watermark. No stock-photo look.");

  const negative = [
    "blurry",
    "distorted text",
    "extra limbs",
    "watermark",
    "off-brand colors",
    brief.negativePrompt ?? "",
  ]
    .filter(Boolean)
    .join(", ");

  return { prompt: parts.join(" "), negativePrompt: negative };
}

/**
 * Fan out a brief into N variant prompts by rotating the creative angle.
 * Variant 0 always uses the brief's hook verbatim (the "control").
 */
export function fanOutVariants(
  brief: AdBrief,
  brand: BrandConstraints,
  type: "image" | "video",
  aspectRatio: AspectRatio,
  count: number,
): { prompt: string; negativePrompt: string }[] {
  const n = Math.max(1, Math.min(MAX_VARIANTS, Math.floor(count)));
  return Array.from({ length: n }, (_, i) => buildAdPrompt(brief, brand, type, aspectRatio, i));
}

/** Recommended aspect ratios for a set of target channels. */
export function recommendedRatios(channels: string[]): AspectRatio[] {
  const seen: AspectRatio[] = [];
  for (const ch of channels) {
    for (const r of CHANNEL_FORMATS[ch] ?? ["1:1" as AspectRatio]) {
      if (!seen.includes(r)) seen.push(r);
    }
  }
  return seen.length ? seen : ["1:1"];
}

/** Validate a brief — returns human-readable errors (empty = valid). */
export function validateBrief(brief: Partial<AdBrief>): string[] {
  const errors: string[] = [];
  if (!brief.product?.trim()) errors.push("Product is required.");
  if (!brief.audience?.trim()) errors.push("Audience is required.");
  if (!brief.hook?.trim()) errors.push("Hook is required.");
  if (!brief.cta?.trim()) errors.push("Call to action is required.");
  if (brief.product && brief.product.length > 500) errors.push("Product must be under 500 characters.");
  return errors;
}
