// Phase 21A (WS=agentweb): reading a page's text for the answer engine's depth
// step: honest user agent, robots.txt first, SSRF-safe, size-capped, text only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchPageText } from "../page-fetch";
import { AGENT_USER_AGENT } from "../probe";

const resolve = async () => ["93.184.216.34"];
function net(routes: Record<string, { status?: number; type?: string; body: string }>) {
  const seen: Array<{ url: string; ua: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, ua: new Headers(init?.headers).get("user-agent") ?? "" });
    const r = routes[url];
    return new Response(r?.body ?? "", { status: r ? (r.status ?? 200) : 404, headers: { "content-type": r?.type ?? "text/html" } });
  };
  return { fetchFn, seen };
}

describe("fetchPageText", () => {
  it("returns the visible text, without script, style or hidden content", async () => {
    const n = net({ "https://a.test/p": { body: `<title>T</title><style>x{}</style><p>Open 9 to 5.</p><div style="display:none">secret</div><script>evil()</script>` } });
    assert.equal(await fetchPageText("https://a.test/p", { fetchFn: n.fetchFn, resolve }), "Open 9 to 5.");
    assert.equal(n.seen.every((s) => s.ua === AGENT_USER_AGENT), true);
  });
  it("does not fetch what robots.txt disallows for the agent", async () => {
    const n = net({ "https://a.test/robots.txt": { type: "text/plain", body: "User-agent: shapesos-agent\nDisallow: /private" }, "https://a.test/private/x": { body: "<p>secret</p>" } });
    assert.equal(await fetchPageText("https://a.test/private/x", { fetchFn: n.fetchFn, resolve }), null);
    assert.equal(n.seen.some((s) => s.url.endsWith("/private/x")), false);
  });
  it("returns null for errors, non-HTML and private addresses", async () => {
    const n = net({ "https://a.test/e": { status: 500, body: "x" }, "https://a.test/img": { type: "image/png", body: "x" } });
    assert.equal(await fetchPageText("https://a.test/e", { fetchFn: n.fetchFn, resolve }), null);
    assert.equal(await fetchPageText("https://a.test/img", { fetchFn: n.fetchFn, resolve }), null);
    assert.equal(await fetchPageText("http://127.0.0.1/x", { fetchFn: n.fetchFn }), null);
  });
  it("clips very large pages", async () => {
    const n = net({ "https://a.test/big": { body: `<p>${"word ".repeat(100_000)}</p>` } });
    assert.ok((await fetchPageText("https://a.test/big", { fetchFn: n.fetchFn, resolve }))!.length <= 20_000);
  });
});

// ---- round 2: typed outcomes, signing, AI-usage preferences ----
import { readPage } from "../page-fetch";
import { generateKeyPair, signRequest, verifyRequest } from "../identity/httpsig";

describe("readPage (typed outcomes)", () => {
  it("reads text as before", async () => {
    const n = net({ "https://a.test/p": { body: "<p>Hello there.</p>" } });
    assert.deepEqual(await readPage("https://a.test/p", { fetchFn: n.fetchFn, resolve, signer: null }), { ok: true, text: "Hello there." });
  });

  it("a site that blocks agents is blocked_by_site with the manual path, and is NOT retried differently", async () => {
    const n = net({ "https://a.test/p": { status: 403, body: "<title>Attention Required! | Cloudflare</title>" } });
    const r = await readPage("https://a.test/p", { fetchFn: n.fetchFn, resolve, signer: null });
    assert.deepEqual(r, { ok: false, outcome: { kind: "blocked_by_site", reason: "challenge", status: 403, manualPath: true } });
    assert.equal(n.seen.filter((s) => s.url === "https://a.test/p").length, 1, "one attempt, no workaround");
  });

  it("402 is payment_required: nothing is paid, a person decides", async () => {
    const n = net({ "https://a.test/p": { status: 402, body: "pay" } });
    assert.deepEqual(await readPage("https://a.test/p", { fetchFn: n.fetchFn, resolve, signer: null }), { ok: false, outcome: { kind: "payment_required", status: 402, price: null } });
  });

  it("robots.txt and the site's AI-usage preference are honoured", async () => {
    const disallowed = net({ "https://a.test/robots.txt": { type: "text/plain", body: "User-agent: shapesos-agent\nDisallow: /" }, "https://a.test/p": { body: "x" } });
    assert.deepEqual(await readPage("https://a.test/p", { fetchFn: disallowed.fetchFn, resolve, signer: null }), { ok: false, outcome: { kind: "disallowed_by_robots" } });
    const noInput = net({ "https://a.test/robots.txt": { type: "text/plain", body: "User-agent: *\nContent-Signal: search=yes, ai-input=no, ai-train=no\nAllow: /" }, "https://a.test/p": { body: "<p>x</p>" } });
    assert.deepEqual(await readPage("https://a.test/p", { fetchFn: noInput.fetchFn, resolve, signer: null }), { ok: false, outcome: { kind: "disallowed_by_preference" } });
    assert.equal(noInput.seen.some((s) => s.url.endsWith("/p")), false);
  });

  it("signs the page request (and the robots request) with Web Bot Auth for the right host", async () => {
    const keys = generateKeyPair();
    const NOW = 1_800_000_000;
    const signer = async ({ url, method }: { url: string; method?: string }) => signRequest({ url, method, keys, created: NOW, expires: NOW + 60, signatureAgent: { url: "https://app.shapesos.test" } });
    const heads: Record<string, Record<string, string>> = {};
    const fetchFn: typeof fetch = async (input, init) => {
      heads[String(input)] = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(String(input).endsWith("robots.txt") ? "" : "<p>hi</p>", { status: String(input).endsWith("robots.txt") ? 404 : 200, headers: { "content-type": "text/html" } });
    };
    const r = await readPage("https://a.test/p", { fetchFn, resolve, signer });
    assert.equal(r.ok, true);
    const resolveKey = (id: string) => (id === keys.kid ? keys.x : null);
    assert.equal(verifyRequest({ url: "https://a.test/p", headers: heads["https://a.test/p"]!, resolveKey, now: NOW }).ok, true);
    assert.equal(verifyRequest({ url: "https://a.test/robots.txt", headers: heads["https://a.test/robots.txt"]!, resolveKey, now: NOW }).ok, true);
  });
});
