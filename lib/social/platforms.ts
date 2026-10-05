// ShapesOS — social platforms: media constraints + validation (Phase 4b).
//
// Pure (no prisma, no DOM): the composer runs the same checks client-side
// that the server runs before a post can be submitted or dispatched.
//
// Limits are the platforms' own published posting limits (2026), rounded
// down where they vary by account type, so a post that passes here is not
// rejected for size/count/type by the platform. Unknown platforms get a
// conservative default. Upload caps (what ShapesOS stores at all) are
// separate: socialMaxUploadBytes() (server-side; the API reports it to the UI).

export type MediaKind = "image" | "video";

export interface SocialMedia {
  fileId: string;
  filename: string;
  mimeType: string;
  kind: MediaKind;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export interface PlatformRules {
  label: string;
  /** Max characters in the post body. */
  maxChars: number;
  /** Max attachments of any kind. */
  maxMedia: number;
  maxImages: number;
  maxVideos: number;
  maxImageBytes: number;
  maxVideoBytes: number;
  imageTypes: readonly string[];
  videoTypes: readonly string[];
  /** Images and a video in the same post. */
  allowMixed: boolean;
  /** "image_or_video": at least one attachment; "video": exactly one video. */
  requires: "none" | "image_or_video" | "video";
  /** Platforms that wrap links count every URL as this many characters (X: 23). */
  urlChars?: number;
}

const MB = 1024 * 1024;
const JPG_PNG = ["image/jpeg", "image/png"] as const;
const WEB_IMAGES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const MP4_MOV = ["video/mp4", "video/quicktime"] as const;

/** What ShapesOS accepts for social uploads at all (before platform rules). */
export const SOCIAL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export const SOCIAL_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
/**
 * ShapesOS's own per-file upload cap. Requests pass through proxy.ts, whose
 * body buffer is Next's proxyClientMaxBodySize (10 MB by default): a larger
 * multipart body would arrive truncated. So the default cap is 9.5 MB; raise
 * SOCIAL_MAX_UPLOAD_MB only together with experimental.proxyClientMaxBodySize.
 */
export function socialMaxUploadBytes(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.SOCIAL_MAX_UPLOAD_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.min(Math.floor(mb * MB), 500 * MB) : Math.floor(9.5 * MB);
}

export const PLATFORM_RULES: Record<string, PlatformRules> = {
  x: {
    label: "X",
    maxChars: 280,
    maxMedia: 4,
    maxImages: 4,
    maxVideos: 1,
    maxImageBytes: 5 * MB,
    maxVideoBytes: 100 * MB,
    imageTypes: WEB_IMAGES,
    videoTypes: MP4_MOV,
    allowMixed: false,
    requires: "none",
    urlChars: 23,
  },
  linkedin: {
    label: "LinkedIn",
    maxChars: 3000,
    maxMedia: 9,
    maxImages: 9,
    maxVideos: 1,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 100 * MB,
    imageTypes: ["image/jpeg", "image/png", "image/gif"],
    videoTypes: MP4_MOV,
    allowMixed: false,
    requires: "none",
  },
  facebook: {
    label: "Facebook",
    maxChars: 63206,
    maxMedia: 10,
    maxImages: 10,
    maxVideos: 1,
    maxImageBytes: 10 * MB,
    maxVideoBytes: 100 * MB,
    imageTypes: WEB_IMAGES,
    videoTypes: MP4_MOV,
    allowMixed: false,
    requires: "none",
  },
  instagram: {
    label: "Instagram",
    maxChars: 2200,
    maxMedia: 10,
    maxImages: 10,
    maxVideos: 10,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 100 * MB,
    imageTypes: JPG_PNG,
    videoTypes: MP4_MOV,
    allowMixed: true,
    requires: "image_or_video",
  },
  threads: {
    label: "Threads",
    maxChars: 500,
    maxMedia: 10,
    maxImages: 10,
    maxVideos: 10,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 100 * MB,
    imageTypes: JPG_PNG,
    videoTypes: MP4_MOV,
    allowMixed: true,
    requires: "none",
  },
  tiktok: {
    label: "TikTok",
    maxChars: 2200,
    maxMedia: 1,
    maxImages: 0,
    maxVideos: 1,
    maxImageBytes: 0,
    maxVideoBytes: 100 * MB,
    imageTypes: [],
    videoTypes: ["video/mp4", "video/quicktime", "video/webm"],
    allowMixed: false,
    requires: "video",
  },
  youtube: {
    label: "YouTube",
    maxChars: 5000,
    maxMedia: 1,
    maxImages: 0,
    maxVideos: 1,
    maxImageBytes: 0,
    maxVideoBytes: 100 * MB,
    imageTypes: [],
    videoTypes: ["video/mp4", "video/quicktime", "video/webm"],
    allowMixed: false,
    requires: "video",
  },
  pinterest: {
    label: "Pinterest",
    maxChars: 500,
    maxMedia: 1,
    maxImages: 1,
    maxVideos: 1,
    maxImageBytes: 20 * MB,
    maxVideoBytes: 100 * MB,
    imageTypes: ["image/jpeg", "image/png", "image/webp"],
    videoTypes: MP4_MOV,
    allowMixed: false,
    requires: "image_or_video",
  },
  bluesky: {
    label: "Bluesky",
    maxChars: 300,
    maxMedia: 4,
    maxImages: 4,
    maxVideos: 1,
    maxImageBytes: 950 * 1024,
    maxVideoBytes: 50 * MB,
    imageTypes: ["image/jpeg", "image/png", "image/webp"],
    videoTypes: ["video/mp4"],
    allowMixed: false,
    requires: "none",
  },
  mastodon: {
    label: "Mastodon",
    maxChars: 500,
    maxMedia: 4,
    maxImages: 4,
    maxVideos: 1,
    maxImageBytes: 8 * MB,
    maxVideoBytes: 40 * MB,
    imageTypes: WEB_IMAGES,
    videoTypes: ["video/mp4", "video/webm"],
    allowMixed: false,
    requires: "none",
  },
};

export const DEFAULT_RULES: PlatformRules = {
  label: "Other",
  maxChars: 3000,
  maxMedia: 4,
  maxImages: 4,
  maxVideos: 1,
  maxImageBytes: 8 * MB,
  maxVideoBytes: 100 * MB,
  imageTypes: JPG_PNG,
  videoTypes: ["video/mp4"],
  allowMixed: false,
  requires: "none",
};

/**
 * Normalize a provider channel identifier to a platform key: Postiz uses
 * "x", "linkedin-page", "instagram-standalone", "facebook", ... → "x",
 * "linkedin", "instagram". Unknown identifiers come back sanitized.
 */
export function normalizePlatform(identifier: string | null | undefined): string {
  const s = (identifier ?? "").trim().toLowerCase();
  if (!s) return "other";
  if (s === "twitter" || s === "x") return "x";
  for (const key of Object.keys(PLATFORM_RULES)) {
    if (s === key || s.startsWith(`${key}-`) || s.startsWith(`${key}_`)) return key;
  }
  if (s.startsWith("fb")) return "facebook";
  if (s.startsWith("ig")) return "instagram";
  return s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "other";
}

export function rulesFor(identifier: string | null | undefined): PlatformRules {
  return PLATFORM_RULES[normalizePlatform(identifier)] ?? DEFAULT_RULES;
}

export function platformLabel(identifier: string | null | undefined): string {
  const key = normalizePlatform(identifier);
  return PLATFORM_RULES[key]?.label ?? (key === "other" ? "Other" : key[0]!.toUpperCase() + key.slice(1));
}

export interface MediaIssue {
  platform: string;
  /** Machine code for tests and UI grouping. */
  code:
    | "too_long"
    | "media_required"
    | "video_required"
    | "too_many_media"
    | "too_many_images"
    | "too_many_videos"
    | "mixed_media"
    | "image_type"
    | "video_type"
    | "image_too_large"
    | "video_too_large";
  message: string;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Characters as the platform counts them (code points; wrapped URLs at a fixed length). */
export function countChars(text: string, urlChars?: number): number {
  if (!urlChars) return [...text].length;
  let n = 0;
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    // Trailing punctuation isn't part of the link (same rule as utm.ts).
    const core = m[0].replace(/[).,;:!?\]]+$/, "");
    n += [...text.slice(last, m.index)].length + urlChars;
    last = (m.index ?? 0) + core.length;
  }
  return n + [...text.slice(last)].length;
}

