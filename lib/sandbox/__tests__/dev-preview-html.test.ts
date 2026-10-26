// ShapesOS — preview HTML bootstrap rewriting. Run: npx tsx --test lib/sandbox/__tests__/dev-preview-html.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewritePreviewHtml } from "../dev-preview-html";

const B = "/api/projects/p1/dev-preview/3000/";

describe("rewritePreviewHtml", () => {
  it("adds crossorigin=use-credentials to module scripts only, and injects the bootstrap first in <head>", () => {
    const out = rewritePreviewHtml(
      `<html><head><script type="module" src="${B}src/main.js"></script><script src="${B}classic.js"></script></head><body></body></html>`, B);
    assert.match(out, new RegExp(`<script crossorigin="use-credentials" type="module" src="${B}src/main\\.js">`), "module script credentialed");
    assert.doesNotMatch(out, /classic\.js" crossorigin/, "classic script untouched");
    assert.ok(out.indexOf("window.fetch=function") < out.indexOf('type="module"'), "bootstrap runs before the app module");
    assert.ok(out.indexOf("window.fetch=function") > out.indexOf("<head>"), "bootstrap inside head");
  });
  it("does not double-credential a script that already has crossorigin", () => {
    const out = rewritePreviewHtml(`<html><head><script type="module" crossorigin src="${B}a.js"></script></head></html>`, B);
    assert.equal(out.match(/crossorigin/g)!.length, 1);
  });
  it("the bootstrap reroutes root-absolute and relative URLs through the prefix, forces credentials, leaves full URLs alone", () => {
    const out = rewritePreviewHtml("<html><head></head><body></body></html>", B);
    assert.match(out, /u=B\+u\.slice\(1\)/, "absolute path reroute");
    assert.match(out, /u=B\+u;/, "relative path reroute");
    assert.match(out, /o\.credentials="include"/, "fetch credentials forced");
    assert.match(out, /withCredentials=true/, "XHR credentials forced");
  });
  it("injects before the first script when there is no <head>", () => {
    const out = rewritePreviewHtml(`<html><body><script type="module" src="${B}m.js"></script></body></html>`, B);
    assert.ok(out.indexOf("window.fetch=function") < out.indexOf('type="module"'));
  });
});
