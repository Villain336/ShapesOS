// ShapesOS — shared route error mapping (lib/api/errors.ts).
// Run: npx tsx --test lib/api/__tests__/errors.test.ts

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  INTERNAL_ERROR_MESSAGE,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  errorResponse,
  withErrorHandling,
} from "../errors";
import { HttpError as GuardHttpError, httpErrorResponse, readJson } from "../../enrichment/guard";

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Run fn with console.error captured (5xx paths log by design). */
async function quietly<T>(fn: () => Promise<T> | T): Promise<{ result: T; logged: unknown[][] }> {
  const logged: unknown[][] = [];
  const spy = mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args);
  });
  try {
    return { result: await fn(), logged };
  } finally {
    spy.mock.restore();
  }
}

describe("errorResponse — typed errors keep status and message", () => {
  const cases: Array<[HttpError, number]> = [
    [new BadRequestError("Order name is required."), 400],
    [new UnauthorizedError(), 401],
    [new ForbiddenError("Insufficient role for this action."), 403],
    [new NotFoundError("EDDM order not found"), 404],
    [new ConflictError("Routes can only change while the order is a draft."), 409],
    [new HttpError(429, "Apollo rate limit hit (429) — back off and retry."), 429],
    [new ServiceUnavailableError("Drive is not connected."), 503],
  ];
  for (const [err, status] of cases) {
    it(`${err.name} → ${status}`, async () => {
      const res = errorResponse(err);
      assert.equal(res.status, status);
      assert.equal((await body(res)).error, err.message);
    });
  }

  it("carries code and details when set", async () => {
    const res = errorResponse(
      new BadRequestError("Bad shape.", { code: "bad_shape", details: [{ path: "a", message: "x" }] }),
    );
    assert.deepEqual(await body(res), {
      error: "Bad shape.",
      code: "bad_shape",
      details: [{ path: "a", message: "x" }],
    });
  });

  it("expose:false hides a 5xx message and logs it", async () => {
    const { result, logged } = await quietly(() =>
      errorResponse(new HttpError(500, "lineage row 42 missing", { expose: false })),
    );
    assert.equal(result.status, 500);
    assert.deepEqual(await body(result), { error: INTERNAL_ERROR_MESSAGE });
    assert.equal(logged.length, 1);
  });

  it("the guard's HttpError is the same class (one app-wide)", () => {
    assert.equal(GuardHttpError, HttpError);
  });
});

describe("errorResponse — client mistakes are 4xx, never 500", () => {
  it("ZodError → 400 with field paths and messages, never values", async () => {
    const schema = z.object({ name: z.string().min(1), secret: z.string().max(3) });
    let err: unknown;
    try {
      schema.parse({ secret: "hunter2-is-too-long" });
    } catch (e) {
      err = e;
    }
    const res = errorResponse(err);
    assert.equal(res.status, 400);
    const b = await body(res);
    assert.equal(b.error, "Invalid request.");
    const details = b.details as Array<{ path: string; message: string }>;
    assert.deepEqual(details.map((d) => d.path).sort(), ["name", "secret"]);
    assert.ok(!JSON.stringify(b).includes("hunter2"), "input values are never echoed");
  });

  it("malformed JSON body → 400", async () => {
    const req = new Request("http://x/api", { method: "POST", body: "{nope" });
    const err = await req.json().catch((e: unknown) => e);
    const res = errorResponse(err);
    assert.equal(res.status, 400);
    assert.equal((await body(res)).error, "Invalid JSON body.");
  });

  it("guard readJson → 400", async () => {
    const req = new Request("http://x/api", { method: "POST", body: "{nope" });
    const err = await readJson(req).catch((e: unknown) => e);
    assert.equal(httpErrorResponse(err).status, 400);
  });

  it("formData() with a JSON content type (esign templates/envelopes) → 415", async () => {
    const req = new Request("http://x/api/esign/templates", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const err = await req.formData().catch((e: unknown) => e);
    const res = errorResponse(err);
    assert.equal(res.status, 415);
    assert.match(String((await body(res)).error), /multipart\/form-data/);
  });

  it("Prisma P2025 → 404, P2002 → 409, P2023 → 400", async () => {
    const mk = (code: string) =>
      new Prisma.PrismaClientKnownRequestError(`internal detail for ${code}`, {
        code,
        clientVersion: "6.0.0",
      });
    const expectations: Array<[string, number]> = [
      ["P2025", 404],
      ["P2002", 409],
      ["P2003", 409],
      ["P2023", 400],
    ];
    for (const [code, status] of expectations) {
      const res = errorResponse(mk(code));
      assert.equal(res.status, status, code);
      assert.ok(!JSON.stringify(await body(res)).includes("internal detail"), `${code} message not echoed`);
    }
  });

  it("a plain Error saying 'not found' → 404 with a generic message", async () => {
    const res = errorResponse(new Error("Mail campaign not found"));
    assert.equal(res.status, 404);
    assert.equal((await body(res)).error, "Not found.");
  });
});

describe("errorResponse — everything else is a generic, logged 500", () => {
  const leaks = [
    new Error('relation "mail_campaigns" does not exist'),
    new TypeError("Cannot read properties of undefined (reading 'trim')"),
    new Error("connect ECONNREFUSED 10.0.0.12:5432"),
    "a thrown string",
    { weird: true },
  ];
  for (const err of leaks) {
    it(`does not echo ${JSON.stringify(err instanceof Error ? err.message : err)}`, async () => {
      const { result, logged } = await quietly(() => errorResponse(err, "POST /api/test"));
      assert.equal(result.status, 500);
      assert.deepEqual(await body(result), { error: INTERNAL_ERROR_MESSAGE });
      assert.equal(logged.length, 1, "logged server-side");
      assert.match(String(logged[0][0]), /POST \/api\/test/);
    });
  }

  it("Prisma errors without a client meaning stay 500 (no raw message)", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("Value out of range for the type", {
      code: "P1001",
      clientVersion: "6.0.0",
    });
    const { result } = await quietly(() => errorResponse(err));
    assert.equal(result.status, 500);
    assert.deepEqual(await body(result), { error: INTERNAL_ERROR_MESSAGE });
  });

  it("4xx errors are not logged as unhandled", async () => {
    const { logged } = await quietly(() => errorResponse(new NotFoundError()));
    assert.equal(logged.length, 0);
  });
});

describe("withErrorHandling", () => {
  it("passes responses through and maps throws", async () => {
    const ok = withErrorHandling(async (n: number) => Response.json({ n }));
    assert.equal((await body(await ok(3))).n, 3);
    const bad = withErrorHandling(async () => {
      throw new ConflictError("Approval is already approved");
    });
    const res = await bad();
    assert.equal(res.status, 409);
  });
});
