// ShapesOS — dev-preview capability cookie: sign/verify round trips and
// every refusal path. Run: npx tsx --test lib/sandbox/__tests__/dev-preview-cookie.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  devPreviewCookiePath,
  devPreviewSetCookie,
  signDevPreviewToken,
  verifyDevPreviewToken,
} from "../dev-preview-cookie";

const ENV = { AUTH_SECRET: "test-secret" };
const claims = { projectId: "p1", port: 3000, userId: "u1", workspaceId: "ws1", exp: Math.floor(Date.now() / 1000) + 600 };

describe("dev-preview capability cookie", () => {
  it("round-trips valid claims for the same project+port", () => {
    const token = signDevPreviewToken(claims, ENV)!;
    assert.ok(token);
    assert.deepEqual(verifyDevPreviewToken(token, "p1", 3000, ENV), claims);
  });
  it("refuses another project or port", () => {
    const token = signDevPreviewToken(claims, ENV)!;
    assert.equal(verifyDevPreviewToken(token, "p2", 3000, ENV), null);
    assert.equal(verifyDevPreviewToken(token, "p1", 5173, ENV), null);
  });
  it("refuses a tampered body and a wrong-secret signature", () => {
    const token = signDevPreviewToken(claims, ENV)!;
    const [body] = token.split(".");
    const forged = signDevPreviewToken(claims, { AUTH_SECRET: "other" })!;
    assert.equal(verifyDevPreviewToken(`${body}.${forged.split(".")[1]}`, "p1", 3000, ENV), null, "swapped signature");
    assert.equal(verifyDevPreviewToken(forged, "p1", 3000, ENV), null, "wrong secret");
    const tamperedBody = Buffer.from(JSON.stringify(["p1", 3000, "u1", "ws1", claims.exp + 99999])).toString("base64url");
    assert.equal(verifyDevPreviewToken(`${tamperedBody}.${token.split(".")[1]}`, "p1", 3000, ENV), null, "extended expiry without resigning");
  });
  it("refuses expired, malformed, and secret-less tokens", () => {
    const expired = signDevPreviewToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, ENV)!;
    assert.equal(verifyDevPreviewToken(expired, "p1", 3000, ENV), null);
    assert.equal(verifyDevPreviewToken("not-a-token", "p1", 3000, ENV), null);
    assert.equal(verifyDevPreviewToken(undefined, "p1", 3000, ENV), null);
    assert.equal(signDevPreviewToken(claims, {}), null, "no secret -> no token (fail closed)");
  });
  it("scopes the cookie to exactly the one preview path, SameSite=None for the sandboxed frame", () => {
    assert.equal(devPreviewCookiePath("p1", 3000), "/api/projects/p1/dev-preview/3000/");
    const c = devPreviewSetCookie("tok", "p1", 3000);
    assert.match(c, /Path=\/api\/projects\/p1\/dev-preview\/3000\//);
    assert.match(c, /HttpOnly; Secure; SameSite=None/);
  });
});
