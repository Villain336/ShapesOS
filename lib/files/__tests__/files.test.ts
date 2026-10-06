// ShapesOS — Phase 18.2 (WS=content): Files pure parts (unit): version
// retention, share-link tokens / expiry / passwords / unlock cookies,
// annotation rectangles, preview kinds, CSV, and the Files agent tools' tiers.
// Run: npx tsx --test lib/files/__tests__/files.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRetention, versionsToPurge } from "@/lib/filesystem/versions";
import {
  SHARE_DEFAULT_DAYS,
  SHARE_UNLOCK_MS,
  generateShareToken,
  hashSharePassword,
  hashShareToken,
  isShareTokenShape,
  shareExpiry,
  shareUnusableReason,
  signUnlock,
  unlockCookieName,
  verifySharePassword,
  verifyUnlock,
} from "../shares";
import { normalizeRects } from "../annotations";
import { isPreviewableMime, parseCsv, previewKind } from "../preview";
import { FILE_TOOLS, list_file_versions, share_file_link } from "../tools";
import { TOOL_ACTION, TOOL_GROUP, getTool } from "@/lib/chat/tools";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { KNOWN_ACTIONS } from "@/lib/automation/policy";
import { isUserFileRequest, contentSecurityPolicyFor, USER_FILE_VIEW_CSP } from "@/lib/security/headers";

describe("version retention", () => {
  it("purges the oldest previous versions beyond the setting", () => {
    const prev = [1, 2, 3, 4, 5].map((version) => ({ version }));
    assert.deepEqual(versionsToPurge(prev, 3).map((v) => v.version).sort(), [1, 2]);
    assert.deepEqual(versionsToPurge(prev, 10), []);
    assert.deepEqual(versionsToPurge(prev, 0).length, 5);
    assert.deepEqual(versionsToPurge([{ version: 9 }, { version: 2 }, { version: 7 }], 1).map((v) => v.version).sort(), [2, 7], "by version number, not order");
  });
  it("accepts 1..200", () => {
    assert.deepEqual(checkRetention(20), { ok: true, value: 20 });
    assert.equal(checkRetention(0).ok, false);
    assert.equal(checkRetention(201).ok, false);
    assert.equal(checkRetention(2.5).ok, false);
    assert.equal(checkRetention("x").ok, false);
  });
});

describe("share links", () => {
  it("tokens are 128 random bits, prefixed, and only their hash is stored", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    assert.notEqual(a, b);
    assert.ok(isShareTokenShape(a));
    assert.ok(!isShareTokenShape("fsh_short") && !isShareTokenShape(`x${a.slice(1)}`) && !isShareTokenShape(`${a}0`));
    assert.match(hashShareToken(a), /^[0-9a-f]{64}$/);
    assert.notEqual(hashShareToken(a), a);
  });
  it("expire in 1-90 days (7 by default) and refuse past/revoked", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    assert.equal(shareExpiry(undefined, now).getTime() - now.getTime(), SHARE_DEFAULT_DAYS * 86_400_000);
    assert.equal(shareExpiry(90, now).getTime() - now.getTime(), 90 * 86_400_000);
    assert.throws(() => shareExpiry(0, now));
    assert.throws(() => shareExpiry(91, now));
    assert.throws(() => shareExpiry(1.5, now));
    assert.equal(shareUnusableReason({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now), null);
    assert.equal(shareUnusableReason({ revokedAt: null, expiresAt: now }, now), "expired");
    assert.equal(shareUnusableReason({ revokedAt: now, expiresAt: null }, now), "revoked");
  });
  it("passwords are salted scrypt and verify only the right one", async () => {
    const h1 = await hashSharePassword("correct horse");
    const h2 = await hashSharePassword("correct horse");
    assert.notEqual(h1, h2, "salted");
    assert.match(h1, /^scrypt\$16384\$/);
    assert.equal(await verifySharePassword("correct horse", h1), true);
    assert.equal(await verifySharePassword("correct hors", h1), false);
    assert.equal(await verifySharePassword("correct horse", "garbage"), false);
  });
  it("the unlock cookie is per link, signed and short-lived", () => {
    const secret = "unit-secret-0123456789abcdef";
    const now = 1_000_000;
    const v = signUnlock("link1", secret, now);
    assert.equal(verifyUnlock("link1", v, secret, now + 1000), true);
    assert.equal(verifyUnlock("link2", v, secret, now + 1000), false, "another link's cookie doesn't open this one");
    assert.equal(verifyUnlock("link1", v, "other-secret-0123456789abc", now + 1000), false);
    assert.equal(verifyUnlock("link1", v, secret, now + SHARE_UNLOCK_MS + 1), false, "expires");
    assert.equal(verifyUnlock("link1", `${now + 10 ** 9}.${v.split(".")[1]}`, secret, now), false, "can't extend the expiry");
    assert.equal(verifyUnlock("link1", undefined, secret, now), false);
    assert.equal(unlockCookieName("ab;c"), "fsh_unlock_abc");
  });
  it("the share bytes route gets the sandboxed user-file CSP", () => {
    assert.ok(isUserFileRequest("/r/file/fsh_abc/raw"));
    assert.ok(!isUserFileRequest("/r/file/fsh_abc"), "the viewer page keeps the page CSP");
    assert.equal(contentSecurityPolicyFor("/r/file/fsh_abc/raw", { nonce: "AAAAAAAAAAAAAAAAAAAAAA==" }), USER_FILE_VIEW_CSP);
  });
});

