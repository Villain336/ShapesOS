// Marketr — Phase 12: Plane sidecar lib tests.
// Run: npx tsx --test lib/integrations/__tests__/plane.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PLANE_NOT_CONFIGURED_MESSAGE,
  PlaneApiError,
  PlaneConfigError,
  getPlaneConfig,
  isOpenIssue,
  listPlaneIssues,
  listPlaneProjects,
  mapIssue,
  mapProject,
  openIssues,
  planeStatus,
} from "../plane";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  return Promise.resolve().then(async () => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
}

const ENV = {
  PLANE_BASE_URL: "https://plane.example.com/",
  PLANE_API_KEY: "k",
  PLANE_WORKSPACE_SLUG: "acme",
};

function mockFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
) {
  const calls: string[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push(String(url));
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("planeStatus", () => {
  it("is not configured without env vars", () =>
    withEnv({ PLANE_BASE_URL: undefined, PLANE_API_KEY: undefined, PLANE_WORKSPACE_SLUG: undefined }, () => {
      assert.equal(planeStatus().configured, false);
      assert.ok(PLANE_NOT_CONFIGURED_MESSAGE.includes("PLANE_API_KEY"));
    }));

  it("trims the trailing slash from the base URL", () =>
    withEnv(ENV, () => {
      assert.equal(getPlaneConfig().baseUrl, "https://plane.example.com");
      assert.equal(planeStatus().configured, true);
    }));
});

describe("mapProject / mapIssue", () => {
  it("maps a project", () => {
    assert.deepEqual(mapProject({ id: "p1", name: "Website", identifier: "WEB" }), {
      id: "p1",
      name: "Website",
      identifier: "WEB",
    });
  });
  it("maps an issue with a deep link", () => {
    const i = mapIssue(
      {
        id: "i1",
        name: "Write hero copy",
        sequence_id: 42,
        priority: "high",
        state_detail: { name: "Todo", group: "unstarted" },
        updated_at: "2026-09-27T00:00:00Z",
      },
      "https://plane.example.com",
      "acme",
      "WEB",
    );
    assert.equal(i.sequenceId, 42);
    assert.equal(i.stateGroup, "unstarted");
    assert.equal(i.url, "https://plane.example.com/acme/projects/WEB/issues/42");
  });
  it("never invents fields on garbage input", () => {
    assert.deepEqual(mapIssue(null, "", "", ""), {
      id: "",
      name: "Untitled issue",
      sequenceId: null,
      state: null,
      stateGroup: null,
      priority: null,
      labels: [],
      url: null,
      updatedAt: null,
    });
  });
});

describe("isOpenIssue", () => {
  it("treats completed/cancelled as closed", () => {
    const base = { id: "i", name: "x", sequenceId: 1, state: "Done", priority: null, labels: [], url: null, updatedAt: null };
    assert.equal(isOpenIssue({ ...base, stateGroup: "completed" }), false);
    assert.equal(isOpenIssue({ ...base, stateGroup: "cancelled" }), false);
    assert.equal(isOpenIssue({ ...base, stateGroup: "started" }), true);
    assert.equal(isOpenIssue({ ...base, stateGroup: null }), true);
    assert.equal(openIssues([{ ...base, stateGroup: "completed" }, { ...base, stateGroup: "backlog" }]).length, 1);
  });
});

describe("listPlaneProjects", () => {
  it("refuses without credentials", () =>
    withEnv({ PLANE_BASE_URL: undefined, PLANE_API_KEY: undefined, PLANE_WORKSPACE_SLUG: undefined }, async () => {
      const { impl } = mockFetch(() => ({ status: 200, body: {} }));
      await assert.rejects(() => listPlaneProjects(impl), PlaneConfigError);
    }));

  it("lists projects with the X-API-Key header", () =>
    withEnv(ENV, async () => {
      const { impl, calls } = mockFetch((url, init) => {
        assert.equal((init.headers as Record<string, string>)["X-API-Key"], "k");
        return { status: 200, body: { results: [{ id: "p1", name: "Website", identifier: "WEB" }] } };
      });
      const projects = await listPlaneProjects(impl);
      assert.equal(projects.length, 1);
      assert.equal(projects[0].identifier, "WEB");
      assert.ok(calls[0].startsWith("https://plane.example.com/api/v1/workspaces/acme/projects/"));
    }));

  it("maps 401 to a key-specific message", () =>
    withEnv(ENV, async () => {
      const { impl } = mockFetch(() => ({ status: 401, body: {} }));
      const err = await listPlaneProjects(impl).catch((e) => e);
      assert.ok(err instanceof PlaneApiError);
      assert.ok(err.message.includes("API key"));
    }));
});

describe("listPlaneIssues", () => {
  it("validates the project id", () =>
    withEnv(ENV, async () => {
      const { impl } = mockFetch(() => ({ status: 200, body: { results: [] } }));
      await assert.rejects(() => listPlaneIssues("", impl), PlaneConfigError);
      await assert.rejects(() => listPlaneIssues("bad id!", impl), PlaneConfigError);
    }));

  it("lists issues and resolves the project identifier for deep links", () =>
    withEnv(ENV, async () => {
      const { impl, calls } = mockFetch((url) => {
        if (url.endsWith("/issues/?per_page=100")) {
          return {
            status: 200,
            body: {
              results: [
                { id: "i1", name: "Write hero copy", sequence_id: 7, state_detail: { name: "Todo", group: "unstarted" } },
              ],
              next_cursor: null,
              next_page_results: false,
            },
          };
        }
        return { status: 200, body: { id: "p1", identifier: "WEB" } };
      });
      const issues = await listPlaneIssues("p1", impl);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].url, "https://plane.example.com/acme/projects/WEB/issues/7");
      assert.ok(calls.some((u) => u.includes("/projects/p1/issues/")));
    }));

  it("follows cursor pagination", () =>
    withEnv(ENV, async () => {
      let n = 0;
      const { impl } = mockFetch((url) => {
        if (url.includes("/issues/")) {
          n++;
          if (n === 1) {
            return {
              status: 200,
              body: { results: [{ id: "i1", name: "a" }], next_cursor: "c2", next_page_results: true },
            };
          }
          return { status: 200, body: { results: [{ id: "i2", name: "b" }], next_page_results: false } };
        }
        return { status: 200, body: { identifier: "" } };
      });
      const issues = await listPlaneIssues("p1", impl);
      assert.equal(issues.length, 2);
    }));
});
