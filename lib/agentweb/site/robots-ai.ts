// ShapesOS — Phase 21A (WS=agentweb): honest crawler preferences (PURE).
//
// robots.txt with an AI-usage section the tenant controls. Three choices, in the
// vocabulary of the Content Signals proposal (contentsignals.org):
//   search   may AI search products index and cite pages
//   input    may an AI use the page to answer a user's question right now
//   train    may the page be used to train models
// Each maps to the crawlers that serve that purpose. robots.txt is ADVISORY: a
// polite crawler honors it, nothing enforces it, and our own agents honor it
// (lib/agentweb/probe.ts, page-fetch.ts). The token list is maintained by hand
// from vendors' crawler documentation and must be re-checked against it.

import { parseRobots, selectGroup } from "@/lib/intelligence/fleet/robots";

export type AiUse = "search" | "input" | "train";
export interface AiPolicy {
  search: boolean;
  input: boolean;
  train: boolean;
}

export interface AiCrawler {
  token: string;
  operator: string;
  use: AiUse;
}

export const AI_CRAWLERS: readonly AiCrawler[] = [
  { token: "GPTBot", operator: "OpenAI", use: "train" },
  { token: "ClaudeBot", operator: "Anthropic", use: "train" },
  { token: "Google-Extended", operator: "Google", use: "train" },
  { token: "Applebot-Extended", operator: "Apple", use: "train" },
  { token: "CCBot", operator: "Common Crawl", use: "train" },
  { token: "Bytespider", operator: "ByteDance", use: "train" },
  { token: "Meta-ExternalAgent", operator: "Meta", use: "train" },
  { token: "OAI-SearchBot", operator: "OpenAI", use: "search" },
  { token: "Claude-SearchBot", operator: "Anthropic", use: "search" },
  { token: "PerplexityBot", operator: "Perplexity", use: "search" },
  { token: "ChatGPT-User", operator: "OpenAI", use: "input" },
  { token: "Claude-User", operator: "Anthropic", use: "input" },
  { token: "Perplexity-User", operator: "Perplexity", use: "input" },
];

const BEGIN = "# BEGIN ShapesOS AI usage (managed: change it in Agent readiness)";
const END = "# END ShapesOS AI usage";
const yn = (b: boolean) => (b ? "yes" : "no");

function managedBlock(policy: AiPolicy): string {
  const denied = AI_CRAWLERS.filter((c) => !policy[c.use]);
  const allowed = AI_CRAWLERS.filter((c) => policy[c.use]);
  const group = (cs: readonly AiCrawler[], rule: string) => (cs.length ? [...cs.map((c) => `User-agent: ${c.token}`), rule].join("\n") : "");
  return [BEGIN, `# search: ${yn(policy.search)}, answer input: ${yn(policy.input)}, training: ${yn(policy.train)}`, [group(denied, "Disallow: /"), group(allowed, "Allow: /")].filter(Boolean).join("\n\n"), END].join("\n");
}

export function applyAiPolicy(existing: string | null, policy: AiPolicy, opts: { sitemapUrl?: string }): string {
  const signal = `Content-Signal: search=${yn(policy.search)}, ai-input=${yn(policy.input)}, ai-train=${yn(policy.train)}`;
  // Start from the site's own text without our previous block and signal.
  let base = (existing ?? "").replace(/\r\n/g, "\n");
  base = base.replace(new RegExp(`\\n?${BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${END}\\n?`, "g"), "\n").replace(/^Content-Signal:.*\n?/gim, "");
  base = base.replace(/\n{3,}/g, "\n\n").trim();
  const hasSitemap = /^sitemap:/im.test(base);
  const sitemapLine = opts.sitemapUrl && !hasSitemap ? `Sitemap: ${opts.sitemapUrl}` : "";
  if (!base) base = "User-agent: *\nAllow: /";
  // The signal goes straight after the first "User-agent: *" line (creating the group if there is none).
  if (/^user-agent:\s*\*\s*$/im.test(base)) base = base.replace(/^(user-agent:\s*\*\s*)$/im, `$1\n${signal}`);
  else base = `User-agent: *\n${signal}\nAllow: /\n\n${base}`;
  // Keep any Sitemap lines last.
  const sitemaps = [...base.matchAll(/^sitemap:.*$/gim)].map((m) => m[0]);
  const body = base.replace(/^sitemap:.*\n?/gim, "").replace(/\n{3,}/g, "\n\n").trim();
  const tail = [...sitemaps, sitemapLine].filter(Boolean).join("\n");
  return `${[body, managedBlock(policy), tail].filter(Boolean).join("\n\n")}\n`;
}

export interface AiPolicyReading {
  present: boolean;
  /** Our managed block is there. */
  managed: boolean;
  /** The site names at least one AI crawler itself. */
  explicit: boolean;
  /** Every crawler is told to stay out (Disallow: / for *). */
  blocksEveryone: boolean;
  hasSitemap: boolean;
  /** What each named AI crawler is told. */
  decided: Array<{ token: string; allowed: boolean }>;
}

export function readAiPolicy(text: string | null): AiPolicyReading {
  if (text === null) return { present: false, managed: false, explicit: false, blocksEveryone: false, hasSitemap: false, decided: [] };
  const rules = parseRobots(text);
  const star = selectGroup(rules, "zz-no-such-bot");
  const blocksEveryone = !!star && star.agents.includes("*") && star.disallow.some((p) => p === "/") && !star.allow.some((p) => p === "/");
  const decided: AiPolicyReading["decided"] = [];
  for (const c of AI_CRAWLERS) {
    const g = rules.groups.find((x) => x.agents.includes(c.token.toLowerCase()));
    if (g) decided.push({ token: c.token, allowed: !g.disallow.some((p) => p === "/") });
  }
  return { present: true, managed: text.includes(BEGIN), explicit: decided.length > 0, blocksEveryone, hasSitemap: /^sitemap:\s*\S+/im.test(text), decided };
}