describe("annotations and previews", () => {
  it("rectangles are clamped inside the page and bounded", () => {
    assert.deepEqual(normalizeRects([{ x: 0.9, y: -1, w: 0.5, h: 0.2 }]), [{ x: 0.9, y: 0, w: 0.09999999999999998, h: 0.2 }]);
    assert.throws(() => normalizeRects([]));
    assert.throws(() => normalizeRects([{ x: 0, y: 0, w: 0, h: 1 }]));
    assert.throws(() => normalizeRects([{ x: "a", y: 0, w: 1, h: 1 }]));
    assert.throws(() => normalizeRects(Array.from({ length: 65 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 }))));
  });
  it("preview kinds; SVG and office files are never previewed from raw bytes", () => {
    assert.equal(previewKind("image/png"), "image");
    assert.equal(previewKind("application/pdf"), "pdf");
    assert.equal(previewKind("video/mp4"), "video");
    assert.equal(previewKind("audio/mpeg"), "audio");
    assert.equal(previewKind("text/plain", "a.csv"), "csv");
    assert.equal(previewKind("text/plain", "notes.md"), "markdown");
    assert.equal(previewKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "office");
    assert.equal(previewKind("image/svg+xml"), "none");
    assert.equal(isPreviewableMime("image/svg+xml"), false);
    assert.equal(isPreviewableMime("application/zip"), false);
    assert.equal(isPreviewableMime("text/plain"), true);
  });
  it("parses CSV with quotes, escaped quotes and CRLF", () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n3,'), [["a", "b"], ["x, y", 'say "hi"'], ["3", ""]]);
    assert.equal(parseCsv("a\n".repeat(1000), 10).length, 10);
  });
});

describe("files agent tools", () => {
  it("are registered with deliberate groups and tiers", () => {
    assert.equal(FILE_TOOLS.length, 2);
    assert.equal(getTool("list_file_versions"), list_file_versions);
    assert.equal(getTool("share_file_link"), share_file_link);
    assert.equal(list_file_versions.kind, "safe");
    assert.equal(TOOL_GROUP.list_file_versions, "workspace");
    assert.equal(share_file_link.kind, "publish");
    assert.equal(share_file_link.minRole, "editor");
    assert.equal(TOOL_GROUP.share_file_link, "content");
    assert.equal(TOOL_ACTION.share_file_link, "share_file_externally");
    const auto = { smallActionThresholdCents: 10_000, automationAllows: true };
    assert.equal(evaluateTier({ kind: "share_file_externally", description: `share_file_link: ${share_file_link.description}` }, auto), 2, "always Tier 2 (asks unless a rule says Auto-run), never Tier 1, never Tier 3");
    assert.equal(evaluateTier({ kind: "list_file_versions", description: `list_file_versions: ${list_file_versions.description}` }, auto), 0);
    assert.ok(KNOWN_ACTIONS.some((a) => a.action === "share_file_externally"));
  });
});
