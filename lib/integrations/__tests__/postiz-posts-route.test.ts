// ShapesOS — the legacy Postiz posts route can't publish around approval
// (Phase 4b): only drafts are created; "now"/"schedule" → 409.
// Run: npx tsx --test --experimental-test-module-mocks lib/integrations/__tests__/postiz-posts-route.test.ts

import { before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const calls: { type: string }[] = [];
// Registered at top level, before the route is imported.
mock.module("@/app/api/integrations/_lib", {
  namedExports: {
    guardWorkspace: async () => ({ workspace: { id: "ws-postiz-test" } }),
    readJson: async (req: Request) => req.json(),
    sidecarError: (e: unknown) => Response.json({ error: String(e) }, { status: 500 }),
  },
});
mock.module("@/lib/integrations/postiz", {
  namedExports: {
    listPostizPosts: async () => [],
    schedulePostizPost: async (input: { type: string }) => {
      calls.push(input);
      return { id: "draft-1" };
    },
  },
});

let POST: (req: Request) => Promise<Response>;
before(async () => {
  ({ POST } = await import("@/app/api/integrations/postiz/posts/route"));
});

const req = (body: unknown) =>
  new Request("http://app/api/integrations/postiz/posts", { method: "POST", body: JSON.stringify(body) });
const base = { content: "hello", channelIds: ["c1"] };

describe("POST /api/integrations/postiz/posts", () => {
  it("refuses to publish now or on a schedule (approval required)", async () => {
    for (const type of ["now", "schedule"]) {
      const res = await POST(req({ ...base, type, date: "2026-10-10T10:00:00Z" }));
      assert.equal(res.status, 409, type);
      assert.equal(((await res.json()) as { code: string }).code, "approval_required");
    }
    assert.equal(calls.length, 0, "Postiz never called");
  });

  it("still creates drafts", async () => {
    const res = await POST(req({ ...base, type: "draft" }));
    assert.equal(res.status, 201);
    assert.deepEqual(calls.map((c) => c.type), ["draft"]);
  });
});
