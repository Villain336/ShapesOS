// Marketr — Phase 10 M5: held-out keyword set for the live eval.
//
// 60 keywords, US locale, spanning the difficulty deciles (long-tail → head).
// The `anchor` field is the author's rough expectation ONLY — it is never
// used as eval truth. Truth comes from DataForSEO `labs/bulk_keyword_difficulty`
// in scripts/eval-difficulty.mts --live. The anchors exist so a human can
// sanity-scan the live run ("did the vendor agree this is easy?").
//
// No vendor data is stored here — just keyword strings.

export interface HeldOutKeyword {
  keyword: string;
  locale: string;
  /** Author's rough expectation (not truth): easy | medium | hard. */
  anchor: "easy" | "medium" | "hard";
}

const LOCALE = "en-US";

const EASY = [
  "best ergonomic office chair for short people under $200",
  "how to propagate pothos in water step by step",
  "quietest window air conditioner for bedroom 2026",
  "sourdough starter feeding schedule for beginners",
  "best budget microphone for podcasting under $50",
  "how to remove hard water stains from shower glass",
  "vegan protein powder without stevia aftertaste",
  "small apartment composting without smell",
  "best hiking socks to prevent blisters women",
  "how to train a rescue dog not to jump",
  "affordable standing desk converter for small desk",
  "best non toxic cookware set for gas stove",
  "how to fix squeaky hardwood floors upstairs",
  "indoor plants that survive low light apartments",
  "best carry on luggage for international travel 2026",
  "how to season a cast iron skillet first time",
  "gluten free pizza dough recipe no xanthan gum",
  "best blue light glasses for night shift workers",
  "how to grow tomatoes on a balcony container",
  "cheapest way to soundproof a home office",
];

const MEDIUM = [
  "project management software for small teams",
  "best crm for real estate agents",
  "email marketing platform comparison",
  "how to start a dropshipping business",
  "best home security camera system",
  "content marketing strategy template",
  "affordable payroll software for startups",
  "best mattress for back pain side sleepers",
  "how to improve website conversion rate",
  "social media scheduling tool for agencies",
  "best robo advisor for beginners",
  "how to write a business plan template",
  "video editing software for youtube beginners",
  "best vpn for streaming 2026",
  "how to lower bounce rate ecommerce",
  "customer feedback survey best practices",
  "best accounting software for freelancers",
  "how to rank higher on google maps",
  "meal kit delivery service comparison",
  "best online course platform for creators",
];

const HARD = [
  "insurance",
  "credit cards",
  "mortgage rates",
  "car insurance quotes",
  "personal loans",
  "best credit card for travel",
  "life insurance",
  "auto insurance",
  "health insurance plans",
  "seo services",
  "web hosting",
  "project management software",
  "crm software",
  "email marketing",
  "payroll services",
  "business loans",
  "merchant services",
  "voip phone service",
  "hr software",
  "pos system for retail",
];

export const HELD_OUT_KEYWORDS: HeldOutKeyword[] = [
  ...EASY.map((keyword) => ({ keyword, locale: LOCALE, anchor: "easy" as const })),
  ...MEDIUM.map((keyword) => ({ keyword, locale: LOCALE, anchor: "medium" as const })),
  ...HARD.map((keyword) => ({ keyword, locale: LOCALE, anchor: "hard" as const })),
];

export const HELD_OUT_COUNT = HELD_OUT_KEYWORDS.length; // 60
