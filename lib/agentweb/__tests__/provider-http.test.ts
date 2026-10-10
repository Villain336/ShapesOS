// Phase 21A (WS=agentweb): the no-JavaScript provider. It runs the BrowserProvider
// contract against a fake network (no sockets): snapshot with refs, links, form
// submission, and the origin fence on redirects.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpBrowserProvider } from "../provider-http";
import { capabilitiesFor } from "../capabilities";
import { getBrowserProvider, ProviderUnavailableError } from "../provider";

type Handler = (req: { method: string; url: string; body: string }) => { status?: number; headers?: Record<string, string>; body?: string };

function fakeNet(routes: Record<string, Handler | string>) {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? String(init.body) : "";
    calls.push({ method, url, body });
    const route = routes[`${method} ${url}`] ?? routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    const r = typeof route === "string" ? { body: route } : route({ method, url, body });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  };
  return { fetchFn, calls };
}

const HOME = `<html><head><title>Home</title></head><body><a href="/about">About</a><a href="https://other.test/x">Partner</a>
<form action="/search" method="get"><input name="q" placeholder="Search"><button>Go</button></form>
<form action="/contact" method="post"><input type="hidden" name="csrf" value="tok"><label for="e">Email</label><input id="e" name="email" type="email"><button>Send</button></form></body></html>`;

function setup(extra: Record<string, Handler | string> = {}) {
  const net = fakeNet({
    "https://a.test/": HOME,
    "https://a.test/about": `<title>About</title><p>About us</p>`,
    "https://a.test/search?q=shoes": `<title>Results</title><p>3 results</p>`,
    "POST https://a.test/contact": () => ({ body: `<title>Thanks</title><p>Sent</p>` }),
    "https://a.test/go": () => ({ status: 302, headers: { location: "https://evil.test/landing" } }),
    "https://evil.test/landing": `<title>Evil</title>`,
    ...extra,
  });
  const provider = new HttpBrowserProvider({ fetchFn: net.fetchFn, checkUrl: async (u) => u });
  return { net, provider, caps: capabilitiesFor("https://a.test/") };
}

describe("HttpBrowserProvider", () => {
  it("navigates, lists controls with refs and reads the title", async () => {
    const { provider, caps } = setup();
    const s = await provider.open({ caps });
    const nav = await s.navigate("https://a.test/");
    assert.deepEqual([nav.url, nav.title, nav.status, nav.navigated], ["https://a.test/", "Home", 200, true]);
    const snap = await s.snapshot();
    assert.deepEqual(snap.controls.slice(0, 3).map((c) => [c.ref, c.role, c.name]), [["e1", "link", "About"], ["e2", "link", "Partner"], ["e3", "textbox", "Search"]]);
    assert.equal(s.provider, "server-http");
  });

  it("follows a same-origin link", async () => {
    const { provider, caps } = setup();
    const s = await provider.open({ caps });
    await s.navigate("https://a.test/");
    const out = await s.click("e1");
    assert.deepEqual([out.url, out.navigated], ["https://a.test/about", true]);
    assert.match(await s.html(), /About us/);
  });

  it("does not request or load an origin outside the task; the page content never arrives", async () => {
    const { provider, caps, net } = setup();
    const s = await provider.open({ caps });
    await s.navigate("https://a.test/");
    const out = await s.click("e2"); // the Partner link
    assert.deepEqual([out.blocked?.reason, out.blocked?.origin, out.navigated], ["new-origin", "https://other.test", false]);
    assert.equal(net.calls.some((c) => c.url.startsWith("https://other.test")), false);
    assert.equal(s.url(), "https://a.test/");
  });

  it("stops at a redirect to another origin without requesting it", async () => {
    const { provider, caps, net } = setup();
    const s = await provider.open({ caps });
    const nav = await s.navigate("https://a.test/go");
    assert.equal(nav.blocked?.origin, "https://evil.test");
    assert.equal(net.calls.some((c) => c.url.startsWith("https://evil.test")), false);
  });

  it("submits a GET form with what was typed", async () => {
    const { provider, caps } = setup();
    const s = await provider.open({ caps });
    await s.navigate("https://a.test/");
    await s.type("e3", "shoes");
    const out = await s.click("e4");
    assert.equal(out.url, "https://a.test/search?q=shoes");
  });

  it("submits a POST form with hidden defaults plus typed values", async () => {
    const { provider, caps, net } = setup();
    const s = await provider.open({ caps });
    await s.navigate("https://a.test/");
    await s.type("e5", "ann@example.com");
    await s.click("e6");
    const post = net.calls.find((c) => c.method === "POST")!;
    assert.equal(new URLSearchParams(post.body).get("email"), "ann@example.com");
    assert.equal(new URLSearchParams(post.body).get("csrf"), "tok");
    assert.match(await s.html(), /Sent/);
  });

  it("an allowed origin can be followed afterwards", async () => {
    const { provider, caps } = setup();
    const s = await provider.open({ caps });
    s.allowOrigin("https://evil.test");
    const nav = await s.navigate("https://evil.test/landing");
    assert.equal(nav.title, "Evil");
  });

  it("refuses an address the SSRF check refuses", async () => {
    const net = fakeNet({});
    const p = new HttpBrowserProvider({ fetchFn: net.fetchFn, checkUrl: async () => { throw new Error("private address"); } });
    const s = await p.open({ caps: capabilitiesFor("https://a.test/") });
    const nav = await s.navigate("https://a.test/");
    assert.equal(nav.blocked?.reason, "unsafe-address");
    assert.equal(net.calls.length, 0);
  });

  it("says plainly that it renders nothing", async () => {
    const { provider, caps } = setup();
    const s = await provider.open({ caps });
    assert.deepEqual(await s.screenshot(), { unavailable: "The HTTP provider reads pages without rendering them, so it cannot take a screenshot." });
    assert.equal((await s.tabs()).length, 1);
  });

  it("an unknown ref is an error, not a click somewhere else", async () => {
    const { provider, caps } = setup();
    const s = await provider.open({ caps });
    await s.navigate("https://a.test/");
    await assert.rejects(() => s.click("e99"), /No control e99/);
  });
});

describe("provider registry", () => {
  it("the Desktop live-tab provider is a documented seam, not silently faked", () => {
    assert.throws(() => getBrowserProvider("desktop-tab"), (e: unknown) => e instanceof ProviderUnavailableError && /Desktop browser/.test((e as Error).message));
  });
});
