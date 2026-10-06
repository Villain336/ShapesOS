// ShapesOS — accessibility + interaction regression guard.
// Run: npx tsx --test lib/a11y/__tests__/a11y-scan.test.ts
//
// Scans every tracked .tsx under app/ and components/ with the AST rules in
// ../jsx-scan.ts, and checks no native window.confirm/alert is back (the
// shared dialog + toasts live in lib/ui/feedback.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scanTsx } from "../jsx-scan";

const ROOT = path.resolve(__dirname, "../../..");

function trackedTsx(): string[] {
  return execFileSync("git", ["ls-files", "app/*.tsx", "app/**/*.tsx", "components/*.tsx", "components/**/*.tsx"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

const rules = (src: string) => scanTsx(src).map((f) => f.rule);

describe("scanTsx rules", () => {
  it("flags a clickable div and accepts the fixes", () => {
    assert.deepEqual(rules(`<div onClick={go}>x</div>`), ["clickable-non-interactive"]);
    assert.deepEqual(rules(`<button onClick={go}>x</button>`), []);
    assert.deepEqual(rules(`<div role="button" tabIndex={0} onKeyDown={k} onClick={go}>x</div>`), []);
    // role alone is not enough without keyboard support
    assert.deepEqual(rules(`<div role="button" onClick={go}>x</div>`), ["clickable-non-interactive"]);
  });

  it("table rows need tabIndex + a key handler (row role is kept)", () => {
    assert.deepEqual(rules(`<tr onClick={go}><td/></tr>`), ["clickable-non-interactive"]);
    assert.deepEqual(rules(`<tr onClick={go} tabIndex={0} onKeyDown={k}><td/></tr>`), []);
  });

  it("accepts decorative backdrops, presentation wrappers, propagation guards, managed options", () => {
    assert.deepEqual(rules(`<div className="x" onClick={onClose} aria-hidden />`), []);
    assert.deepEqual(rules(`<div role="presentation" onClick={onClose}><div/></div>`), []);
    assert.deepEqual(rules(`<div onClick={(e) => e.stopPropagation()}>x</div>`), []);
    assert.deepEqual(rules(`<div role="option" aria-selected={a} onClick={run}>x</div>`), []);
    assert.deepEqual(rules(`<div aria-hidden={false} onClick={go}>x</div>`), ["clickable-non-interactive"]);
  });

  it("images need alt; only next/image counts as Image", () => {
    assert.deepEqual(rules(`<img src="a.png" />`), ["img-alt"]);
    assert.deepEqual(rules(`<img src="a.png" alt="" />`), []);
    assert.deepEqual(rules(`const x = <Image />;`), []); // icon component
    assert.deepEqual(rules(`import Image from "next/image";\nconst x = <Image src="a" />;`), ["img-alt"]);
  });

  it("outline-none needs a focus replacement", () => {
    assert.deepEqual(rules(`<input className="outline-none" />`), ["outline-none"]);
    assert.deepEqual(rules(`<input className="focus:outline-none" />`), ["outline-none"]);
    assert.deepEqual(rules(`<input className="outline-none focus-visible:ring-2" />`), []);
    assert.deepEqual(rules(`<input className={cn("outline-none", "focus:border-focus")} />`), []);
    assert.deepEqual(rules(`<input data-focus-ring="container" className="outline-none" />`), []);
    assert.deepEqual(rules(`<input className="outline-hidden" />`), []);
  });

  // Phase 18.1 (WS=find)
  it("icon-only buttons and links need an accessible name", () => {
    assert.deepEqual(rules(`<button onClick={go}><X size={14} /></button>`), ["icon-button-name"]);
    assert.deepEqual(rules(`<Link href="/x"><Settings className="size-4" /></Link>`), ["icon-button-name"]);
    assert.deepEqual(rules(`<button onClick={go}>{open ? <ChevronUp /> : <ChevronDown />}</button>`), ["icon-button-name"]);
    assert.deepEqual(rules(`<button aria-label="Close" onClick={go}><X /></button>`), []);
    assert.deepEqual(rules(`<button title="Close" onClick={go}><X /></button>`), []);
    assert.deepEqual(rules(`<button onClick={go}><X /> Close</button>`), []);
    assert.deepEqual(rules(`<button onClick={go}><X /><span className="sr-only">Close</span></button>`), []);
    assert.deepEqual(rules(`<button onClick={go}>{label}</button>`), [], "an expression may be text");
    assert.deepEqual(rules(`<button {...props}><X /></button>`), [], "spread props may carry the name");
    assert.deepEqual(rules(`<button onClick={go}><KeyCap>esc</KeyCap></button>`), [], "a text-bearing component");
  });

  it("no positive tabIndex", () => {
    assert.deepEqual(rules(`<div tabIndex={2} />`), ["positive-tabindex"]);
    assert.deepEqual(rules(`<div tabIndex="1" />`), ["positive-tabindex"]);
    assert.deepEqual(rules(`<div tabIndex={0} />`), []);
    assert.deepEqual(rules(`<div tabIndex={-1} />`), []);
  });
});

describe("repository", () => {
  const files = trackedTsx();

  it("has no accessibility findings in app/ and components/", () => {
    assert.ok(files.length > 100, "expected to scan the app");
    const findings: string[] = [];
    for (const f of files) {
      for (const x of scanTsx(readFileSync(path.join(ROOT, f), "utf8"), f)) {
        findings.push(`${x.rule} ${f}:${x.line} ${x.snippet}`);
      }
    }
    assert.deepEqual(findings, []);
  });

  it("uses the shared confirm dialog and toasts, not window.confirm/alert", () => {
    const offenders: string[] = [];
    const native = /(?<![\w.$])(?:window\.)?(?:confirm|alert)\(/;
    for (const f of files) {
      const lines = readFileSync(path.join(ROOT, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        if (native.test(code) && !/function (confirm|alert)\(/.test(code)) offenders.push(`${f}:${i + 1}`);
      });
    }
    // PrototypeTab defines and calls its own confirm(id) action.
    const allowed = offenders.filter((o) => !o.startsWith("app/dashboard/cad/views/PrototypeTab.tsx"));
    assert.deepEqual(allowed, []);
  });
});
