// ShapesOS — preview HTML/CSS link rewriting (capability-URL v2).
// Run: npx tsx --test lib/sandbox/__tests__/dev-preview-html.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewritePreviewCss, rewritePreviewHtml } from "../dev-preview-html";

const BASE = "/api/projects/p1/dev-preview/3000/";
const LINK = "/api/projects/p1/dev-preview/3000/cap/tok123/";

describe("rewritePreviewHtml", () => {
  it("rewrites the tokenless base to the token-full prefix and injects the bootstrap first in <head>", () => {
    const out = rewritePreviewHtml(
      `<html><head><script type="module" src="${BASE}src/main.js"></script><link href="${BASE}src/style.css" rel="stylesheet"></head><body></body></html>`,
      BASE, LINK);
    assert.ok(out.includes(`src="${LINK}src/main.js"`), "module script rebased to the token-full prefix");
    assert.ok(out.includes(`href="${LINK}src/style.css"`), "stylesheet rebased");
    assert.ok(!out.includes(`"${BASE}src/`), "no tokenless asset URLs remain");
    assert.ok(out.indexOf("window.fetch=function") > out.indexOf("<head>"), "bootstrap inside head");
    assert.ok(out.indexOf("window.fetch=function") < out.indexOf('type="module"'), "bootstrap runs before the app module");
  });
  it("adds NO crossorigin attributes and forces NO credentials (auth is the URL, not a cookie)", () => {
    const out = rewritePreviewHtml(
      `<html><head><script type="module" src="${BASE}src/main.js"></script></head></html>`, BASE, LINK);
    assert.ok(!out.includes("crossorigin"), "no crossorigin injection");
    assert.ok(!out.includes("credentials"), "no credentials forcing");
    assert.ok(!out.includes("withCredentials"), "no XHR withCredentials");
  });
  it("bootstrap rewrites root-absolute and relative paths but never /api/projects/ (app API) or external URLs", () => {
    const out = rewritePreviewHtml("<html><head></head><body></body></html>", BASE, LINK);
    assert.ok(out.includes(`if(u.indexOf("/api/projects/")!==0)return B+u.slice(1);return u;`), "app-API paths pass through unrewritten");
    assert.ok(out.includes(JSON.stringify(LINK)), "bootstrap carries the token-full prefix");
  });
  it("injects before the first <script> when there is no <head>", () => {
    const out = rewritePreviewHtml(`<html><body><script type="module" src="${BASE}m.js"></script></body></html>`, BASE, LINK);
    assert.ok(out.indexOf("window.fetch=function") < out.indexOf('type="module"'), "bootstrap before the app module");
  });
});

describe("rewritePreviewCss", () => {
  it("rewrites root-absolute url()s from the tokenless base to the token-full prefix", () => {
    const out = rewritePreviewCss(`a{background:url("${BASE}img/bg.png")}b{background:url(/other/x.png)}`, BASE, LINK);
    assert.ok(out.includes(`url("${LINK}img/bg.png")`), "base-prefixed url() rewritten");
    assert.ok(out.includes("url(/other/x.png)"), "non-base absolute left (bootstrap handles it at fetch time only for fetch/XHR - documented limitation)");
  });
});
