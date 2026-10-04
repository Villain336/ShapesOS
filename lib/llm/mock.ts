// Marketr — mock LLM provider.
//
// Used automatically when no LLM credentials are configured (see ./index).
// Returns a fixed, clearly-marked sample draft so the full brief → draft →
// edit → publish flow works end-to-end without a paid API key. The returned
// markdown is labeled at the top and the UI shows the provider banner, so it
// can never be mistaken for a real draft. Never ship it as real output.

import type { LlmGenerateOptions, LlmProvider } from "./types";

export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";
  readonly isLive = false;

  isConfigured(): boolean {
    return true;
  }

  async generate(prompt: string, _opts?: LlmGenerateOptions): Promise<string> {
    // Pull the target keyword out of the prompt so the sample draft reads
    // plausibly. Everything else is fixed sample copy, clearly labeled.
    const m = prompt.match(/targeting the keyword:\s*"([^"]+)"/i);
    const keyword = m?.[1] ?? "your keyword";
    const titleCase = keyword.replace(/\b\w/g, (c) => c.toUpperCase());

    return [
      `> **Mock draft** — this placeholder was generated without an LLM.`,
      `> Set \`LLM_API_KEY\` (or \`OPENAI_API_KEY\`) and \`LLM_MODEL\` in \`.env\` for real AI drafts.`,
      ``,
      `# ${titleCase}: The Complete Guide`,
      ``,
      `If you're researching ${keyword}, you're in the right place. This guide covers what ${keyword} is, how much it costs, how to choose the right option, and the mistakes most people make along the way.`,
      ``,
      `## What Is ${titleCase}?`,
      ``,
      `${titleCase} is one of the most searched topics in its category for a reason: getting it right saves time and money, and getting it wrong is expensive. In this section we define the term plainly and explain who it's for.`,
      ``,
      `## How to Choose the Right Option`,
      ``,
      `Start with your budget, then compare the top-rated options on features that actually matter: reliability, support, and total cost of ownership. Avoid choosing on price alone — the cheapest option is rarely the best value.`,
      ``,
      `## Frequently Asked Questions`,
      ``,
      `**How much does ${keyword} cost?** Prices vary by provider and scope, so get at least three quotes before deciding.`,
      ``,
      `**Is ${keyword} worth it?** For most people, yes — provided you choose a reputable provider and understand what's included.`,
      ``,
      `## Next Steps`,
      ``,
      `Ready to move forward? Compare your top three options, check reviews, and book a consultation. (Replace this mock copy with a real draft by connecting an LLM provider.)`,
      ``,
    ].join("\n");
  }
}
