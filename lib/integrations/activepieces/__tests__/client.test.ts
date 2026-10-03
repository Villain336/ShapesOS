// Marketr — Activepieces integration tests (Phase 12, Worker 3).
// Run: npx tsx --test lib/integrations/activepieces/__tests__/client.test.ts
//
// fetch is mocked; the piece catalog test reads the REAL installed
// @activepieces/piece-* packages (they're MIT community — the metadata test
// pins that the catalog can't silently drift).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isTerminalRunStatus,
  isSuccessfulRunStatus,
  normalizeEngineUrl,
  activepiecesStatus,
  listFlows,
  getFlow,
  preflightTrigger,
  triggerFlow,
  latestFlowRun,
  getFlowRun,
  curatedPieces,
  AUTOMATION_RECIPES,
} from "../index";

const REAL_FETCH = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const body = handler(String(url), init as RequestInit | undefined);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function setEnv(url: string | null, key: string | null) {
  if (url === null) delete process.env.ACTIVEPIECES_URL;
  else process.env.ACTIVEPIECES_URL = url;
  if (key === null) delete process.env.ACTIVEPIECES_API_KEY;
  else process.env.ACTIVEPIECES_API_KEY = key;
}

const WEBHOOK_FLOW_ROW = {
  id: "flow-1",
  displayName: "Lead fanout",
  status: "ENABLED",
  publishedVersionId: "v1",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  version: {
    trigger: {
      type: "TRIGGER",
      settings: { pieceName: "@activepieces/piece-webhook", triggerName: "catch_webhook" },
    },
  },
};

const SCHEDULE_FLOW_ROW = {
  id: "flow-2",
  displayName: "Weekly digest",
  status: "ENABLED",
  publishedVersionId: "v2",
  version: {
    trigger: {
      type: "TRIGGER",
      settings: { pieceName: "@activepieces/piece-schedule", triggerName: "every_week" },
    },
  },
};

describe("status helpers", () => {
  it("classifies terminal vs non-terminal run statuses", () => {
    assert.equal(isTerminalRunStatus("QUEUED"), false);
    assert.equal(isTerminalRunStatus("RUNNING"), false);
    assert.equal(isTerminalRunStatus("PAUSED"), false);
    assert.equal(isTerminalRunStatus("SUCCEEDED"), true);
    assert.equal(isTerminalRunStatus("FAILED"), true);
    assert.equal(isTerminalRunStatus("TIMEOUT"), true);
    assert.equal(isTerminalRunStatus("SOME_FUTURE_STATUS"), true);
  });

  it("recognizes SUCCEEDED", () => {
    assert.equal(isSuccessfulRunStatus("SUCCEEDED"), true);
    assert.equal(isSuccessfulRunStatus("FAILED"), false);
  });

  it("normalizeEngineUrl trims and drops trailing slashes", () => {
    assert.equal(normalizeEngineUrl("http://localhost:8080/"), "http://localhost:8080");
    assert.equal(normalizeEngineUrl("  "), null);
    assert.equal(normalizeEngineUrl(undefined), null);
  });
});

describe("engine config", () => {
  afterEach(() => setEnv("http://localhost:8080", "k"));

  it("reports unconfigured without leaking the key", () => {
    setEnv(null, null);
    const s = activepiecesStatus();
    assert.equal(s.configured, false);
    assert.equal(s.url, null);
    assert.equal(s.hasApiKey, false);
    assert.ok(!("apiKey" in s));
  });

  it("reports configured when both env vars are set", () => {
    setEnv("http://localhost:8080/", "secret-key");
    const s = activepiecesStatus();
    assert.equal(s.configured, true);
    assert.equal(s.url, "http://localhost:8080");
    assert.equal(s.hasApiKey, true);
  });
});

