// Marketr — Phase 11 "Canvas": starter template library.
// Every template builds a tasteful, editable starter document with real
// placeholder copy in Marketr's voice — never lorem ipsum.

import {
  DESIGN_SCHEMA_VERSION,
  newId,
  type BaseElement,
  type DesignDocument,
  type DesignElement,
  type DesignTemplate,
  type EllipseElement,
  type LineElement,
  type RectElement,
  type TextElement,
} from "./types";

// ── Palette & type ─────────────────────────────────────────────────────
const VIOLET = "#7c3aed"; // violet-600
const VIOLET_LIGHT = "#a78bfa"; // violet-400
const INK = "#1c1917"; // stone-900
const MUTED = "#78716c"; // stone-500
const PAPER = "#FAFAF7"; // light stone
const LAVENDER = "#F5F3FF"; // violet-tinted
const WHITE = "#ffffff";
const FONT = "Inter";

function base<T extends BaseElement["type"]>(
  type: T,
  name: string,
  x: number,
  y: number,
): Omit<BaseElement, "id"> & { type: T } {
  return {
    type,
    name,
    x,
    y,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  };
}

function makeText(opts: {
  name: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fill?: string;
  align?: "left" | "center" | "right";
  fontStyle?: TextElement["fontStyle"];
  width?: number;
  letterSpacing?: number;
  lineHeight?: number;
}): TextElement {
  return {
    ...base("text", opts.name, opts.x, opts.y),
    id: newId("el"),
    text: opts.text,
    fontFamily: FONT,
    fontSize: opts.fontSize,
    fontStyle: opts.fontStyle ?? "normal",
    fill: opts.fill ?? INK,
    align: opts.align ?? "left",
    lineHeight: opts.lineHeight ?? 1.25,
    letterSpacing: opts.letterSpacing ?? 0,
    width: opts.width,
  };
}

function makeRect(opts: {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  gradient?: [string, string];
  cornerRadius?: number;
  opacity?: number;
}): RectElement {
  return {
    ...base("rect", opts.name, opts.x, opts.y),
    id: newId("el"),
    width: opts.width,
    height: opts.height,
    fill: opts.fill,
    gradient: opts.gradient,
    cornerRadius: opts.cornerRadius ?? 0,
    opacity: opts.opacity ?? 1,
  };
}

function makeEllipse(opts: {
  name: string;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  fill: string;
  gradient?: [string, string];
  opacity?: number;
}): EllipseElement {
  return {
    ...base("ellipse", opts.name, opts.x, opts.y),
    id: newId("el"),
    radiusX: opts.radiusX,
    radiusY: opts.radiusY,
    fill: opts.fill,
    gradient: opts.gradient,
    opacity: opts.opacity ?? 1,
  };
}

function makeLine(opts: {
  name: string;
  x: number;
  y: number;
  points: number[];
  stroke: string;
  strokeWidth: number;
}): LineElement {
  return {
    ...base("line", opts.name, opts.x, opts.y),
    id: newId("el"),
    points: opts.points,
    stroke: opts.stroke,
    strokeWidth: opts.strokeWidth,
  };
}

// ── Starter-doc builder ────────────────────────────────────────────────

interface StarterCopy {
  eyebrow: string;
  headline: string;
  sub: string;
  cta: string;
  brand: string;
}

interface StarterSizes {
  eyebrow: number;
  headline: number;
  sub: number;
  cta: number;
}

/**
 * Centered layout for square / portrait formats: brand mark, eyebrow,
 * headline, subtext, CTA pill, footer brand line, two violet accent blobs.
 */
