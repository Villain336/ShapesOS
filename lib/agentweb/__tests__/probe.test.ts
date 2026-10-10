// Phase 21A (WS=agentweb): probing a site for the interfaces it declares to
// agents. Honest about who is asking, polite about robots.txt, SSRF-safe.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeSite, AGENT_USER_AGENT, AGENT_BOT_TOKEN } from "../probe";

function net(routes: Record<string, { status?: number; body?: string }>) {
  const seen: Array<{ url: string; ua: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, ua: new Headers(init?.headers).get("user-agent") ?? "" });
    const r = routes[url];
    return new Response(r?.body ?? "", { status: r ? (r.status ?? 200) : 404 });
  };
  return { fetchFn, seen };
}
const resolve = async () => ["93.184.216.34"];

describe("probeSite", () => {
  it("fetches the well-known files and returns the ones that exist", async () => {
    const n = net({
      "https://a.test/robots.txt": { body: "User-agent: *\nAllow: /" },
      "https://a.test/llms.txt": { body: "# A" },
      "https://a.test/openapi.json": { body: "{}" },
    });
    const p = await probeSite("https://a.test", "<html></html>", { fetchFn: n.fetchFn, resolve });
    assert.equal(p.origin, "https://a.test");
    assert.equal(p.files["/llms.txt"]?.status, 200);
    assert.equal(p.files["/openapi.json"]?.body, "{}");
    assert.equal(p.files["/swagger.json"]?.status, 404);
  });

  it("says plainly who it is on every request", async () => {
    const n = net({});
    await probeSite("https://a.test", "", { fetchFn: n.fetchFn, resolve });
    assert.ok(n.seen.length > 3);
    assert.equal(n.seen.every((s) => s.ua === AGENT_USER_AGENT), true);
    assert.match(AGENT_USER_AGENT, /^ShapesOS-Agent\//);
  });

  it("does not request what robots.txt disallows for our agent", async () => {
    const n = net({ "https://a.test/robots.txt": { body: `User-agent: ${AGENT_BOT_TOKEN}\nDisallow: /openapi.json\nDisallow: /ask` }, "https://a.test/openapi.json": { body: "{}" } });
    const p = await probeSite("https://a.test", "", { fetchFn: n.fetchFn, resolve });
    assert.equal(n.seen.some((s) => s.url === "https://a.test/openapi.json"), false);
    assert.equal(n.seen.some((s) => s.url.startsWith("https://a.test/ask")), false);
    assert.equal(p.files["/openapi.json"]?.status, 403);
  });

  it("never touches a private address", async () => {
    const n = net({});
    const p = await probeSite("http://127.0.0.1:9", "", { fetchFn: n.fetchFn });
    assert.equal(n.seen.length, 0);
    assert.deepEqual(p.files, {});
  });

  it("clips very large files", async () => {
    const n = net({ "https://a.test/llms.txt": { body: "x".repeat(900_000) } });
    const p = await probeSite("https://a.test", "", { fetchFn: n.fetchFn, resolve });
    assert.ok(p.files["/llms.txt"]!.body.length <= 200_000);
  });
});
