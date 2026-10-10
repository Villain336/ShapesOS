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
