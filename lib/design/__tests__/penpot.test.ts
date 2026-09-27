// Marketr — Phase 12: Penpot bridge lib tests.
// Run: npx tsx --test lib/design/__tests__/penpot.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PENPOT_NOT_CONFIGURED_MESSAGE,
  PenpotApiError,
  PenpotInputError,
  PenpotNotConfiguredError,
  extractPenpotTokens,
  getPenpotBaseUrl,
  importPenpotTokensViaApi,
  importPenpotTokensViaPaste,
  normalizeFileId,
  parsePastedTokensJson,
  penpotStatus,
  penpotTokensToKit,
  walkTokenTree,
  type ExtractedPenpotTokens,
} from "../penpot";

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

const DTCG_EXPORT = {
  sets: {
    "primitive/color": {
      "brand/primary": { $value: "#635BFF", $type: "color" },
      "brand/ink": { $value: "#1c1c1c", $type: "color" },
    },
    "primitive/typography": {
      "heading/font": { $value: "Inter", $type: "fontFamily" },
      "body/font": { $value: "Inter", $type: "fontFamily" },
    },
  },
  themes: [{ name: "light" }],
};

describe("penpotStatus", () => {
  it("is not configured without env vars", () =>
    withEnv({ PENPOT_BASE_URL: undefined, PENPOT_ACCESS_TOKEN: undefined }, () => {
      assert.equal(penpotStatus().configured, false);
      assert.equal(penpotStatus().name, "penpot");
    }));

  it("is configured with both env vars", () =>
    withEnv({ PENPOT_BASE_URL: "https://design.example.com/", PENPOT_ACCESS_TOKEN: "t" }, () => {
      assert.equal(penpotStatus().configured, true);
      assert.equal(penpotStatus().isLive, true);
    }));

  it("trims trailing slashes from the base URL", () =>
    withEnv({ PENPOT_BASE_URL: "https://design.example.com///", PENPOT_ACCESS_TOKEN: "t" }, () => {
      assert.equal(getPenpotBaseUrl(), "https://design.example.com");
    }));
});

describe("normalizeFileId", () => {
  it("accepts uuids and url-safe ids", () => {
    assert.equal(normalizeFileId("550e8400-e29b-41d4-a716-446655440000".replace(/-/g, "")), "550e8400e29b41d4a716446655440000");
    assert.equal(normalizeFileId("abcDEF-123_"), "abcDEF-123_");
  });
  it("rejects empty and garbage", () => {
    assert.throws(() => normalizeFileId(""), PenpotInputError);
    assert.throws(() => normalizeFileId("has spaces"), PenpotInputError);
    assert.throws(() => normalizeFileId("a".repeat(200)), PenpotInputError);
  });
});

describe("walkTokenTree", () => {
  it("extracts DTCG colors and fonts with path hints", () => {
    const out: ExtractedPenpotTokens = { colors: [], fonts: [], label: null };
    walkTokenTree(DTCG_EXPORT.sets["primitive/color"], "primitive/color", out);
    assert.deepEqual(
      out.colors.map((c) => c.hex),
      ["#635BFF", "#1C1C1C"],
    );
    assert.equal(out.colors[0].typeHint, "primitive/color/brand/primary");
  });

  it("walks nested groups and skips metadata keys", () => {
    const out: ExtractedPenpotTokens = { colors: [], fonts: [], label: null };
    walkTokenTree({ $metadata: { tokenSetOrder: [] }, group: { a: { $value: "#fff", $type: "color" } } }, "", out);
    assert.deepEqual(out.colors.map((c) => c.hex), ["#FFFFFF"]);
  });

  it("treats untyped hex leaves as colors", () => {
    const out: ExtractedPenpotTokens = { colors: [], fonts: [], label: null };
    walkTokenTree({ brand: "#0a0a0a" }, "", out);
    assert.deepEqual(out.colors.map((c) => c.hex), ["#0A0A0A"]);
  });

  it("reads typography objects with fontFamily", () => {
    const out: ExtractedPenpotTokens = { colors: [], fonts: [], label: null };
    walkTokenTree({ heading: { $value: { fontFamily: "Space Grotesk" }, $type: "typography" } }, "", out);
    assert.deepEqual(out.fonts.map((f) => f.name), ["Space Grotesk"]);
  });
});

