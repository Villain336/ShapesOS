// Marketr — Creative Studio format registry (Phase 4, T2).
//
// The single source of truth for creative format tracks. It is organized by
// CHANNEL TEMPLATE first (print | email | social) so future channels plug in
// here without touching the validation service, routes, or UI wizard:
//
//   1. Add the new channel id to CHANNEL_TEMPLATE_IDS + CHANNEL_TEMPLATES.
//   2. Add its format tracks + sizes below.
//   3. The wizard, filters, and validateFormat pick them up automatically.
//
// v1 ships only the "print" channel. "email" and "social" are registered as
// coming_soon placeholders: creatives can be created as drafts under them,
// but validation/mark-ready stays gated until their format tracks are defined.

export type ChannelTemplateId = "print" | "email" | "social";

export const CHANNEL_TEMPLATE_IDS: ChannelTemplateId[] = ["print", "email", "social"];

/** A printable/deliverable size within a format track. */
export interface SizeSpec {
  id: string;
  label: string;
  /** Trim size in inches (width x height). For range sizes, the nominal. */
  widthIn: number;
  heightIn: number;
  /** Hard bounds for fixed trim sizes (optional, rarely needed). */
  minWidthIn?: number;
  minHeightIn?: number;
  maxWidthIn?: number;
  maxHeightIn?: number;
  /**
   * Hard bounds for RANGE sizes (either side may be the long side — used by
   * EDDM flats). Both measured sides must satisfy: short side within
   * [minShortSideIn, maxShortSideIn], long side within [minLongSideIn, maxLongSideIn].
   */
  minShortSideIn?: number;
  minLongSideIn?: number;
  maxShortSideIn?: number;
  maxLongSideIn?: number;
  /** Allowed page counts in the PDF. */
  minPages: number;
  maxPages: number;
  orientation?: "any" | "portrait" | "landscape";
  notes?: string;
}

/** A format track: the production lane a creative is built for. */
export interface FormatTrack {
  id: string;
  label: string;
  channelTemplate: ChannelTemplateId;
  description: string;
  sizes: SizeSpec[];
  notes?: string;
}

export interface ChannelTemplate {
  id: ChannelTemplateId;
  label: string;
  /** v1: only "print" is live. email/social are coming_soon placeholders. */
  status: "live" | "coming_soon";
  tracks: FormatTrack[];
}

const PT_PER_IN = 72;

export const ADDRESSED_TRACK: FormatTrack = {
  id: "addressed",
  label: "Addressed mail",
  channelTemplate: "print",
  description: "Postcards and letters mailed to named addresses (Lob/PostGrid).",
  sizes: [
    {
      id: "4x6_postcard",
      label: '4" × 6" postcard',
      widthIn: 4,
      heightIn: 6,
      minPages: 1,
      maxPages: 2,
      orientation: "any",
      notes: "Trim size. If the PDF carries bleed, dimensions may read up to ~4.25×6.25 in — flagged as a warning, not a failure.",
    },
    {
      // Exact ID per spec: "#10_letter" (the "#" is part of the stable ID).
      id: "#10_letter",
      label: '#10 letter (8.5" × 11" pages)',
      widthIn: 8.5,
      heightIn: 11,
      minPages: 1,
      maxPages: 8,
      orientation: "portrait",
      notes: "Printable letter pages sized to fit a #10 envelope (4.125″ × 9.5″).",
    },
  ],
};

// USPS EDDM flat minimums/maximums (Every Door Direct Mail, 2026):
//   min 6-1/8" x 11-1/2" | max 12" x 15"
// A 4x6 postcard NEVER qualifies — enforced in validateFormat.
export const EDDM_TRACK: FormatTrack = {
  id: "eddm",
  label: "EDDM flat",
  channelTemplate: "print",
  description: "Unaddressed Every Door Direct Mail flats — carrier-route saturation.",
  sizes: [
    {
      id: "eddm_flat",
      label: "EDDM flat (6.125″ × 11.5″ – 12″ × 15″)",
      // Nominal trim (a common EDDM flat); the hard bounds below are what
      // validateFormat enforces. Either side may be the long side.
      widthIn: 11.5,
      heightIn: 6.625,
      minShortSideIn: 6.125,
      minLongSideIn: 11.5,
      maxShortSideIn: 12,
      maxLongSideIn: 15,
      minPages: 1,
      maxPages: 2,
      orientation: "any",
      notes:
        "USPS requires EDDM flats to be at least 6.125″ × 11.5″ and no larger than 12″ × 15″. " +
        "Either side may be the long side; each side must fall within its bound.",
    },
  ],
  notes: "4×6 postcards do NOT qualify for EDDM — this is a hard USPS constraint.",
};

export const CHANNEL_TEMPLATES: Record<ChannelTemplateId, ChannelTemplate> = {
  print: {
    id: "print",
    label: "Print",
    status: "live",
    tracks: [ADDRESSED_TRACK, EDDM_TRACK],
  },
  // Placeholders for future channels. No tracks yet: the data model, routes,
  // and wizard already accept these ids, so plugging in email/social means
  // adding tracks + sizes here — no rework elsewhere.
  email: { id: "email", label: "Email", status: "coming_soon", tracks: [] },
  social: { id: "social", label: "Social", status: "coming_soon", tracks: [] },
};

export function getChannelTemplate(id: string): ChannelTemplate | null {
  if (!CHANNEL_TEMPLATE_IDS.includes(id as ChannelTemplateId)) return null;
  return CHANNEL_TEMPLATES[id as ChannelTemplateId];
}

export function getFormatTrack(channelTemplate: ChannelTemplateId, trackId: string): FormatTrack | null {
  return CHANNEL_TEMPLATES[channelTemplate].tracks.find((t) => t.id === trackId) ?? null;
}

export function getSizeSpec(track: FormatTrack, sizeId: string): SizeSpec | null {
  return track.sizes.find((s) => s.id === sizeId) ?? null;
}

/** True when the size is a bounded range (EDDM flat) rather than a fixed trim. */
export function isRangeSize(size: SizeSpec): boolean {
  return (
    size.minShortSideIn != null &&
    size.minLongSideIn != null &&
    size.maxShortSideIn != null &&
    size.maxLongSideIn != null
  );
}

/** Convert inches to PDF points. */
export function inToPt(inches: number): number {
  return inches * PT_PER_IN;
}

export function ptToIn(points: number): number {
  return points / PT_PER_IN;
}
