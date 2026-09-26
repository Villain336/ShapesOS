// Marketr — Phase 10 M4: robots.txt parsing for the polite fetcher.
//
// Real parser (not a substring check): parses user-agent groups, Allow /
// Disallow with `*` and `$` wildcards, and Crawl-delay. Group selection
// follows the standard: the most specific group whose user-agent line
// matches our bot wins; `*` is the fallback when nothing else matches.

export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay?: number;
}

export interface RobotsRules {
  groups: RobotsGroup[];
  /** Raw text, kept for debugging. */
  raw: string;
}

/** Our bot token, matched against `User-agent:` lines (case-insensitive,
 *  substring match — so a `User-agent: Marketr` line applies to us). */
export const FLEET_BOT_TOKEN = "marketr-competitorfleet";

export function parseRobots(txt: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // A group is "open" for more User-agent lines until a rule line appears.
  let groupOpen = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!groupOpen || !current) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        groupOpen = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (!current) continue; // rule before any user-agent: ignore
      groupOpen = false;
      if (value === "") continue; // empty Disallow = allow all
      if (field === "allow") current.allow.push(value);
      else current.disallow.push(value);
    } else if (field === "crawl-delay") {
      if (!current) continue;
      groupOpen = false;
      const secs = Number(value);
      if (Number.isFinite(secs) && secs >= 0) current.crawlDelay = secs;
    } else if (field === "sitemap") {
      // informational only for the fleet
      groupOpen = false;
    }
  }
  return { groups, raw: txt };
}

/** Select the winning group: exact/substring UA match beats `*`. Returns
 *  null when no group matches at all (then everything is allowed). */
export function selectGroup(rules: RobotsRules, botToken: string): RobotsGroup | null {
  const token = botToken.toLowerCase();
  let wildcard: RobotsGroup | null = null;
  for (const g of rules.groups) {
    let matched = false;
    for (const agent of g.agents) {
      if (agent === "*") {
        wildcard = g;
        continue;
      }
      // Standard matching: the UA line is a prefix/substring of our product
      // token, or vice versa (covers "Marketr" vs "marketr-competitorfleet").
      if (token.includes(agent) || agent.includes(token)) matched = true;
    }
    if (matched) return g;
  }
  return wildcard;
}

/** Convert a robots path pattern (`*`, `$` wildcards) to a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}`);
}

/** True when the URL's path (+query) is fetchable under the rules. Longest
 *  matching Allow/Disallow pattern wins; ties go to Allow. */
export function isAllowed(
  rules: RobotsRules,
  botToken: string,
  url: string,
): boolean {
  const group = selectGroup(rules, botToken);
  if (!group) return true;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const p of group.allow) {
    if (patternToRegExp(p).test(path)) bestAllow = Math.max(bestAllow, p.length);
  }
  for (const p of group.disallow) {
    if (patternToRegExp(p).test(path)) bestDisallow = Math.max(bestDisallow, p.length);
  }
  if (bestAllow === -1 && bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}

/** Crawl-delay (seconds) for our bot, if the winning group sets one. */
export function crawlDelayFor(rules: RobotsRules, botToken: string): number | undefined {
  const group = selectGroup(rules, botToken);
  return group?.crawlDelay;
}

export interface RobotsCache {
  get(domain: string): RobotsRules | null | undefined;
  set(domain: string, rules: RobotsRules | null): void;
}

export function createRobotsCache(): RobotsCache {
  const map = new Map<string, RobotsRules | null>();
  return {
    get: (d) => map.get(d),
    set: (d, r) => map.set(d, r),
  };
}
