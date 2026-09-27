// Marketr — Phase 11 "Canvas": Cloudinary upload-pipeline lib tests.
// Run: npx tsx --test lib/design/__tests__/cloudinary.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CLOUDINARY_FREE_TIER_CREDITS,
  MAX_UPLOAD_BYTES,
  NOT_CONFIGURED_MESSAGE,
  SignParamError,
  buildDeliveryUrl,
  buildSignPayload,
  buildSignature,
  buildUploadUrl,
  cloudinaryStatus,
  getCloudinaryConfig,
  newPublicId,
  parseSignRequest,
} from "../cloudinary";

/** Independent SHA-1 — does NOT call buildSignature. */
function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** Test config with a distinctive secret so a leak is unmistakable. */
const TEST_CONFIG = {
  cloudName: "test-cloud",
  apiKey: "test-api-key",
  apiSecret: "SECRET_TEST_VALUE_xyz_987",
};

describe("buildSignature", () => {
  it("matches the Cloudinary docs signature vector (computed independently)", () => {
    // Manual string-to-sign per the docs: alphabetical key=value pairs
    // joined by &, secret appended, SHA-1 hex digest. No buildSignature call.
    const expected = sha1("public_id=sample&timestamp=1315060510abcd");
    assert.equal(expected, "c3470533147774275dd37996cc4d0e68fd03cd4f");
    assert.equal(
      buildSignature({ public_id: "sample", timestamp: "1315060510" }, "abcd"),
      expected,
    );
  });

  it("sorts params alphabetically regardless of input order", () => {
    const scrambled = buildSignature(
      { timestamp: "1315060510", public_id: "sample", folder: "marketr/ws1" },
      "abcd",
    );
    const ordered = buildSignature(
      { folder: "marketr/ws1", public_id: "sample", timestamp: "1315060510" },
      "abcd",
    );
    assert.equal(scrambled, ordered);
    assert.equal(scrambled, sha1("folder=marketr/ws1&public_id=sample&timestamp=1315060510abcd"));
  });

  it("signs exactly the params it is given (the route picks which)", () => {
    assert.equal(
      buildSignature({ a: "1", b: "2" }, "s"),
      sha1("a=1&b=2s"),
    );
  });

  it("changes when the secret changes", () => {
    assert.notEqual(
      buildSignature({ public_id: "sample", timestamp: "1315060510" }, "abcd"),
      buildSignature({ public_id: "sample", timestamp: "1315060510" }, "wxyz"),
    );
  });
});

describe("delivery-URL builder", () => {
  it("builds the full-res delivery URL with f_auto,q_auto", () => {
    assert.equal(
      buildDeliveryUrl("demo", "folder/abc", "full"),
      "https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/folder/abc",
    );
  });

  it("defaults to the full variant", () => {
    assert.equal(
      buildDeliveryUrl("demo", "folder/abc"),
      "https://res.cloudinary.com/demo/image/upload/f_auto,q_auto/folder/abc",
    );
  });

  it("builds the thumb variant capped at 400px with auto format/quality", () => {
    assert.equal(
      buildDeliveryUrl("demo", "folder/abc", "thumb"),
      "https://res.cloudinary.com/demo/image/upload/w_400,f_auto,q_auto/folder/abc",
    );
  });

  it("never embeds the api secret", () => {
    const url = buildDeliveryUrl(TEST_CONFIG.cloudName, "abc");
    assert.ok(!url.includes(TEST_CONFIG.apiSecret));
  });
});

describe("buildUploadUrl", () => {
  it("points at the versioned Cloudinary upload endpoint", () => {
    assert.equal(
      buildUploadUrl("demo"),
      "https://api.cloudinary.com/v1_1/demo/image/upload",
    );
  });
});