function mb(bytes: number): string {
  return bytes >= MB ? `${Math.round((bytes / MB) * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Check one post (text + media) against every target platform's rules.
 * Returns [] when the post is valid everywhere. Text length is measured
 * after UTM tagging by the caller when a link is appended.
 */
export function validatePost(
  identifiers: readonly string[],
  text: string,
  media: readonly Pick<SocialMedia, "kind" | "mimeType" | "sizeBytes" | "filename">[],
): MediaIssue[] {
  const issues: MediaIssue[] = [];
  const seen = new Set<string>();
  const images = media.filter((m) => m.kind === "image");
  const videos = media.filter((m) => m.kind === "video");
  for (const id of identifiers) {
    const platform = normalizePlatform(id);
    if (seen.has(platform)) continue;
    seen.add(platform);
    const r = PLATFORM_RULES[platform] ?? DEFAULT_RULES;
    const label = r.label === "Other" ? platformLabel(id) : r.label;
    const push = (code: MediaIssue["code"], message: string) => issues.push({ platform, code, message: `${label}: ${message}` });

    const chars = countChars(text, r.urlChars);
    if (chars > r.maxChars) push("too_long", `text is ${chars} characters; the limit is ${r.maxChars}.`);
    if (r.requires === "video" && (videos.length !== 1 || images.length > 0)) {
      push("video_required", "needs exactly one video and no images.");
    } else if (r.requires === "image_or_video" && media.length === 0) {
      push("media_required", "needs at least one image or video.");
    }
    if (media.length > r.maxMedia) push("too_many_media", `up to ${r.maxMedia} attachments.`);
    if (images.length > r.maxImages && r.requires !== "video") {
      push("too_many_images", r.maxImages === 0 ? "doesn't take images." : `up to ${r.maxImages} images.`);
    }
    if (videos.length > r.maxVideos) push("too_many_videos", `up to ${r.maxVideos} video${r.maxVideos === 1 ? "" : "s"}.`);
    if (!r.allowMixed && images.length > 0 && videos.length > 0 && r.requires !== "video") {
      push("mixed_media", "can't mix images and video in one post.");
    }
    for (const m of images) {
      if (r.maxImages === 0) break;
      if (!r.imageTypes.includes(m.mimeType)) push("image_type", `${m.filename} is ${m.mimeType}; use ${r.imageTypes.map((t) => t.split("/")[1]).join(", ")}.`);
      else if (m.sizeBytes > r.maxImageBytes) push("image_too_large", `${m.filename} is ${mb(m.sizeBytes)}; the image limit is ${mb(r.maxImageBytes)}.`);
    }
    for (const m of videos) {
      if (!r.videoTypes.includes(m.mimeType)) push("video_type", `${m.filename} is ${m.mimeType}; use ${r.videoTypes.map((t) => t.split("/")[1]).join(", ")}.`);
      else if (m.sizeBytes > r.maxVideoBytes) push("video_too_large", `${m.filename} is ${mb(m.sizeBytes)}; the video limit is ${mb(r.maxVideoBytes)}.`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Upload sniffing: the declared type is a hint, the bytes decide.
// ---------------------------------------------------------------------------

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

function ascii(buf: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < Math.min(to, buf.length); i++) s += String.fromCharCode(buf[i]!);
  return s;
}

/**
 * Sniff a social media upload from its magic bytes. Images: PNG, JPEG, GIF,
 * WebP. Video: MP4 / QuickTime (ISO-BMFF `ftyp` box) and WebM (EBML).
 * Returns null for anything else (SVG is deliberately not accepted: no
 * platform takes it and it can carry script).
 */
export function sniffSocialMedia(buf: Uint8Array): { mimeType: string; kind: MediaKind; ext: string } | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: "image/png", kind: "image", ext: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", kind: "image", ext: "jpg" };
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return { mimeType: "image/gif", kind: "image", ext: "gif" };
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && ascii(buf, 8, 12) === "WEBP") return { mimeType: "image/webp", kind: "image", ext: "webp" };
  if (buf.length >= 12 && ascii(buf, 4, 8) === "ftyp") {
    const brand = ascii(buf, 8, 12);
    if (brand === "qt  ") return { mimeType: "video/quicktime", kind: "video", ext: "mov" };
    // heic/avif are image brands of the same container; not accepted.
    if (/^(heic|heix|mif1|msf1|avif|avis)$/.test(brand)) return null;
    return { mimeType: "video/mp4", kind: "video", ext: "mp4" };
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { mimeType: "video/webm", kind: "video", ext: "webm" };
  return null;
}

/** Upload-level check (before any platform rule): type + ShapesOS size cap. */
export function checkSocialUpload(
  buf: Uint8Array,
  maxBytes?: number,
): { ok: true; mimeType: string; kind: MediaKind; ext: string } | { ok: false; reason: string } {
  if (buf.length === 0) return { ok: false, reason: "The file is empty." };
  const sniffed = sniffSocialMedia(buf);
  if (!sniffed) {
    return { ok: false, reason: "Use an image (JPEG, PNG, GIF, WebP) or a video (MP4, MOV, WebM)." };
  }
  const cap = maxBytes ?? socialMaxUploadBytes();
  if (buf.length > cap) {
    return { ok: false, reason: `Files can be up to ${mb(cap)}.` };
  }
  return { ok: true, ...sniffed };
}

/** Coerce stored JSON into SocialMedia[] (drops malformed entries). */
export function readMedia(raw: unknown): SocialMedia[] {
  if (!Array.isArray(raw)) return [];
  const out: SocialMedia[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.fileId !== "string" || !r.fileId) continue;
    const kind = r.kind === "video" ? "video" : r.kind === "image" ? "image" : null;
    if (!kind) continue;
    out.push({
      fileId: r.fileId,
      filename: typeof r.filename === "string" ? r.filename : "media",
      mimeType: typeof r.mimeType === "string" ? r.mimeType : "application/octet-stream",
      kind,
      sizeBytes: Number.isFinite(Number(r.sizeBytes)) ? Number(r.sizeBytes) : 0,
      width: typeof r.width === "number" ? r.width : null,
      height: typeof r.height === "number" ? r.height : null,
    });
  }
  return out;
}
