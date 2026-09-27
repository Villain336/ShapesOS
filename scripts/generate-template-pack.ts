// Marketr — Phase 11 "Canvas": curated template pack GENERATOR.
// Run: npx tsx scripts/generate-template-pack.ts
// Composes layout families × palettes × real copy into DesignDocuments,
// validates every document against the schema, runs geometric sanity checks,
// and writes lib/design/template-data/pack.json (data the registry imports).
//
// Re-run any time; output is deterministic (no random ids — `${key}-e${n}`).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateDesignDocument } from "../lib/design/validate";
import type { DesignDocument, DesignElement, TextElement } from "../lib/design/types";
import {
  AnyCopy, CopyShape, Ctx, DARK_PALETTES, estW, LAYOUTS, LIGHT_PALETTES,
  makeDoc, SIZES,
} from "./template-pack/layouts";
import { COPY, type TypeBanks } from "./template-pack/copy";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "lib", "design", "template-data", "pack.json");

interface TypePlan {
  size: string;
  name: string;
  category: "social" | "ads" | "web" | "print";
  blurb: string;
  layouts: string[];
  count: number;
}

const PLAN: TypePlan[] = [
  { size: "instagram-post", name: "Instagram post", category: "social", blurb: "square feed post", layouts: ["heroCentered", "badgeTop", "darkBold", "productSpotlight", "minimalFrame", "announcementBar"], count: 12 },
  { size: "instagram-story", name: "Instagram story", category: "social", blurb: "full-bleed vertical story", layouts: ["heroCentered", "announcementBar", "darkBold", "badgeTop", "saleBurst", "minimalFrame"], count: 10 },
  { size: "x-post", name: "X post", category: "social", blurb: "16:9 X feed card", layouts: ["splitLeft", "heroCentered", "badgeTop", "darkBold", "announcementBar", "minimalFrame"], count: 8 },
  { size: "facebook-post", name: "Facebook post", category: "social", blurb: "Facebook feed card", layouts: ["splitLeft", "badgeTop", "heroCentered", "announcementBar", "darkBold", "minimalFrame"], count: 8 },
  { size: "linkedin-post", name: "LinkedIn post", category: "social", blurb: "LinkedIn feed card", layouts: ["splitLeft", "badgeTop", "minimalFrame", "darkBold", "announcementBar", "heroCentered"], count: 8 },
  { size: "youtube-thumbnail", name: "YouTube thumbnail", category: "social", blurb: "16:9 video thumbnail", layouts: ["darkBold", "badgeTop", "splitLeft", "heroCentered", "announcementBar"], count: 10 },
  { size: "x-header", name: "X header", category: "social", blurb: "X profile banner", layouts: ["splitLeft", "announcementBar", "minimalFrame", "darkBold"], count: 6 },
  { size: "facebook-cover", name: "Facebook cover", category: "social", blurb: "Facebook page cover", layouts: ["splitLeft", "badgeTop", "announcementBar", "darkBold"], count: 6 },
  { size: "linkedin-banner", name: "LinkedIn banner", category: "social", blurb: "LinkedIn profile banner", layouts: ["splitLeft", "minimalFrame", "announcementBar", "darkBold"], count: 6 },
  { size: "pinterest-pin", name: "Pinterest pin", category: "social", blurb: "2:3 Pinterest pin", layouts: ["heroCentered", "badgeTop", "productSpotlight", "announcementBar", "minimalFrame", "darkBold"], count: 8 },
  { size: "tiktok-cover", name: "TikTok cover", category: "social", blurb: "vertical video cover", layouts: ["darkBold", "heroCentered", "badgeTop", "announcementBar"], count: 6 },
  { size: "blog-hero", name: "Blog hero", category: "web", blurb: "article hero banner", layouts: ["splitLeft", "badgeTop", "minimalFrame", "announcementBar"], count: 6 },
  { size: "og-image", name: "OG image", category: "web", blurb: "Open Graph share card", layouts: ["splitLeft", "heroCentered", "badgeTop", "darkBold"], count: 6 },
  { size: "email-header", name: "Email header", category: "web", blurb: "newsletter header banner", layouts: ["announcementBar", "splitLeft", "badgeTop", "minimalFrame"], count: 8 },
  { size: "newsletter-header", name: "Newsletter header", category: "web", blurb: "newsletter masthead", layouts: ["announcementBar", "splitLeft", "minimalFrame", "badgeTop"], count: 6 },
  { size: "podcast-cover", name: "Podcast cover", category: "web", blurb: "square podcast artwork", layouts: ["heroCentered", "darkBold", "badgeTop", "minimalFrame"], count: 6 },
  { size: "ebook-cover", name: "Ebook cover", category: "web", blurb: "tall ebook cover", layouts: ["heroCentered", "darkBold", "badgeTop"], count: 6 },
  { size: "case-study-card", name: "Case study card", category: "web", blurb: "results case-study card", layouts: ["statRow", "splitLeft", "badgeTop", "minimalFrame"], count: 6 },
  { size: "ad-square", name: "Square ad", category: "ads", blurb: "square paid-social ad", layouts: ["heroCentered", "saleBurst", "badgeTop", "darkBold", "productSpotlight", "announcementBar"], count: 10 },
  { size: "ad-story", name: "Story ad", category: "ads", blurb: "vertical paid-story ad", layouts: ["heroCentered", "saleBurst", "darkBold", "announcementBar", "badgeTop"], count: 8 },
  { size: "sale-promo", name: "Sale promo", category: "ads", blurb: "sale and promo creative", layouts: ["saleBurst", "heroCentered", "badgeTop", "darkBold", "announcementBar"], count: 10 },
  { size: "webinar-promo", name: "Webinar promo", category: "ads", blurb: "webinar registration creative", layouts: ["heroCentered", "badgeTop", "announcementBar", "darkBold", "minimalFrame"], count: 8 },
  { size: "product-launch", name: "Product launch", category: "ads", blurb: "product launch announcement", layouts: ["splitLeft", "heroCentered", "badgeTop", "darkBold", "announcementBar"], count: 8 },
  { size: "holiday-sale", name: "Holiday sale", category: "ads", blurb: "holiday sale creative", layouts: ["saleBurst", "heroCentered", "darkBold", "badgeTop", "announcementBar"], count: 8 },
  { size: "testimonial-card", name: "Testimonial card", category: "print", blurb: "customer testimonial card", layouts: ["testimonial"], count: 8 },
  { size: "quote-card", name: "Quote card", category: "print", blurb: "branded quote card", layouts: ["quoteCard"], count: 8 },
  { size: "hiring-post", name: "Hiring post", category: "print", blurb: "we're-hiring announcement", layouts: ["splitLeft", "badgeTop", "minimalFrame", "announcementBar"], count: 6 },
  { size: "event-invite", name: "Event invite", category: "print", blurb: "event invitation", layouts: ["heroCentered", "badgeTop", "announcementBar", "darkBold", "minimalFrame"], count: 6 },
  { size: "stat-card", name: "Stat card", category: "print", blurb: "stats and milestones card", layouts: ["statRow"], count: 8 },
  { size: "before-after", name: "Before / after", category: "print", blurb: "before/after transformation card", layouts: ["beforeAfter"], count: 6 },
  { size: "checklist", name: "Checklist card", category: "print", blurb: "checklist card", layouts: ["checklist"], count: 6 },
];