function centeredDoc(
  width: number,
  height: number,
  bg: string,
  copy: StarterCopy,
  s: StarterSizes,
): DesignDocument {
  const elements: DesignElement[] = [];

  elements.push(
    makeEllipse({
      name: "Accent blob top",
      x: width * 0.72,
      y: height * 0.06,
      radiusX: width * 0.32,
      radiusY: width * 0.32,
      fill: VIOLET,
      gradient: [VIOLET, VIOLET_LIGHT],
      opacity: 0.16,
    }),
    makeEllipse({
      name: "Accent blob bottom",
      x: -width * 0.1,
      y: height * 0.78,
      radiusX: width * 0.24,
      radiusY: width * 0.24,
      fill: VIOLET,
      gradient: [VIOLET, VIOLET_LIGHT],
      opacity: 0.12,
    }),
  );

  const markR = Math.max(20, width * 0.026);
  elements.push(
    makeEllipse({
      name: "Brand mark",
      x: width / 2 - markR,
      y: height * 0.13,
      radiusX: markR,
      radiusY: markR,
      fill: VIOLET,
      gradient: [VIOLET, VIOLET_LIGHT],
    }),
  );

  const eyebrowY = height * 0.22;
  elements.push(
    makeText({
      name: "Eyebrow",
      text: copy.eyebrow,
      x: 0,
      y: eyebrowY,
      fontSize: s.eyebrow,
      fill: MUTED,
      align: "center",
      width,
      letterSpacing: 3,
      fontStyle: "bold",
    }),
  );

  const headlineY = height * 0.28;
  elements.push(
    makeText({
      name: "Headline",
      text: copy.headline,
      x: width * 0.07,
      y: headlineY,
      fontSize: s.headline,
      fill: INK,
      align: "center",
      width: width * 0.86,
      fontStyle: "bold",
      lineHeight: 1.12,
    }),
  );

  const subY = headlineY + s.headline * 1.12 * 2.8;
  elements.push(
    makeText({
      name: "Subtext",
      text: copy.sub,
      x: width * 0.15,
      y: subY,
      fontSize: s.sub,
      fill: MUTED,
      align: "center",
      width: width * 0.7,
    }),
  );

  const pillW = width * 0.36;
  const pillH = Math.max(56, width * 0.062);
  const pillX = (width - pillW) / 2;
  const pillY = subY + s.sub * 1.5 + 28;
  elements.push(
    makeRect({
      name: "CTA pill",
      x: pillX,
      y: pillY,
      width: pillW,
      height: pillH,
      fill: VIOLET,
      cornerRadius: pillH / 2,
    }),
    makeText({
      name: "CTA label",
      text: copy.cta,
      x: pillX,
      y: pillY + (pillH - s.cta * 1.2) / 2,
      fontSize: s.cta,
      fill: WHITE,
      align: "center",
      width: pillW,
      fontStyle: "bold",
    }),
  );

  elements.push(
    makeText({
      name: "Footer brand",
      text: copy.brand,
      x: 0,
      y: height * 0.92,
      fontSize: s.eyebrow,
      fill: MUTED,
      align: "center",
      width,
      letterSpacing: 2,
    }),
  );

  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    pages: [
      {
        id: newId("page"),
        name: "Page 1",
        width,
        height,
        background: bg,
        elements,
      },
    ],
  };
}

/**
 * Left-aligned layout for wide / short formats: violet rule accent, eyebrow,
 * headline, subtext, CTA pill, footer brand line, one violet accent blob.
 */
