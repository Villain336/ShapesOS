// Build the harness with esbuild (react-native -> react-native-web), serve it,
// drive it in Chrome at a phone viewport, assert behavior and save PNGs to
// mobile/web-harness/out/. Needs: react, react-dom, react-native-web, esbuild,
// playwright-core installed (CI installs them with --no-save) and a Chrome.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const sessionStub = { name: "session-stub", setup(b) {
  b.onResolve({ filter: /session-context$/ }, () => ({ path: resolve(here, "session-stub.tsx") }));
} };
await build({
  entryPoints: [join(here, "entry.tsx")],
  bundle: true,
  outfile: join(out, "bundle.js"),
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "react-native": "react-native-web" },
  define: { "process.env.NODE_ENV": '"development"', __DEV__: "true" },
  resolveExtensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".js"],
  plugins: [sessionStub],
  logLevel: "error",
});
writeFileSync(join(out, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{height:100%;margin:0}body{font-family:system-ui,sans-serif}</style></head><body><div id="root"></div><script src="bundle.js"></script></body></html>');

const server = createServer((req, res) => {
  const f = req.url === "/" ? "index.html" : req.url.slice(1);
  try {
    const buf = readFileSync(join(out, f));
    res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(buf);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
const step = (name, ok) => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/`);

  // 1. list
  await page.getByText("Meeting notes").waitFor();
  await page.getByText("Board update").waitFor();
  await page.screenshot({ path: join(out, "docs-list.png") });
  step("list shows both docs", true);

  // 2. plain doc opens editable with its real text
  await page.getByLabel("Open Meeting notes").click();
  const box = page.getByLabel("Document text");
  await box.waitFor();
  assert.equal(await box.inputValue(), "Quarterly plan\n\nRevenue grew 12% quarter over quarter.\nNext: hire two engineers.");
  assert.equal(await page.getByText("Read-only on the phone").count(), 0);
  const saveBtn = page.getByRole("button", { name: "Save", exact: true });
  assert.equal(await saveBtn.isDisabled(), true, "Save disabled until edited");
  await page.screenshot({ path: join(out, "docs-plain-open.png") });
  step("plain doc editable, Save disabled until an edit", true);

  // 3. edit + save sends the rebuilt snapshot against version 3
  await box.fill("Quarterly plan\n\nRevenue grew 12% quarter over quarter.\nNext: hire three engineers.\nOwner: Tico");
  assert.equal(await saveBtn.isDisabled(), false);
  await saveBtn.click();
  await page.getByText("Saved.").waitFor();
  const patch = (await page.evaluate(() => window.__log)).filter((c) => c.method === "PATCH").at(-1);
  assert.equal(patch.body.expectedVersion, 3);
  assert.equal(patch.body.snapshot.body.dataStream, "Quarterly plan\r\n\r\nRevenue grew 12% quarter over quarter.\r\nNext: hire three engineers.\r\nOwner: Tico\r\n");
  assert.deepEqual(patch.body.snapshot.body.paragraphs.map((p) => p.paragraphId), ["p0", "p1", "p2", "p3", "p4"]);
  assert.deepEqual(patch.body.snapshot.body.textRuns, []);
  await page.screenshot({ path: join(out, "docs-plain-saved.png") });
  step("save sends rebuilt stream with expectedVersion 3 and keeps ids", true);

  // 4. conflict: someone else saved first -> refused, edits kept, no overwrite
  await page.evaluate(() => { window.__bumpOnSave = true; });
  await box.fill("My edit that must not overwrite");
  await saveBtn.click();
  await page.getByText("This document changed somewhere else since you opened it. Nothing was saved.").waitFor();
  assert.equal(await box.inputValue(), "My edit that must not overwrite");
  await page.getByRole("button", { name: "Reload latest" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0);
  await page.screenshot({ path: join(out, "docs-conflict.png") });
  step("409 shows the conflict, keeps the typed text, offers reload, no force-save", true);
  await page.evaluate(() => { window.__bumpOnSave = false; });
  await page.getByRole("button", { name: "Reload latest" }).click();
  await page.getByText("Owner: Tico").waitFor({ state: "attached" }).catch(() => {});
  step("reload replaces the box with the latest saved text", (await box.inputValue()).includes("Owner: Tico"));

  // 5. rich doc: read-only with the reason, no Save
  await page.getByText("Back to documents").click();
  await page.getByLabel("Open Board update").click();
  await page.getByText(/Read-only on the phone\. Has bold, italic or other text formatting\. Open it on the web to edit\./).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Document text").inputValue(), "Board update\nRevenue grew 12%.");
  assert.equal(await page.getByLabel("Document text").isEditable(), false);
  const before = (await page.evaluate(() => window.__log)).filter((c) => c.method === "PATCH").length;
  await page.screenshot({ path: join(out, "docs-rich-readonly.png") });
  step("rich doc opens read-only with the reason and no Save", true);
  assert.equal(errors.length, 0, errors.join("; "));
  step("no page errors", true);
  void before;
} catch (e) {
  step(`error: ${e && e.message ? e.message.split("\n")[0] : e}`, false);
} finally {
  await browser.close();
  server.close();
}
if (results.some(([, ok]) => !ok)) process.exit(1);