function withBrand(copy: AnyCopy): AnyCopy {
  const c = copy as { brand?: string };
  if (c.brand) return copy;
  return { ...copy, brand: "yourbrand.com" } as AnyCopy;
}

function bankFor(banks: TypeBanks, shape: CopyShape): AnyCopy[] {
  const b = banks[shape] as AnyCopy[] | undefined;
  if (!b || b.length === 0) throw new Error(`missing copy bank for shape "${shape}"`);
  return b;
}

/** Geometric sanity: non-decor elements must sit (roughly) on the page. */
function sanityCheck(key: string, w: number, h: number, elements: DesignElement[]): void {
  const fail = (msg: string): never => {
    throw new Error(`sanity ${key}: ${msg}`);
  };
  for (const el of elements) {
    if (el.name.startsWith("Decor ")) continue;
    const inX = (x: number): boolean => x >= -0.04 * w && x <= 1.04 * w;
    const inY = (y: number): boolean => y >= -0.04 * h && y <= 1.04 * h;
    switch (el.type) {
      case "text": {
        const t = el as TextElement;
        const bold = t.fontStyle === "bold" || t.fontStyle === "bold-italic";
        const lines = t.width ? Math.max(1, Math.ceil(estW(t.text, t.fontSize, bold, t.letterSpacing) / t.width)) : t.text.split("\n").length;
        if (lines > 8) fail(`${t.name}: ${lines} wrapped lines (overflow risk)`);
        const boxW = t.width ?? estW(t.text, t.fontSize, bold, t.letterSpacing);
        const boxH = t.fontSize * t.lineHeight * lines;
        if (!inX(t.x) || !inX(t.x + boxW)) fail(`${t.name}: x out of bounds (${t.x}, w=${boxW})`);
        if (!inY(t.y) || !inY(t.y + boxH)) fail(`${t.name}: y out of bounds (${t.y}, h=${boxH})`);
        break;
      }
      case "rect": {
        const r = el as { x: number; y: number; width: number; height: number };
        if (!inX(r.x) || !inX(r.x + r.width)) fail(`${el.name}: rect x out of bounds`);
        if (!inY(r.y) || !inY(r.y + r.height)) fail(`${el.name}: rect y out of bounds`);
        break;
      }
      case "ellipse": {
        const e = el as { x: number; y: number; radiusX: number; radiusY: number };
        if (!inX(e.x - e.radiusX) || !inX(e.x + e.radiusX)) fail(`${el.name}: ellipse x out of bounds`);
        if (!inY(e.y - e.radiusY) || !inY(e.y + e.radiusY)) fail(`${el.name}: ellipse y out of bounds`);
        break;
      }
      case "svg": {
        const s = el as { x: number; y: number; width: number; height: number };
        if (!inX(s.x) || !inX(s.x + s.width)) fail(`${el.name}: svg x out of bounds`);
        if (!inY(s.y) || !inY(s.y + s.height)) fail(`${el.name}: svg y out of bounds`);
        break;
      }
      case "line": {
        const l = el as { x: number; y: number; points: number[] };
        const xs = l.points.filter((_, i) => i % 2 === 0).map((px) => l.x + px);
        const ys = l.points.filter((_, i) => i % 2 === 1).map((py) => l.y + py);
        for (const x of xs) if (!inX(x)) fail(`${el.name}: line x out of bounds`);
        for (const y of ys) if (!inY(y)) fail(`${el.name}: line y out of bounds`);
        break;
      }
      default:
        break;
    }
  }
}

