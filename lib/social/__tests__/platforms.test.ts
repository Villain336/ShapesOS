// ShapesOS Phase 4b — social media validation (pure).
// Run: npx tsx --test lib/social/__tests__/platforms.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSocialUpload,
  countChars,
  normalizePlatform,
  platformLabel,
  readMedia,
  sniffSocialMedia,
  socialMaxUploadBytes,
  validatePost,
} from "../platforms";

const MB = 1024 * 1024;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(8)]);
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(8)]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const img = (sizeBytes = 100_000, mimeType = "image/png") => ({ kind: "image" as const, mimeType, sizeBytes, filename: "a.png" });
const vid = (sizeBytes = 2 * MB, mimeType = "video/mp4") => ({ kind: "video" as const, mimeType, sizeBytes, filename: "v.mp4" });

describe("normalizePlatform", () => {
  it("maps Postiz identifiers to platform keys", () => {
    assert.equal(normalizePlatform("x"), "x");
    assert.equal(normalizePlatform("twitter"), "x");
    assert.equal(normalizePlatform("linkedin-page"), "linkedin");
    assert.equal(normalizePlatform("instagram-standalone"), "instagram");
    assert.equal(normalizePlatform("Facebook"), "facebook");
    assert.equal(normalizePlatform("my weird net!"), "my_weird_net");
    assert.equal(normalizePlatform(""), "other");
    assert.equal(platformLabel("linkedin-page"), "LinkedIn");
    assert.equal(platformLabel("reddit"), "Reddit");
  });
});

describe("validatePost", () => {
  it("passes a normal image post everywhere it fits", () => {
    assert.deepEqual(validatePost(["x", "linkedin", "facebook", "instagram"], "Hello", [img()]), []);
  });

  it("enforces text length per platform on the body each one receives", () => {
    const long = "a".repeat(281);
    const issues = validatePost(["x", "linkedin"], long, []);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].platform, "x");
    assert.equal(issues[0].code, "too_long");
    assert.match(issues[0].message, /^X: text is 281 characters; the limit is 280\./);
  });

  it("counts characters, not UTF-16 units", () => {
    assert.deepEqual(validatePost(["x"], "😀".repeat(280), []), []);
  });

  it("counts every link as 23 characters on X (t.co), at full length elsewhere", () => {
    const url = `https://shapes.example/launch?utm_source=x&utm_medium=social&utm_campaign=fall&utm_content=${"p".repeat(25)}`;
    assert.equal(countChars(`Hi ${url}!`, 23), 3 + 23 + 1);
    assert.equal(countChars(`Hi ${url}`), 3 + url.length);
    assert.deepEqual(validatePost(["x"], `${"a".repeat(250)} ${url}`, []), []);
    assert.equal(validatePost(["bluesky"], `${"a".repeat(250)} ${url}`, [])[0]?.code, "too_long");
  });

  it("requires media on Instagram and exactly one video on TikTok/YouTube", () => {
    assert.deepEqual(validatePost(["instagram"], "hi", []).map((i) => i.code), ["media_required"]);
    assert.deepEqual(validatePost(["tiktok"], "hi", [img()]).map((i) => i.code), ["video_required"]);
    assert.deepEqual(validatePost(["youtube"], "hi", [vid(), vid()]).map((i) => i.code), ["video_required", "too_many_media", "too_many_videos"]);
    assert.deepEqual(validatePost(["tiktok"], "hi", [vid()]), []);
  });

  it("caps counts, rejects mixing where the platform does, and checks type + size", () => {
    const five = [img(), img(), img(), img(), img()];
    assert.deepEqual(validatePost(["x"], "hi", five).map((i) => i.code), ["too_many_media", "too_many_images"]);
    assert.deepEqual(validatePost(["x"], "hi", [img(), vid()]).map((i) => i.code), ["mixed_media"]);
    assert.deepEqual(validatePost(["instagram"], "hi", [img(), vid()]), [], "Instagram carousels mix");
    assert.deepEqual(validatePost(["instagram"], "hi", [img(100, "image/gif")]).map((i) => i.code), ["image_type"]);
    assert.deepEqual(validatePost(["x"], "hi", [img(6 * MB)]).map((i) => i.code), ["image_too_large"]);
    assert.deepEqual(validatePost(["bluesky"], "hi", [img(990 * 1024)]).map((i) => i.code), ["image_too_large"]);
    assert.deepEqual(validatePost(["bluesky"], "hi", [vid(10 * MB, "video/quicktime")]).map((i) => i.code), ["video_type"]);
  });

  it("dedupes platforms (two LinkedIn pages → one set of issues)", () => {
    assert.equal(validatePost(["linkedin", "linkedin-page"], "a".repeat(3001), []).length, 1);
  });
});

describe("upload sniffing", () => {
  it("decides the type from bytes", () => {
    assert.equal(sniffSocialMedia(png)?.mimeType, "image/png");
    assert.equal(sniffSocialMedia(jpg)?.mimeType, "image/jpeg");
    assert.equal(sniffSocialMedia(webp)?.mimeType, "image/webp");
    assert.deepEqual(sniffSocialMedia(mp4), { mimeType: "video/mp4", kind: "video", ext: "mp4" });
    assert.equal(sniffSocialMedia(mov)?.mimeType, "video/quicktime");
    assert.equal(sniffSocialMedia(webm)?.mimeType, "video/webm");
    assert.equal(sniffSocialMedia(heic), null, "HEIC is an image brand of ISO-BMFF; not accepted");
    assert.equal(sniffSocialMedia(svg), null, "SVG is never accepted for social");
    assert.equal(sniffSocialMedia(Buffer.from("%PDF-1.7")), null);
  });

  it("applies the ShapesOS cap and explains rejections", () => {
    assert.deepEqual(checkSocialUpload(Buffer.alloc(0)), { ok: false, reason: "The file is empty." });
    assert.equal(checkSocialUpload(svg).ok, false);
    const big = Buffer.concat([png, Buffer.alloc(2048)]);
    const r = checkSocialUpload(big, 1024);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /up to 1 KB/);
    assert.equal(checkSocialUpload(png).ok, true);
  });

  it("defaults the cap under the proxy body buffer and honours SOCIAL_MAX_UPLOAD_MB", () => {
    assert.ok(socialMaxUploadBytes({}) < 10 * MB);
    assert.equal(socialMaxUploadBytes({ SOCIAL_MAX_UPLOAD_MB: "50" }), 50 * MB);
    assert.equal(socialMaxUploadBytes({ SOCIAL_MAX_UPLOAD_MB: "nope" }), Math.floor(9.5 * MB));
  });

  it("readMedia drops malformed rows", () => {
    const out = readMedia([{ fileId: "f1", kind: "image", mimeType: "image/png", sizeBytes: 3, filename: "a.png" }, { kind: "image" }, null, { fileId: "f2", kind: "pdf" }]);
    assert.deepEqual(out.map((m) => m.fileId), ["f1"]);
    assert.deepEqual(readMedia("nope"), []);
  });
});