describe("parseSignRequest", () => {
  const good = { filename: "logo.png", mimeType: "image/png", sizeBytes: 1024 };

  it("accepts a valid request", () => {
    assert.deepEqual(parseSignRequest(good), good);
  });

  it("normalizes mime case and filename whitespace", () => {
    assert.deepEqual(parseSignRequest({ ...good, filename: "  a.png  ", mimeType: "Image/PNG" }), {
      filename: "a.png",
      mimeType: "image/png",
      sizeBytes: 1024,
    });
  });

  it("rejects a non-object body", () => {
    assert.throws(() => parseSignRequest(null), SignParamError);
    assert.throws(() => parseSignRequest("nope"), SignParamError);
  });

  it("rejects a missing or overlong filename", () => {
    assert.throws(() => parseSignRequest({ ...good, filename: "" }), SignParamError);
    assert.throws(() => parseSignRequest({ ...good, filename: "   " }), SignParamError);
    assert.throws(() => parseSignRequest({ ...good, filename: "x".repeat(121) }), SignParamError);
    assert.doesNotThrow(() => parseSignRequest({ ...good, filename: "x".repeat(120) }));
  });

  it("rejects non-image mime types", () => {
    for (const mimeType of ["text/plain", "video/mp4", "", "application/pdf"]) {
      assert.throws(
        () => parseSignRequest({ ...good, mimeType }),
        (e) => e instanceof SignParamError && e.status === 400,
        `expected rejection for ${JSON.stringify(mimeType)}`,
      );
    }
    for (const mimeType of ["image/jpeg", "image/webp", "image/svg+xml", "image/gif"]) {
      assert.doesNotThrow(() => parseSignRequest({ ...good, mimeType }));
    }
  });

  it("rejects bad or oversize sizeBytes", () => {
    assert.throws(() => parseSignRequest({ ...good, sizeBytes: 0 }), SignParamError);
    assert.throws(() => parseSignRequest({ ...good, sizeBytes: -5 }), SignParamError);
    assert.throws(() => parseSignRequest({ ...good, sizeBytes: 1.5 }), SignParamError);
    assert.throws(() => parseSignRequest({ ...good, sizeBytes: "100" }), SignParamError);
    assert.throws(() => parseSignRequest({ ...good, sizeBytes: MAX_UPLOAD_BYTES + 1 }), SignParamError);
    assert.doesNotThrow(() => parseSignRequest({ ...good, sizeBytes: MAX_UPLOAD_BYTES }));
    assert.equal(MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
  });
});

describe("buildSignPayload", () => {
  it("mints a signature that verifies against the payload fields (independently)", () => {
    const payload = buildSignPayload(TEST_CONFIG, "ws_123", 1_757_000_000_000);
    assert.equal(payload.timestamp, 1757000000);
    assert.equal(payload.folder, "marketr/ws_123");
    // Independent recompute: hand-built string-to-sign + node:crypto, no buildSignature.
    const expected = sha1(
      `folder=${payload.folder}&public_id=${payload.publicId}&timestamp=${payload.timestamp}${TEST_CONFIG.apiSecret}`,
    );
    assert.equal(payload.signature, expected);
  });

  it("returns delivery URLs that carry the public_id", () => {
    const payload = buildSignPayload(TEST_CONFIG, "ws_123");
    assert.ok(payload.deliveryUrl.includes(payload.publicId));
    assert.ok(payload.deliveryUrl.includes("f_auto,q_auto"));
    assert.ok(payload.thumbUrl.includes(payload.publicId));
    assert.ok(payload.thumbUrl.includes("w_400"));
    assert.ok(payload.uploadUrl.includes(TEST_CONFIG.cloudName));
  });

  it("never includes the API secret in the client-safe payload", () => {
    const payload = buildSignPayload(TEST_CONFIG, "ws_123");
    const json = JSON.stringify(payload);
    assert.ok(!json.includes(TEST_CONFIG.apiSecret), "secret leaked into sign payload");
    // Key names that must never appear, belt-and-braces.
    assert.ok(!/api[_-]?secret/i.test(json));
  });

  it("folder-scopes uploads per workspace", () => {
    const a = buildSignPayload(TEST_CONFIG, "ws_a");
    const b = buildSignPayload(TEST_CONFIG, "ws_b");
    assert.ok(a.folder.startsWith("marketr/ws_a"));
    assert.notEqual(a.folder, b.folder);
    assert.notEqual(a.publicId, b.publicId);
  });
});

describe("newPublicId", () => {
  it("is Cloudinary-safe and unique", () => {
    const id = newPublicId();
    assert.match(id, /^[a-z0-9-]+$/);
    assert.notEqual(id, newPublicId());
  });
});

describe("config and status", () => {
  const KEYS = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const;

  function withEnv(vars: Partial<Record<string, string>>, fn: () => void) {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    try {
      for (const k of KEYS) {
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
      }
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("reads config from env when all three vars are set", () => {
    withEnv(
      {
        CLOUDINARY_CLOUD_NAME: "c",
        CLOUDINARY_API_KEY: "k",
        CLOUDINARY_API_SECRET: "s",
      },
      () => {
        assert.deepEqual(getCloudinaryConfig(), { cloudName: "c", apiKey: "k", apiSecret: "s" });
        assert.equal(cloudinaryStatus().configured, true);
      },
    );
  });

  it("is unconfigured when any var is missing", () => {
    withEnv({ CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k" }, () => {
      assert.equal(getCloudinaryConfig(), null);
      assert.equal(cloudinaryStatus().configured, false);
    });
  });

  it("trims whitespace and treats empty as missing", () => {
    withEnv(
      { CLOUDINARY_CLOUD_NAME: "  ", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" },
      () => assert.equal(getCloudinaryConfig(), null),
    );
  });

  it("status never exposes key material", () => {
    withEnv(
      {
        CLOUDINARY_CLOUD_NAME: "c",
        CLOUDINARY_API_KEY: "k",
        CLOUDINARY_API_SECRET: "s",
      },
      () => {
        // Deep equality proves the status object carries nothing but flags.
        assert.deepEqual(cloudinaryStatus(), {
          name: "cloudinary",
          isLive: true,
          configured: true,
        });
      },
    );
  });

  it("unconfigured message names vars, never values", () => {
    assert.ok(NOT_CONFIGURED_MESSAGE.includes("CLOUDINARY_CLOUD_NAME"));
    assert.ok(NOT_CONFIGURED_MESSAGE.includes("Settings → Providers"));
    assert.equal(CLOUDINARY_FREE_TIER_CREDITS, 25);
  });
});