function wideDoc(
  width: number,
  height: number,
  bg: string,
  copy: StarterCopy,
  s: StarterSizes,
): DesignDocument {
  const elements: DesignElement[] = [];

  elements.push(
    makeEllipse({
      name: "Accent blob right",
      x: width * 0.82,
      y: height * 0.08,
      radiusX: width * 0.24,
      radiusY: height * 0.55,
      fill: VIOLET,
      gradient: [VIOLET, VIOLET_LIGHT],
      opacity: 0.15,
    }),
  );

  const ruleH = height * 0.24;
  elements.push(
    makeLine({
      name: "Accent rule",
      x: width * 0.07,
      y: height * 0.3,
      points: [0, 0, 0, ruleH],
      stroke: VIOLET,
      strokeWidth: 6,
    }),
  );

  const colX = width * 0.1;
  elements.push(
    makeText({
      name: "Eyebrow",
      text: copy.eyebrow,
      x: colX,
      y: height * 0.26,
      fontSize: s.eyebrow,
      fill: MUTED,
      align: "left",
      letterSpacing: 3,
      fontStyle: "bold",
    }),
  );

  const headlineY = height * 0.34;
  elements.push(
    makeText({
      name: "Headline",
      text: copy.headline,
      x: colX,
      y: headlineY,
      fontSize: s.headline,
      fill: INK,
      align: "left",
      width: width * 0.52,
      fontStyle: "bold",
      lineHeight: 1.12,
    }),
  );

  const subY = headlineY + s.headline * 1.12 * 2.4;
  elements.push(
    makeText({
      name: "Subtext",
      text: copy.sub,
      x: colX,
      y: subY,
      fontSize: s.sub,
      fill: MUTED,
      align: "left",
      width: width * 0.44,
    }),
  );

  const pillW = Math.max(200, width * 0.22);
  const pillH = 54;
  const pillY = subY + s.sub * 1.5 + 30;
  elements.push(
    makeRect({
      name: "CTA pill",
      x: colX,
      y: pillY,
      width: pillW,
      height: pillH,
      fill: VIOLET,
      cornerRadius: pillH / 2,
    }),
    makeText({
      name: "CTA label",
      text: copy.cta,
      x: colX,
      y: pillY + (pillH - s.cta * 1.2) / 2,
      fontSize: s.cta,
      fill: WHITE,
      align: "center",
      width: pillW,
      fontStyle: "bold",
    }),
  );

  if (height >= 500) {
    elements.push(
      makeText({
        name: "Footer brand",
        text: copy.brand,
        x: colX,
        y: height * 0.88,
        fontSize: s.eyebrow,
        fill: MUTED,
        align: "left",
        letterSpacing: 2,
      }),
    );
  }

  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    pages: [
      {
        id: newId("page"),
        name: "Page 1",
        width,
        height,
        background: bg,
        elements,
      },
    ],
  };
}

// ── Templates ──────────────────────────────────────────────────────────

const BRAND = "yourbrand.com";