describe("extractPenpotTokens", () => {
  it("reads tokens.sets, library colors and typographies", () => {
    const file = {
      name: "Acme file",
      data: {
        tokens: { sets: DTCG_EXPORT.sets },
        colors: { c1: { color: "#ff0000", name: "Red" } },
        typographies: { t1: { "font-family": "Roboto", name: "Body" } },
      },
    };
    const out = extractPenpotTokens(file);
    assert.equal(out.label, "Acme file");
    assert.ok(out.colors.some((c) => c.hex === "#FF0000"));
    assert.ok(out.colors.some((c) => c.hex === "#635BFF"));
    assert.ok(out.fonts.some((f) => f.name === "Roboto"));
    assert.ok(out.fonts.some((f) => f.name === "Inter"));
  });

  it("returns empty on unrecognized payloads (never invents)", () => {
    const out = extractPenpotTokens({ name: "x", data: { pages: [] } });
    assert.deepEqual(out.colors, []);
    assert.deepEqual(out.fonts, []);
  });
});

describe("parsePastedTokensJson", () => {
  it("parses a Penpot tokens-tab export", () => {
    const out = parsePastedTokensJson(JSON.stringify(DTCG_EXPORT));
    assert.equal(out.colors.length, 2);
    assert.equal(out.fonts.length, 2);
  });
  it("rejects invalid JSON and token-less JSON", () => {
    assert.throws(() => parsePastedTokensJson("not json"), PenpotInputError);
    assert.throws(() => parsePastedTokensJson('{"sets":{}}'), PenpotInputError);
    assert.throws(() => parsePastedTokensJson(""), PenpotInputError);
  });
});

describe("penpotTokensToKit", () => {
  it("folds tokens into brand-kit slots like Brandfetch", () => {
    const kit = penpotTokensToKit({
      colors: [
        { hex: "#635BFF", typeHint: "primitive/color/brand/primary" },
        { hex: "#1C1C1C", typeHint: "primitive/color/ink" },
      ],
      fonts: [{ name: "Inter", typeHint: "primitive/typography/heading/font" }],
      label: null,
    });
    assert.equal(kit.kitColors.primary, "#635BFF");
    assert.equal(kit.kitColors.text, "#1C1C1C");
    assert.equal(kit.kitFonts.heading, "Inter");
  });
});

describe("importPenpotTokensViaApi", () => {
  const ENV = { PENPOT_BASE_URL: "https://design.example.com", PENPOT_ACCESS_TOKEN: "tok" };

  function mockFetch(status: number, body: unknown, opts?: { capture?: { url: string; auth?: string } }) {
    return (async (url: string, init: RequestInit = {}) => {
      if (opts?.capture) {
        opts.capture.url = String(url);
        opts.capture.auth = String((init.headers as Record<string, string>)?.Authorization ?? "");
      }
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("refuses without credentials", () =>
    withEnv({ PENPOT_BASE_URL: undefined, PENPOT_ACCESS_TOKEN: undefined }, async () => {
      await assert.rejects(() => importPenpotTokensViaApi("abc123"), PenpotNotConfiguredError);
      assert.ok(PENPOT_NOT_CONFIGURED_MESSAGE.includes("PENPOT_ACCESS_TOKEN"));
    }));

  it("imports tokens from a get-file payload", () =>
    withEnv(ENV, async () => {
      const capture: { url: string; auth?: string } = { url: "" };
      const imp = await importPenpotTokensViaApi(
        "abc123",
        mockFetch(200, { name: "Acme", data: { tokens: { sets: DTCG_EXPORT.sets } } }, { capture }),
      );
      assert.equal(imp.source, "penpot");
      assert.equal(imp.brand.name, "Acme");
      assert.equal(imp.brand.domain, "design.example.com");
      assert.equal(imp.kitColors.primary, "#635BFF");
      assert.ok(capture.url.includes("/api/rpc/command/get-file?id=abc123"));
      assert.equal(capture.auth, "Token tok");
    }));

  it("fails honestly when the file has no tokens", () =>
    withEnv(ENV, async () => {
      await assert.rejects(
        () => importPenpotTokensViaApi("abc123", mockFetch(200, { name: "Empty", data: {} })),
        PenpotApiError,
      );
    }));

  it("maps 401 to a token-specific message", () =>
    withEnv(ENV, async () => {
      const err = await importPenpotTokensViaApi("abc123", mockFetch(401, {})).catch((e) => e);
      assert.ok(err instanceof PenpotApiError);
      assert.ok(err.message.includes("access token"));
    }));
});

describe("importPenpotTokensViaPaste", () => {
  it("works with no credentials and produces a kit record", async () => {
    const imp = await importPenpotTokensViaPaste(JSON.stringify(DTCG_EXPORT));
    assert.equal(imp.source, "penpot-paste");
    assert.equal(imp.brand.logoUrl, null);
    assert.equal(imp.kitColors.primary, "#635BFF");
    assert.equal(imp.kitFonts.heading, "Inter");
    assert.ok(imp.brand.description?.includes("pasted export"));
  });
});