interface PackEntry {
  key: string;
  name: string;
  category: string;
  width: number;
  height: number;
  description: string;
  document: DesignDocument;
}

function main(): void {
  const entries: PackEntry[] = [];
  const seen = new Set<string>();
  for (const plan of PLAN) {
    const size = SIZES[plan.size];
    if (!size) throw new Error(`unknown size "${plan.size}"`);
    const banks = COPY[plan.size];
    if (!banks) throw new Error(`missing copy banks for "${plan.size}"`);
    for (let i = 0; i < plan.count; i++) {
      const layoutId = plan.layouts[i % plan.layouts.length]!;
      const layout = LAYOUTS[layoutId];
      if (!layout) throw new Error(`unknown layout "${layoutId}"`);
      const pal = layout.dark
        ? DARK_PALETTES[i % DARK_PALETTES.length]!
        : LIGHT_PALETTES[i % LIGHT_PALETTES.length]!;
      const bank = bankFor(banks, layout.shape);
      const copy = withBrand(bank[i % bank.length]!);
      const key = `${plan.size}-v${i + 1}`;
      if (seen.has(key)) throw new Error(`duplicate key ${key}`);
      seen.add(key);
      const ctx: Ctx = { key, w: size.w, h: size.h, pal, seq: 0 };
      let elements: DesignElement[];
      try {
        elements = layout.build(ctx, copy);
      } catch (e) {
        throw new Error(`build failed for ${key} (${layoutId}): ${(e as Error).message}`);
      }
      sanityCheck(key, size.w, size.h, elements);
      const doc = makeDoc(ctx, elements, pal.bg);
      const v = validateDesignDocument(doc);
      if (!v.ok) throw new Error(`schema validation failed for ${key}: ${v.error}`);
      // No lorem ipsum, no blank text.
      for (const el of doc.pages[0]!.elements) {
        if (el.type === "text") {
          const t = (el as TextElement).text;
          if (/lorem/i.test(t)) throw new Error(`${key}: lorem ipsum in "${el.name}"`);
          if (!t.trim()) throw new Error(`${key}: blank text in "${el.name}"`);
        }
      }
      entries.push({
        key,
        name: `${plan.name} · V${i + 1}`,
        category: plan.category,
        width: size.w,
        height: size.h,
        description: `${layout.label} layout · ${pal.label} palette — ${plan.blurb}.`,
        document: doc,
      });
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(entries));
  const bytes = JSON.stringify(entries).length;
  console.log(`wrote ${entries.length} templates → ${OUT} (${(bytes / 1024).toFixed(0)} KB)`);
  const byType = new Map<string, number>();
  for (const e of entries) byType.set(e.key.split("-v")[0]!, (byType.get(e.key.split("-v")[0]!) ?? 0) + 1);
  for (const [t, n] of [...byType.entries()].sort()) console.log(`  ${t}: ${n}`);
}

main();
