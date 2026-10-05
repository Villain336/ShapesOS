// ShapesOS — automatic UTM tagging for outbound social links (Phase 4b).
//
// Every http(s) link a post carries (the explicit link field and any URL in
// the text) is tagged per channel at dispatch time:
//   utm_source   = platform key (x, linkedin, instagram, ...)
//   utm_medium   = "social"            → channelFor() maps it to social_organic
//   utm_campaign = the post's campaign (or "social-<yyyy-mm-dd>")
//   utm_content  = the ShapesOS post id (joins leads back to the post)
// Values the author already set on a URL are never overwritten. Pure.

import { normalizePlatform } from "./platforms";

export const SOCIAL_UTM_MEDIUM = "social";

export interface UtmTags {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
}

/** "Spring Launch!" → "spring-launch". Empty → null. */
export function slugCampaign(raw: string | null | undefined): string | null {
  const s = (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || null;
}

export function defaultCampaign(at: Date): string {
  return `social-${at.toISOString().slice(0, 10)}`;
}

export function utmTagsFor(opts: {
  platform: string;
  campaign: string | null | undefined;
  postId: string;
  at?: Date;
}): UtmTags {
  return {
    utm_source: normalizePlatform(opts.platform),
    utm_medium: SOCIAL_UTM_MEDIUM,
    utm_campaign: slugCampaign(opts.campaign) ?? defaultCampaign(opts.at ?? new Date()),
    utm_content: opts.postId,
  };
}

/** Add the tags to one URL; existing utm_* params win. Non-http URLs pass through. */
export function tagUrl(url: string, tags: UtmTags): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return url;
  for (const [k, v] of Object.entries(tags)) {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  }
  return u.toString();
}

// URLs in free text: stop at whitespace and common closing punctuation.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[).,;:!?\]]+$/;

/** Tag every http(s) URL found in the text (trailing punctuation kept outside). */
export function tagUrlsInText(text: string, tags: UtmTags): string {
  return text.replace(URL_RE, (match) => {
    const trail = match.match(TRAILING)?.[0] ?? "";
    const core = trail ? match.slice(0, -trail.length) : match;
    return tagUrl(core, tags) + trail;
  });
}

/**
 * The body sent to one channel: tagged text, plus the tagged link appended
 * on its own line when the text doesn't already contain it.
 */
export function buildChannelBody(opts: {
  content: string;
  link: string | null | undefined;
  platform: string;
  campaign: string | null | undefined;
  postId: string;
  at?: Date;
}): string {
  const tags = utmTagsFor(opts);
  let body = tagUrlsInText(opts.content.trim(), tags);
  const link = opts.link?.trim();
  if (link && /^https?:\/\//i.test(link) && !opts.content.includes(link)) {
    body = `${body}\n\n${tagUrl(link, tags)}`.trim();
  }
  return body;
}
