// ShapesOS — paging/filter query validation (FULL-AUDIT §5: `?take=abc` and
// `?limit=1.5` caused 500s; unknown enum filters reached Prisma).
// Uses node:test mock.module (scripts/test/run.mjs passes the flag).

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { intQuery, parseQuery, z } from "../validate";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const sp = (qs: string) => new URLSearchParams(qs);

describe("intQuery / parseQuery", () => {
  const schema = z.object({ take: intQuery(50, 1, 200) });

  it("absent or empty → default; valid integers clamp into range", () => {
    for (const [qs, want] of [["", 50], ["take=", 50], ["take=7", 7], ["take=999", 200], ["take=0", 1], ["take=-5", 1], ["take=%2012%20", 12]] as const) {
      const r = parseQuery(schema, sp(qs));
      assert.ok(r.ok, qs);
      assert.equal(r.ok && r.data.take, want, qs);
    }
  });

  it("non-integers are a 400 with field details (never a 500)", async () => {
    for (const qs of ["take=abc", "take=1.5", "take=1e3", "take=0x10", "take=99999999999"]) {
      const r = parseQuery(schema, sp(qs));
      assert.equal(r.ok, false, qs);
      if (!r.ok) {
        assert.equal(r.error.status, 400);
        const body = (await r.error.json()) as { details: { path: string }[] };
        assert.equal(body.details[0].path, "take");
      }
    }
  });

  it("first value wins for a repeated key", () => {
    const r = parseQuery(schema, sp("take=5&take=abc"));
    assert.ok(r.ok && r.data.take === 5);
  });
});

describe("GET /api/intelligence/fleet/changes", () => {
  let lastTake: unknown;
  mock.module("@/lib/session", {
    namedExports: {
      requireUser: async () => ({ id: "u1", email: "u@x.test" }),
      getOrCreateWorkspace: async () => ({ id: "ws1" }),
    },
  });
  mock.module("@/lib/authz", { namedExports: { requireProjectRole: async () => true } });
  mock.module("@/lib/substrate/graph/rls", {
    namedExports: {
      withWorkspaceScope: async (_ws: string, fn: (tx: unknown) => unknown) =>
        fn({
          competitorChange: {
            findMany: async (args: { take: unknown }) => {
              lastTake = args.take;
              return [];
            },
          },
        }),
    },
  });

  async function get(qs: string): Promise<Response> {
    const { GET } = await import("@/app/api/intelligence/fleet/changes/route");
    const url = new URL(`http://localhost/api/intelligence/fleet/changes?${qs}`);
    return GET(Object.assign(new Request(url), { nextUrl: url }) as never);
  }

  it("?take=abc, ?take=1.5 and unknown enum filters → 400", async () => {
    for (const qs of ["take=abc", "take=1.5", "changeType=nope", "status=deleted"]) {
      const res = await get(qs);
      assert.equal(res.status, 400, qs);
    }
  });

  it("valid queries reach the store with an integer take", async () => {
    const res = await get("take=20&status=new&changeType=page_added");
    assert.equal(res.status, 200);
    assert.equal(lastTake, 20);
    await get("");
    assert.equal(lastTake, 50);
  });
});

describe("sibling routes no longer page with Number(query)", () => {
  const ROUTES = [
    "app/api/intelligence/fleet/changes/route.ts",
    "app/api/schedules/[id]/runs/route.ts",
    "app/api/ops/[entity]/route.ts",
    "app/api/prospects/lists/[id]/prospects/route.ts",
    "app/api/crm/leads/route.ts",
    "app/api/nurture/enrollments/route.ts",
    "app/api/nurture/log/route.ts",
    "app/api/nurture/approvals/route.ts",
    "app/api/nurture/consent/route.ts",
    "app/api/calls/calls/route.ts",
    "app/api/calls/bookings/route.ts",
    "app/api/substrate/graph/facts/route.ts",
    "app/api/substrate/graph/nodes/route.ts",
    "app/api/reviews/incoming/route.ts",
    "app/api/mail/campaigns/route.ts",
    "app/api/review-requests/route.ts",
    "app/api/messaging/log/route.ts",
    "app/api/messaging/approvals/route.ts",
    "app/api/integrations/activepieces/flows/route.ts",
    "app/api/funding/data-room/views/route.ts",
    "app/api/alerts/route.ts",
    "app/api/newsletter/lists/[id]/subscribers/route.ts",
  ];
  for (const f of ROUTES) {
    it(f, () => {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(src, /(Number|parseInt)\([^)]*get\("(take|limit)"\)/);
      assert.match(src, /intQuery\(/);
    });
  }
});