export const TEMPLATES: DesignTemplate[] = [
  {
    key: "instagram-post",
    name: "Instagram post",
    category: "social",
    width: 1080,
    height: 1080,
    description: "Square feed post with a growth-focused headline, subtext, and CTA.",
    build: () =>
      centeredDoc(
        1080,
        1080,
        PAPER,
        {
          eyebrow: "MARKETR PLAYBOOK",
          headline: "Turn followers into customers",
          sub: "Content that compounds — a growth engine that runs while you sleep.",
          cta: "Start growing",
          brand: BRAND,
        },
        { eyebrow: 20, headline: 76, sub: 28, cta: 22 },
      ),
  },
  {
    key: "instagram-story",
    name: "Instagram story",
    category: "social",
    width: 1080,
    height: 1920,
    description: "Full-bleed vertical story frame with headline, subtext, and CTA pill.",
    build: () =>
      centeredDoc(
        1080,
        1920,
        LAVENDER,
        {
          eyebrow: "GROWTH, ON AUTOPILOT",
          headline: "Your marketing, on autopilot",
          sub: "Swipe up to see how Marketr turns attention into revenue.",
          cta: "Learn more",
          brand: BRAND,
        },
        { eyebrow: 20, headline: 88, sub: 30, cta: 24 },
      ),
  },
  {
    key: "x-post",
    name: "X post image",
    category: "social",
    width: 1200,
    height: 675,
    description: "16:9 card for X with a punchy headline and CTA.",
    build: () =>
      wideDoc(
        1200,
        675,
        PAPER,
        {
          eyebrow: "THE GROWTHOS LOOP",
          headline: "Ship it. Measure it. Scale it.",
          sub: "Marketr turns every launch into a learning loop that compounds.",
          cta: "Get Marketr",
          brand: BRAND,
        },
        { eyebrow: 18, headline: 64, sub: 24, cta: 20 },
      ),
  },
  {
    key: "facebook-post",
    name: "Facebook post",
    category: "social",
    width: 1200,
    height: 630,
    description: "Feed link card with an ROI-focused headline and CTA.",
    build: () =>
      wideDoc(
        1200,
        630,
        LAVENDER,
        {
          eyebrow: "KNOW YOUR NUMBERS",
          headline: "Marketing that pays for itself",
          sub: "Know exactly which dollar drove which customer — then double down.",
          cta: "See how it works",
          brand: BRAND,
        },
        { eyebrow: 18, headline: 58, sub: 22, cta: 20 },
      ),
  },
  {
    key: "linkedin-post",
    name: "LinkedIn post",
    category: "social",
    width: 1200,
    height: 627,
    description: "Professional feed card with a pipeline-focused message.",
    build: () =>
      wideDoc(
        1200,
        627,
        PAPER,
        {
          eyebrow: "PIPELINE, NOT IMPRESSIONS",
          headline: "Pipeline, not just impressions",
          sub: "The growth system serious operators use to hit their number.",
          cta: "Book a demo",
          brand: BRAND,
        },
        { eyebrow: 18, headline: 58, sub: 22, cta: 20 },
      ),
  },
  {
    key: "blog-hero",
    name: "Blog hero",
    category: "web",
    width: 1200,
    height: 630,
    description: "Article hero banner with headline, deck, and read CTA.",
    build: () =>
      wideDoc(
        1200,
        630,
        PAPER,
        {
          eyebrow: "THE GROWTHOS PLAYBOOK",
          headline: "Build marketing that compounds",
          sub: "Field notes on turning one-off campaigns into a growth system.",
          cta: "Read the guide",
          brand: BRAND,
        },
        { eyebrow: 18, headline: 60, sub: 24, cta: 20 },
      ),
  },
  {
    key: "og-image",
    name: "OG image",
    category: "web",
    width: 1200,
    height: 630,
    description: "Open Graph share card for links and social previews.",
    build: () =>
      wideDoc(
        1200,
        630,
        LAVENDER,
        {
          eyebrow: "MARKETR",
          headline: "The marketing OS for growth",
          sub: "SEO, content, and campaigns in one agentic workspace.",
          cta: "Get started free",
          brand: BRAND,
        },
        { eyebrow: 18, headline: 58, sub: 22, cta: 20 },
      ),
  },
  {
    key: "ad-square",
    name: "Ad square",
    category: "ads",
    width: 1080,
    height: 1080,
    description: "Square paid-social creative with a bold promise and CTA.",
    build: () =>
      centeredDoc(
        1080,
        1080,
        PAPER,
        {
          eyebrow: "STOP GUESSING",
          headline: "Stop guessing. Start growing.",
          sub: "AI-powered marketing that shows its work — every dollar accounted for.",
          cta: "Start free trial",
          brand: BRAND,
        },
        { eyebrow: 20, headline: 80, sub: 28, cta: 22 },
      ),
  },
  {
    key: "ad-story",
    name: "Ad story",
    category: "ads",
    width: 1080,
    height: 1920,
    description: "Vertical paid-story creative with a bold promise and CTA.",
    build: () =>
      centeredDoc(
        1080,
        1920,
        LAVENDER,
        {
          eyebrow: "YOUR UNFAIR ADVANTAGE",
          headline: "Your unfair advantage",
          sub: "One workspace for SEO, content, and campaigns — compounding daily.",
          cta: "Try it free",
          brand: BRAND,
        },
        { eyebrow: 20, headline: 92, sub: 30, cta: 24 },
      ),
  },
  {
    key: "email-header",
    name: "Email header",
    category: "web",
    width: 1200,
    height: 400,
    description: "Short wide banner for newsletters and campaign emails.",
    build: () =>
      wideDoc(
        1200,
        400,
        PAPER,
        {
          eyebrow: "THE GROWTH BRIEF",
          headline: "This week's growth wins",
          sub: "Your weekly marketing intelligence, distilled.",
          cta: "Read now",
          brand: BRAND,
        },
        { eyebrow: 16, headline: 46, sub: 20, cta: 18 },
      ),
  },
];

export function getTemplate(key: string): DesignTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}
