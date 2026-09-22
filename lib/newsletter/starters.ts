// Marketr — newsletter starter templates (milestone 19).
//
// Three seeded templates (announcement, digest, promo) as Tiptap JSON email
// blocks. Operators duplicate and edit them in the composer; the seed runs
// once per project.

import type { EmailTiptapDoc } from "./blocks";

export interface StarterTemplate {
  key: string;
  name: string;
  doc: EmailTiptapDoc;
}

function textBlock(paragraphs: string[]): EmailTiptapDoc["content"][number] {
  return {
    type: "emailText",
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: [{ type: "text", text: p }],
    })),
  };
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: "announcement",
    name: "Announcement",
    doc: {
      type: "doc",
      content: [
        { type: "emailHeader", attrs: { logoUrl: "", tagline: "News from our team" } },
        {
          type: "emailHero",
          attrs: {
            title: "Something big is here",
            subtitle: "One short line on what changed and why it matters.",
            imageUrl: "",
          },
        },
        textBlock([
          "Tell the story in two or three short paragraphs. Lead with the benefit, not the feature.",
          "End with a single clear next step for the reader.",
        ]),
        { type: "emailButton", attrs: { label: "Learn more", href: "https://" } },
        { type: "emailDivider", attrs: {} },
        { type: "emailFooter", attrs: { companyName: "", address: "" } },
      ],
    },
  },
  {
    key: "digest",
    name: "Weekly digest",
    doc: {
      type: "doc",
      content: [
        { type: "emailHeader", attrs: { logoUrl: "", tagline: "Your week in review" } },
        {
          type: "emailHero",
          attrs: {
            title: "This week",
            subtitle: "The three things worth your attention.",
            imageUrl: "",
          },
        },
        textBlock(["**1. Headline one** — one sentence on why it matters."]),
        textBlock(["**2. Headline two** — one sentence on why it matters."]),
        textBlock(["**3. Headline three** — one sentence on why it matters."]),
        { type: "emailButton", attrs: { label: "Read the full roundup", href: "https://" } },
        { type: "emailDivider", attrs: {} },
        { type: "emailFooter", attrs: { companyName: "", address: "" } },
      ],
    },
  },
  {
    key: "promo",
    name: "Promotion",
    doc: {
      type: "doc",
      content: [
        { type: "emailHeader", attrs: { logoUrl: "", tagline: "A special offer, just for subscribers" } },
        {
          type: "emailHero",
          attrs: {
            title: "20% off this week",
            subtitle: "Use the code at checkout before Sunday.",
            imageUrl: "",
          },
        },
        textBlock([
          "Keep the offer brutally simple: what they get, how to claim it, when it expires.",
        ]),
        { type: "emailButton", attrs: { label: "Claim the offer", href: "https://" } },
        { type: "emailDivider", attrs: {} },
        textBlock(["Fine print goes here in one quiet line."]),
        { type: "emailFooter", attrs: { companyName: "", address: "" } },
      ],
    },
  },
];
