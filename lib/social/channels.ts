// Marketr — social channel definitions and pure post logic (milestone 20).
//
// Dependency-free: channel character limits, media requirements, per-channel
// validation, UTM building, and calendar bucketing. All server-side guardrails
// in lib/social/service.ts delegate to these pure functions so they are
// fixture-testable without a database or network.

export type SocialService =
  | "twitter"
  | "instagram"
  | "tiktok"
  | "linkedin"
  | "facebook"
  | "threads"
  | "youtube"
  | "bluesky"
  | "pinterest";

export interface ChannelDef {
  service: SocialService;
  label: string;
  /** Max characters for post text (platform-documented maxima). */
  maxLength: number;
  /** Media Buffer will attach; requirement the channel enforces at publish. */
  mediaRequirement: "none" | "optional" | "photo_or_video" | "video_only" | "photo_only";
  /** Human hint shown under the composer. */
  mediaHint: string;
}

export const CHANNEL_DEFS: Record<SocialService, ChannelDef> = {
  twitter: {
    service: "twitter",
    label: "X (Twitter)",
    maxLength: 280,
    mediaRequirement: "optional",
    mediaHint: "Optional image or video.",
  },
  instagram: {
    service: "instagram",
    label: "Instagram",
    maxLength: 2200,
    mediaRequirement: "photo_or_video",
    mediaHint: "Instagram requires a photo or video — a text-only post will be rejected.",
  },
  tiktok: {
    service: "tiktok",
    label: "TikTok",
    maxLength: 2200,
    mediaRequirement: "video_only",
    mediaHint: "TikTok requires a video.",
  },
  linkedin: {
    service: "linkedin",
    label: "LinkedIn",
    maxLength: 3000,
    mediaRequirement: "optional",
    mediaHint: "Optional image, video, or link.",
  },
  facebook: {
    service: "facebook",
    label: "Facebook",
    maxLength: 63206,
    mediaRequirement: "optional",
    mediaHint: "Optional image, video, or link.",
  },
  threads: {
    service: "threads",
    label: "Threads",
    maxLength: 500,
    mediaRequirement: "optional",
    mediaHint: "Optional image or video.",
  },
  youtube: {
    service: "youtube",
    label: "YouTube",
    maxLength: 5000,
    mediaRequirement: "video_only",
    mediaHint: "YouTube requires a video.",
  },
  bluesky: {
    service: "bluesky",
    label: "Bluesky",
    maxLength: 300,
    mediaRequirement: "optional",
    mediaHint: "Optional image.",
  },
  pinterest: {
    service: "pinterest",
    label: "Pinterest",
    maxLength: 800,
    mediaRequirement: "photo_only",
    mediaHint: "Pinterest requires an image.",
  },
};

export const ALL_SERVICES = Object.keys(CHANNEL_DEFS) as SocialService[];

export interface PostMedia {
  type: "image" | "video" | "link";
  url: string;
  thumbnailUrl?: string;
}

/** Composer content shape stored as JSON on SocialPost. */
export interface SocialContent {
  /** Shared text used for every channel without an override. */
  text: string;
  /** Per-channel overrides keyed by SocialService. */
  perChannel: Partial<Record<SocialService, { text?: string; media?: PostMedia[] }>>;
  /** Shared media applied unless a channel override replaces it. */
  media: PostMedia[];
  /** Optional link attachment (Buffer media[link]). */
  link?: string;
  /** UTM params appended to the link at publish time. */
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
}

export function emptyContent(): SocialContent {
  return { text: "", perChannel: {}, media: [] };
}

/** Resolve the effective text + media for one channel. */
export function resolveChannelContent(
  content: SocialContent,
  service: SocialService,
): { text: string; media: PostMedia[] } {
  const override = content.perChannel[service];
  return {
    text: override?.text ?? content.text,
    media: override?.media ?? content.media,
  };
}

export interface ValidationIssue {
  service: SocialService;
  field: "text" | "media";
  message: string;
}

/**
 * Server-side guardrail: a post is publishable only when every selected
 * channel has non-empty text within its limit and its media requirement met.
 * Returns the list of issues (empty = valid).
 */
export function validatePostForChannels(
  services: SocialService[],
  content: SocialContent,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const service of services) {
    const def = CHANNEL_DEFS[service];
    if (!def) {
      issues.push({ service, field: "text", message: `Unknown channel: ${service}.` });
      continue;
    }
    const { text, media } = resolveChannelContent(content, service);
    const trimmed = text.trim();
    if (!trimmed) {
      issues.push({ service, field: "text", message: `${def.label}: post text is empty.` });
    } else if (trimmed.length > def.maxLength) {
      issues.push({
        service,
        field: "text",
        message: `${def.label}: ${trimmed.length} characters exceeds the ${def.maxLength} limit.`,
      });
    }
    const hasImage = media.some((m) => m.type === "image");
    const hasVideo = media.some((m) => m.type === "video");
    switch (def.mediaRequirement) {
      case "photo_or_video":
        if (!hasImage && !hasVideo)
          issues.push({ service, field: "media", message: `${def.label} requires a photo or video.` });
        break;
      case "video_only":
        if (!hasVideo) issues.push({ service, field: "media", message: `${def.label} requires a video.` });
        break;
      case "photo_only":
        if (!hasImage) issues.push({ service, field: "media", message: `${def.label} requires an image.` });
        break;
      default:
        break;
    }
  }
  return issues;
}

/** Append UTM params to a URL; returns the original URL when no link/params. */
export function buildUtmUrl(link: string | undefined, utm: SocialContent["utm"]): string | undefined {
  if (!link?.trim()) return undefined;
  const params = utm ?? {};
  const entries: Array<[string, string | undefined]> = [
    ["utm_source", params.source],
    ["utm_medium", params.medium],
    ["utm_campaign", params.campaign],
    ["utm_term", params.term],
    ["utm_content", params.content],
  ];
  const defined = entries.filter(([, v]) => v && v.trim().length > 0) as Array<[string, string]>;
  if (defined.length === 0) return link;
  try {
    const url = new URL(link);
    for (const [k, v] of defined) url.searchParams.set(k, v);
    return url.toString();
  } catch {
    // Not a parseable absolute URL — leave untouched rather than corrupting.
    return link;
  }
}

/** Minimal post shape for calendar bucketing. */
export interface CalendarPost {
  id: string;
  scheduledFor: Date | string | null;
  services: SocialService[];
  status: string;
}

/**
 * Bucket posts into calendar days of a given month (UTC day buckets).
 * Returns a map day(1-31) -> posts, plus counts for out-of-month posts.
 */
export function bucketPostsByDay(
  posts: CalendarPost[],
  year: number,
  month: number, // 1-12
): { days: Map<number, CalendarPost[]>; outOfMonth: number } {
  const days = new Map<number, CalendarPost[]>();
  let outOfMonth = 0;
  for (const post of posts) {
    if (!post.scheduledFor) {
      outOfMonth += 1;
      continue;
    }
    const d = new Date(post.scheduledFor);
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month - 1) {
      const day = d.getUTCDate();
      const arr = days.get(day) ?? [];
      arr.push(post);
      days.set(day, arr);
    } else {
      outOfMonth += 1;
    }
  }
  return { days, outOfMonth };
}

/** Backoff schedule for transient dispatch failures (ms). Index = attempt number. */
export const RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const MAX_DISPATCH_ATTEMPTS = 3;

/** Next retry time after `attempts` failed attempts (attempts is 1-based). */
export function nextRetryAt(attempts: number, from: Date = new Date()): Date {
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  return new Date(from.getTime() + backoff);
}