describe("flows client", () => {
  beforeEach(() => {
    setEnv("http://localhost:8080", "test-key");
    mockFetch((url) => {
      if (url.includes("/v1/flows/flow-1") && !url.includes("flow-runs")) return { data: WEBHOOK_FLOW_ROW };
      if (url.includes("/v1/flows/flow-2")) return { data: SCHEDULE_FLOW_ROW };
      if (url.includes("/v1/flows")) return { data: [WEBHOOK_FLOW_ROW, SCHEDULE_FLOW_ROW], nextCursor: null };
      if (url.includes("/v1/flow-runs/run-1")) {
        return {
          id: "run-1",
          flowId: "flow-1",
          status: "SUCCEEDED",
          startTime: "2026-09-27T10:00:00.000Z",
          finishTime: "2026-09-27T10:00:05.000Z",
        };
      }
      if (url.includes("/v1/flow-runs")) {
        return {
          data: [
            { id: "run-1", flowId: "flow-1", status: "SUCCEEDED", startTime: "2026-09-27T10:00:00.000Z", finishTime: "2026-09-27T10:00:05.000Z" },
            { id: "run-0", flowId: "flow-1", status: "FAILED", startTime: "2026-09-26T10:00:00.000Z", failedStep: { name: "step_2", errorMessage: "boom" } },
          ],
        };
      }
      throw new Error(`unexpected url ${url}`);
    });
  });

  afterEach(() => {
    globalThis.fetch = REAL_FETCH;
  });

  it("lists flows and maps triggers honestly", async () => {
    const page = await listFlows();
    assert.equal(page.configured, true);
    assert.equal(page.flows.length, 2);
    const wh = page.flows[0];
    assert.equal(wh.displayName, "Lead fanout");
    assert.equal(wh.triggerPiece, "@activepieces/piece-webhook");
    assert.equal(wh.triggerName, "catch_webhook");
    assert.equal(wh.triggerableViaWebhook, true);
    assert.equal(wh.webhookUrl, "http://localhost:8080/v1/webhooks/flow-1");
    const sched = page.flows[1];
    assert.equal(sched.triggerableViaWebhook, false);
    assert.equal(sched.webhookUrl, null);
  });

  it("degrades listFlows when the engine is not configured", async () => {
    setEnv(null, null);
    const page = await listFlows();
    assert.equal(page.configured, false);
    assert.deepEqual(page.flows, []);
  });

  it("getFlow returns the trigger detail", async () => {
    const f = await getFlow("flow-1");
    assert.equal(f.id, "flow-1");
    assert.equal(f.triggerableViaWebhook, true);
  });

  it("preflight refuses schedule-trigger flows with an honest reason", async () => {
    const pre = await preflightTrigger("flow-2");
    assert.equal(pre.ok, false);
    assert.match(pre.reason ?? "", /not a webhook/i);
  });

  it("preflight passes for published webhook flows", async () => {
    const pre = await preflightTrigger("flow-1");
    assert.equal(pre.ok, true);
  });

  it("triggerFlow POSTs the payload to the webhook URL", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      seen.push({ url: String(url), init: init as RequestInit });
      if (String(url).includes("/v1/flows/flow-1")) return new Response(JSON.stringify({ data: WEBHOOK_FLOW_ROW }), { status: 200 });
      return new Response(JSON.stringify({ runId: "run-9" }), { status: 200 });
    }) as typeof fetch;
    const res = await triggerFlow("flow-1", { lead: "acme" });
    assert.equal(res.accepted, true);
    assert.equal(res.runId, "run-9");
    const post = seen.find((s) => s.init?.method === "POST");
    assert.ok(post);
    assert.equal(post!.url, "http://localhost:8080/v1/webhooks/flow-1");
    assert.deepEqual(JSON.parse(String(post!.init!.body)), { lead: "acme" });
  });

  it("triggerFlow throws an honest error for non-webhook flows", async () => {
    await assert.rejects(() => triggerFlow("flow-2", {}), /not a webhook/i);
  });

  it("latestFlowRun returns the newest run with failure detail", async () => {
    const run = await latestFlowRun("flow-1");
    assert.ok(run);
    assert.equal(run!.id, "run-1");
    assert.equal(run!.terminal, true);
    assert.equal(run!.succeeded, true);
  });

  it("getFlowRun maps failure info", async () => {
    const run = await getFlowRun("run-1");
    assert.equal(run.id, "run-1");
    assert.equal(run.terminal, true);
    assert.equal(run.failure, null);
  });
});

describe("curated piece catalog", () => {
  it("reads metadata from the real installed packages", async () => {
    const pieces = await curatedPieces();
    assert.ok(pieces.length >= 10, `expected >= 10 curated pieces, got ${pieces.length}`);
    const webhook = pieces.find((p) => p.packageName === "@activepieces/piece-webhook");
    assert.ok(webhook);
    assert.equal(webhook!.displayName, "Webhook");
    assert.ok(webhook!.triggers.includes("catch_webhook"));
    const http = pieces.find((p) => p.packageName === "@activepieces/piece-http");
    assert.ok(http!.actions.includes("send_request"));
    const sheets = pieces.find((p) => p.packageName === "@activepieces/piece-google-sheets");
    assert.ok(sheets!.actions.length > 5);
    for (const p of pieces) {
      assert.ok(p.version && p.version !== "unknown", `${p.packageName} has a version`);
      assert.ok(p.marketingUse.length > 10, `${p.packageName} has a marketing use note`);
    }
  });

  it("loads pieces with literal imports only (production-build safe)", () => {
    // A computed import(spec.packageName) / require(`${name}/...`) compiles but
    // fails at runtime in the Turbopack production build ("Cannot find module
    // as expression is too dynamic"), which 502'd the catalog route.
    const src = readFileSync(new URL("../pieces.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1].trim());
    assert.ok(imports.length >= 13, "one literal loader per curated piece");
    for (const arg of imports) {
      assert.match(arg, /^"@activepieces\/piece-[a-z-]+"$/, `non-literal import(${arg})`);
    }
    assert.doesNotMatch(src, /\brequire\(`/, "no template-literal require");
    const config = readFileSync(new URL("../../../../next.config.ts", import.meta.url), "utf8");
    for (const arg of imports) {
      assert.ok(config.includes(arg), `${arg} is in serverExternalPackages`);
    }
  });

  it("ships marketing recipes", () => {
    assert.ok(AUTOMATION_RECIPES.length >= 4);
    for (const r of AUTOMATION_RECIPES) {
      assert.ok(r.id && r.title && r.pieces.length >= 2);
    }
  });
});
