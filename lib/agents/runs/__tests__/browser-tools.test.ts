// ShapesOS — Phase 8: recorded browser tools. The SSRF guard refuses private
// and internal URLs before any browser starts and on every request the
// browser makes; steps are validated; typed values never reach the timeline.
// The browser run is stubbed (no Chromium, no database).
// Run: npx tsx --test lib/agents/runs/__tests__/browser-tools.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl } from "@/lib/safe-url";
import type { ToolContext, ToolDef } from "@/lib/chat/tools";
import { TOOL_GROUP, TOOL_ACTION } from "@/lib/chat/tools";
import { createBrowserTools, makeRequestGuard, parseSteps, type BrowserToolDeps } from "../browser-tools";
import type { BrowserRunDeps, BrowserRunRequest } from "../lifecycle";
import type { RecorderPage } from "../recorder";
import type { AgentRunEventInput } from "../types";

// Public names resolve to a public address; everything else to loopback. No DNS.
const checkUrl = (url: string) =>
  assertSafeUrl(url, { resolve: async (h) => (h.endsWith(".example.com") || h === "example.com" ? ["93.184.216.34"] : ["127.0.0.1"]) });

function harness() {
  const runs: BrowserRunRequest[] = [];
  const actions: Array<{ summary: string; payload?: Record<string, unknown> }> = [];
  const linked: AgentRunEventInput[] = [];
  const calls: string[] = [];
  const page: RecorderPage = {
    goto: async (u) => void calls.push(`goto ${u}`),
    click: async (s) => void calls.push(`click ${s}`),
    fill: async (s, v) => void calls.push(`fill ${s}=${v}`),
    waitFor: async (t) => void calls.push(`wait ${t.selector ?? t.ms}`),
    screenshot: async (p) => void calls.push(`shot ${p.split("/").pop()}`),
    extract: async (sel) => (sel === "body" ? ["Hello page"] : ["One", "Two"]),
    title: async () => "Example",
    url: () => "https://www.example.com/after",
  };
  const deps: BrowserToolDeps = {
    checkUrl,
    recordEvent: async (_ws, _run, e) => void linked.push(e),
    runBrowser: async (req: BrowserRunRequest, d: BrowserRunDeps) => {
      runs.push(req);
      const out = await d.execute({
        page,
        recordAction: async (summary, payload) => void actions.push({ summary, payload }),
        artifactDir: "/tmp/run-artifacts/b1",
        runId: "browser-run-1",
      });
      return { runId: "browser-run-1", status: "succeeded", videoPath: null, tracePath: "t", stepCount: actions.length, sizeBytes: 0, result: out.result };
    },
  };
  const tools = new Map<string, ToolDef>(createBrowserTools(deps).map((t) => [t.name, t]));
  return { tools, runs, actions, linked, calls };
}

const ctx: ToolContext & { threadId: string } = {
  projectId: "p",
  workspaceId: "ws",
  userId: "u",
  role: "editor",
  confirmed: true,
  runId: "run-1",
  threadId: `t-${Math.random()}`,
};

