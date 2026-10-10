// Phase 21A (WS=agentweb): honest crawler preferences. robots.txt plus an AI-usage
// section the tenant controls (search / answer input / training), idempotent over
// whatever the site already has. robots.txt is advisory: a polite crawler honors
// it, nothing enforces it, and we say so in the audit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAiPolicy, readAiPolicy, AI_CRAWLERS } from "../robots-ai";

const GOLDEN_ALLOW_SEARCH = `User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Allow: /

# BEGIN ShapesOS AI usage (managed: change it in Agent readiness)
# search: yes, answer input: yes, training: no
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: CCBot
User-agent: Bytespider
User-agent: Meta-ExternalAgent
Disallow: /

User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
User-agent: ChatGPT-User
User-agent: Claude-User
User-agent: Perplexity-User
Allow: /
# END ShapesOS AI usage

Sitemap: https://riverside.test/sitemap.xml
`;

describe("applyAiPolicy", () => {
  it("builds a robots.txt from scratch with the tenant's AI choices", () => {
    assert.equal(applyAiPolicy(null, { search: true, input: true, train: false }, { sitemapUrl: "https://riverside.test/sitemap.xml" }), GOLDEN_ALLOW_SEARCH);
  });

  it("is idempotent: running it again changes nothing", () => {
    const once = applyAiPolicy(null, { search: true, input: true, train: false }, { sitemapUrl: "https://riverside.test/sitemap.xml" });
    assert.equal(applyAiPolicy(once, { search: true, input: true, train: false }, { sitemapUrl: "https://riverside.test/sitemap.xml" }), once);
  });

  it("keeps what the site already says and replaces only its own block when the policy changes", () => {
    const existing = "User-agent: *\nDisallow: /admin/\n\nSitemap: https://riverside.test/sitemap.xml\n";
    const a = applyAiPolicy(existing, { search: true, input: true, train: false }, {});
    assert.match(a, /Disallow: \/admin\//);
    assert.equal(a.match(/Sitemap:/g)?.length, 1);
    const b = applyAiPolicy(a, { search: false, input: false, train: false }, {});
    assert.equal(b.match(/BEGIN ShapesOS AI usage/g)?.length, 1);
    assert.match(b, /Disallow: \/admin\//);
    assert.doesNotMatch(b, /Allow: \/\n# END/);
  });

  it("puts the content signal in the existing * group, once", () => {
    const out = applyAiPolicy("User-agent: *\nDisallow: /x\n", { search: true, input: false, train: false }, {});
    assert.equal(out.match(/Content-Signal:/g)?.length, 1);
    assert.match(out, /^User-agent: \*\nContent-Signal: search=yes, ai-input=no, ai-train=no\nDisallow: \/x/);
  });

  it("allow-everything and block-everything policies group the crawlers by decision", () => {
    const all = applyAiPolicy(null, { search: true, input: true, train: true }, {});
    assert.doesNotMatch(all, /Disallow: \/\n\nUser-agent: (OAI|Claude-S)/);
    assert.equal(all.match(/^Disallow: \/$/gm)?.length ?? 0, 0);
    const none = applyAiPolicy(null, { search: false, input: false, train: false }, {});
    assert.equal(none.match(/^Allow: \/$/gm)?.length, 1, "only the * group allows");
  });

  it("lists every crawler it manages, each with an operator and a purpose", () => {
    assert.ok(AI_CRAWLERS.length >= 12);
    for (const c of AI_CRAWLERS) assert.ok(c.token && c.operator && ["search", "input", "train"].includes(c.use), c.token);
  });
});

describe("readAiPolicy (for the audit)", () => {
  it("reports the choices in a managed block, whether it blocks everyone, and whether it names a sitemap", () => {
    const r = readAiPolicy(GOLDEN_ALLOW_SEARCH);
    assert.deepEqual([r.managed, r.explicit, r.blocksEveryone, r.hasSitemap], [true, true, false, true]);
    assert.deepEqual(r.decided.slice(0, 2), [{ token: "GPTBot", allowed: false }, { token: "ClaudeBot", allowed: false }]);
  });
  it("sees a site that blocks every crawler, and one that says nothing about AI", () => {
    assert.equal(readAiPolicy("User-agent: *\nDisallow: /\n").blocksEveryone, true);
    const plain = readAiPolicy("User-agent: *\nAllow: /\n");
    assert.deepEqual([plain.explicit, plain.managed, plain.hasSitemap], [false, false, false]);
  });
  it("counts an AI crawler named by the site itself as explicit", () => {
    assert.equal(readAiPolicy("User-agent: GPTBot\nDisallow: /\n").explicit, true);
  });
  it("nothing at all", () => {
    assert.deepEqual(readAiPolicy(null), { present: false, managed: false, explicit: false, blocksEveryone: false, hasSitemap: false, decided: [] });
  });
});
