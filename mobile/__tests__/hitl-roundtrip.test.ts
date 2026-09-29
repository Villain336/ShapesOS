// Marketr mobile — HITL gate round-trip contract tests (Phase 16 slice 11 eval).
// Run: cd mobile && npx vitest run __tests__/hitl-roundtrip.test.ts
//
// Contract-level only (no emulator): the mobile bridge shapes
// (src/api/gate.ts) must speak the EXACT gate route contracts the web card
// uses:
//   POST /api/autopilot/items/[id]/approve { projectId } → { ok: true }
//   POST /api/autopilot/items/[id]/reject  { projectId } → { ok: true }
//   POST /api/autopilot/items/[id]/edit { projectId, title?, draftMarkdown? }
//        → { ok: true }
// A phone approval must execute through the gate — so the request shape the
// phone sends is the contract under test. fetch is stubbed; the gate is never
// touched.

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  GateApiError,
  decideGateItem,
  editGateItem,
  fetchGateItem,
  type GateClientOptions,
} from "../src/api/gate";

const BASE = "https://marketr.example";
const opts = (): GateClientOptions => ({
  baseUrl: BASE,
  authHeaders: () => ({ cookie: "session=abc" }),
});

interface Seen {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

let seen: Seen[] = [];
let queue: Array<{ status: number; json: unknown }> = [];

function mockFetchOnce(status: number, json: unknown) {
  queue.push({ status, json });
}

beforeEach(() => {
  seen = [];
  queue = [];
  // Single recording stub: every call is captured in `seen`, and responses
  // come from the per-test queue (default: { ok: true }).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const next = queue.shift() ?? { status: 200, json: { ok: true } };
      return new Response(JSON.stringify(next.json), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

describe("mobile HITL round-trip: approve", () => {
  it("approve POSTs to the gate approve route with { projectId }", async () => {
    mockFetchOnce(200, { ok: true });
    await decideGateItem(opts(), "item-9", "p1", "approve");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://marketr.example/api/autopilot/items/item-9/approve");
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ projectId: "p1" });
    expect(seen[0]!.headers!["content-type"]).toBe("application/json");
  });

  it("the session cookie rides along (RBAC is server-enforced)", async () => {
    mockFetchOnce(200, { ok: true });
    await decideGateItem(opts(), "item-9", "p1", "approve");
    expect(seen[0]!.headers!.cookie).toBe("session=abc");
  });

  it("item ids are path-encoded", async () => {
    mockFetchOnce(200, { ok: true });
    await decideGateItem(opts(), "a/b", "p1", "approve");
    expect(seen[0]!.url).toContain("a%2Fb/approve");
  });
});

describe("mobile HITL round-trip: reject (deny path)", () => {
  it("reject POSTs to the gate reject route with { projectId }", async () => {
    mockFetchOnce(200, { ok: true });
    await decideGateItem(opts(), "item-9", "p1", "reject");
    expect(seen[0]!.url).toBe("https://marketr.example/api/autopilot/items/item-9/reject");
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ projectId: "p1" });
  });
});

describe("mobile HITL round-trip: edit path", () => {
  it("edit POSTs title + draftMarkdown to the gate edit route", async () => {
    mockFetchOnce(200, { ok: true });
    await editGateItem(opts(), "item-9", "p1", { title: "New title", draftMarkdown: "# v2" });
    expect(seen[0]!.url).toBe("https://marketr.example/api/autopilot/items/item-9/edit");
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      projectId: "p1",
      title: "New title",
      draftMarkdown: "# v2",
    });
  });

  it("edit with only a title sends only the title", async () => {
    mockFetchOnce(200, { ok: true });
    await editGateItem(opts(), "item-9", "p1", { title: "Title only" });
    const body = JSON.parse(seen[0]!.body!);
    expect(body.title).toBe("Title only");
    expect("draftMarkdown" in body).toBe(false);
  });
});

describe("mobile HITL round-trip: gate refusals surface as errors", () => {
  it("a gate that does not acknowledge ({ ok: false }) throws GateApiError", async () => {
    mockFetchOnce(200, { ok: false, error: "item is not pending" });
    await expect(decideGateItem(opts(), "item-9", "p1", "approve")).rejects.toThrow(GateApiError);
  });

  it("a 403 (viewer trying to decide) surfaces the status", async () => {
    mockFetchOnce(403, { error: "Forbidden" });
    const err = await decideGateItem(opts(), "item-9", "p1", "approve").catch((e) => e);
    expect(err).toBeInstanceOf(GateApiError);
    expect((err as GateApiError).status).toBe(403);
  });

  it("a gate transition error (400) surfaces the gate's message", async () => {
    mockFetchOnce(400, { error: "item cannot be approved from status rejected" });
    await expect(decideGateItem(opts(), "item-9", "p1", "approve")).rejects.toThrow(
      /cannot be approved/,
    );
  });
});

describe("mobile HITL round-trip: the card never invents content", () => {
  it("fetchGateItem loads the item live from the gate", async () => {
    const item = {
      id: "item-9",
      kind: "decay_refresh",
      title: "Server truth",
      draftMarkdown: null,
      status: "pending",
      reviewNote: null,
      createdAt: "2026-09-29T00:00:00Z",
      rule: { id: "r1", name: "Rule" },
    };
    mockFetchOnce(200, { item });
    const got = await fetchGateItem(opts(), "item-9", "p1");
    expect(got.title).toBe("Server truth");
    expect(seen[0]!.url).toBe(
      "https://marketr.example/api/autopilot/items/item-9?projectId=p1",
    );
    expect(seen[0]!.method).toBeUndefined(); // GET
  });

  it("a missing item throws (the card renders an error, not a guess)", async () => {
    mockFetchOnce(200, { item: null });
    await expect(fetchGateItem(opts(), "ghost", "p1")).rejects.toThrow(GateApiError);
  });
});