describe("browser tools", () => {
  it("sit in the web group: open/extract are safe, act is spend + browser_act (Tier 2)", () => {
    const { tools } = harness();
    assert.equal(tools.get("browser_open")!.kind, "safe");
    assert.equal(tools.get("browser_extract")!.kind, "safe");
    assert.equal(tools.get("browser_act")!.kind, "spend");
    for (const n of ["browser_open", "browser_extract", "browser_act"]) assert.equal(TOOL_GROUP[n], "web");
    assert.equal(TOOL_ACTION.browser_act, "browser_act");
  });

  it("refuse private / internal / non-http URLs before any browser starts", async () => {
    const h = harness();
    for (const url of [
      "http://127.0.0.1:3000/admin",
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://metadata.google.internal/",
      "http://internal.corp/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@www.example.com/",
    ]) {
      await assert.rejects(() => h.tools.get("browser_open")!.execute(ctx, { url }), /can't be opened/, url);
      await assert.rejects(() => h.tools.get("browser_extract")!.execute(ctx, { url, selector: "h1" }), /can't be opened/, url);
      await assert.rejects(
        () => h.tools.get("browser_act")!.execute(ctx, { url, steps: [{ action: "click", selector: "a" }] }),
        /can't be opened/,
        url,
      );
    }
    assert.equal(h.runs.length, 0, "no browser run started");
  });

  it("the per-request guard blocks internal hops (redirects, subresources) and allows public ones", async () => {
    const guard = makeRequestGuard(checkUrl);
    assert.equal(await guard("https://www.example.com/page"), true);
    assert.equal(await guard("http://169.254.169.254/latest"), false);
    assert.equal(await guard("http://127.0.0.1:5432/"), false);
    assert.equal(await guard("ftp://www.example.com/"), false);
    assert.equal(await guard("not a url"), false);
  });

  it("browser_open records into a child browser run and links it on the calling run", async () => {
    const h = harness();
    const res = await h.tools.get("browser_open")!.execute(ctx, { url: "https://www.example.com/" });
    // Phase 21A: page text is labelled as third-party data.
    assert.match(res.summary, /Example — https:\/\/www\.example\.com\/after\n<untrusted_page_data origin="https:\/\/www\.example\.com"[^>]*>\nHello page\n<\/untrusted_page_data>/);
    const req = h.runs[0]!;
    assert.equal(req.parentRunId, "run-1");
    assert.equal(req.threadId, ctx.threadId);
    assert.equal(req.startUrl, "https://www.example.com");
    assert.equal(typeof req.guardRequest, "function", "every request is guarded");
    assert.equal(h.actions.length, 1);
    assert.equal(h.linked[0]!.payload!.browserRunId, "browser-run-1");
    assert.equal((res.details as Record<string, unknown>).recordedRunEvent, true);
  });

  it("browser_act runs steps in order, records each, and never records typed values", async () => {
    const h = harness();
    await h.tools.get("browser_open")!.execute(ctx, { url: "https://www.example.com/" });
    const res = await h.tools.get("browser_act")!.execute(ctx, {
      steps: JSON.stringify([
        { action: "fill", selector: "#email", value: "secret-pass-123" },
        { action: "click", selector: "button[type=submit]" },
        { action: "wait", ms: 500 },
        { action: "screenshot" },
      ]),
    });
    assert.match(res.summary, /Ran 4 steps/);
    assert.deepEqual(h.calls.slice(0, 3), ["fill #email=secret-pass-123", "click button[type=submit]", "wait 500"]);
    assert.match(h.calls[3]!, /^shot step-\d+-4\.png$/);
    assert.equal(h.runs.at(-1)!.startUrl, "https://www.example.com/after", "defaults to the last page opened");
    const timeline = JSON.stringify([h.actions, h.linked]);
    assert.ok(!timeline.includes("secret-pass-123"), "typed value never on the timeline");
    assert.ok(timeline.includes('"chars":15'));
  });

  it("browser_extract returns the matching elements' text", async () => {
    const h = harness();
    const res = await h.tools.get("browser_extract")!.execute(ctx, { url: "https://shop.example.com/", selector: "h2" });
    assert.match(res.summary, /^<untrusted_page_data origin="https:\/\/www\.example\.com"[^>]*>\n1\. One\n2\. Two\n<\/untrusted_page_data>$/);
  });

  describe("Phase 21A: browser_act is judged against the page, step by step", () => {
    type Described = NonNullable<Awaited<ReturnType<NonNullable<RecorderPage["describe"]>>>>;
    const els: Record<string, Described> = {
      "#menu": { role: "button", name: "Menu", tag: "button" },
      "#order": { role: "button", name: "Place order", tag: "button", form: { action: "https://www.example.com/checkout/pay", method: "post", fields: [{ type: "text", autocomplete: "cc-number" }] } },
      "#pw": { role: "textbox", name: "Password", tag: "input", type: "password" },
      "#send": { role: "button", name: "Send message", tag: "button", form: { action: "https://www.example.com/contact", method: "post", fields: [{ type: "email" }, { type: "textarea" }] } },
      "#away": { role: "link", name: "Offers", tag: "a", href: "https://www.example.com/offers" },
    };
    function gated(landAt = "https://www.example.com/after") {
      let current = "https://www.example.com/after";
      const calls: string[] = [];
      const page: RecorderPage = {
        goto: async () => undefined,
        click: async (s) => {
          calls.push(`click ${s}`);
          if (s === "#away") current = landAt;
        },
        fill: async (s, v) => void calls.push(`fill ${s}=${v}`),
        extract: async () => ["Visible page text"],
        title: async () => "Example",
        url: () => current,
        describe: async (sel) => els[sel] ?? null,
      };
      const actions: Array<{ summary: string; payload?: Record<string, unknown> }> = [];
      const deps: BrowserToolDeps = {
        checkUrl,
        recordEvent: async () => undefined,
        runBrowser: async (_req, d) => {
          const out = await d.execute({ page, recordAction: async (summary, payload) => void actions.push({ summary, payload }), artifactDir: "/tmp/x", runId: "b2" });
          return { runId: "b2", status: "succeeded", videoPath: null, tracePath: "t", stepCount: 0, sizeBytes: 0, result: out.result };
        },
      };
      const act = createBrowserTools(deps).find((t) => t.name === "browser_act")!;
      return { act, calls, actions };
    }
    const run = (act: ToolDef, steps: unknown[], over: Partial<ToolContext> = {}) => act.execute({ ...ctx, threadId: `g-${Math.random()}`, ...over } as ToolContext, { url: "https://www.example.com/start", steps });

    it("ordinary steps run", async () => {
      const g = gated();
      const res = await run(g.act, [{ action: "click", selector: "#menu" }]);
      assert.deepEqual(g.calls, ["click #menu"]);
      assert.match(res.summary, /Ran 1 step/);
    });

    it("a payment click is stopped even though the person confirmed the call", async () => {
      const g = gated();
      const res = await run(g.act, [{ action: "click", selector: "#menu" }, { action: "click", selector: "#order" }, { action: "click", selector: "#menu" }]);
      assert.deepEqual(g.calls, ["click #menu"]);
      assert.match(res.summary, /Ran 1 of 3 steps, then stopped before step 2/);
      assert.match(res.summary, /do it themselves/);
    });

    it("a password field is never filled and the value is not recorded", async () => {
      const g = gated();
      const res = await run(g.act, [{ action: "fill", selector: "#pw", value: "hunter2-secret" }]);
      assert.deepEqual(g.calls, []);
      assert.match(res.summary, /stopped before step 1/);
      assert.ok(!JSON.stringify(g.actions).includes("hunter2-secret"));
    });

    it("sending runs only because the call was confirmed", async () => {
      const yes = gated();
      await run(yes.act, [{ action: "click", selector: "#send" }], { confirmed: true });
      assert.deepEqual(yes.calls, ["click #send"]);
      const no = gated();
      const res = await run(no.act, [{ action: "click", selector: "#send" }], { confirmed: false });
      assert.deepEqual(no.calls, []);
      assert.match(res.summary, /stopped before step 1/);
    });

    it("a click that lands on another origin pauses and reads nothing from it", async () => {
      const g = gated("https://evil.example.org/landing");
      const res = await run(g.act, [{ action: "click", selector: "#away" }]);
      assert.match(res.summary, /then paused: the page moved to https:\/\/evil\.example\.org/);
      assert.doesNotMatch(res.summary, /Visible page text/);
    });
  });

  it("validates steps", () => {
    assert.throws(() => parseSteps([]), /non-empty/);
    assert.throws(() => parseSteps("nope"), /JSON array/);
    assert.throws(() => parseSteps([{ action: "click" }]), /needs a selector/);
    assert.throws(() => parseSteps([{ action: "fill", selector: "#a" }]), /needs a value/);
    assert.throws(() => parseSteps([{ action: "eval", selector: "x" }]), /click, fill, wait or screenshot/);
    assert.throws(() => parseSteps(Array.from({ length: 21 }, () => ({ action: "screenshot" }))), /At most 20/);
    assert.deepEqual(parseSteps([{ action: "wait", ms: 99_999 }]), [{ action: "wait", ms: 30_000 }]);
  });
});
