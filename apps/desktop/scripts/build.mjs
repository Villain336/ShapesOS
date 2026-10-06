// ShapesOS Desktop build: esbuild bundles for the main process, the two
// preloads and the renderers, plus the HTML shells and design tokens.
//
//   node scripts/build.mjs               production (no test hooks)
//   node scripts/build.mjs --test-hooks  the smoke build (labelled test-only hook)
//
// The production build asserts the test hook is NOT in the bundle.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const out = join(root, "dist");
const testHooks = process.argv.includes("--test-hooks");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "renderer"), { recursive: true });

const define = {
  __TEST_HOOKS__: String(testHooks),
  __DESKTOP_UPDATE_URL__: JSON.stringify(process.env.DESKTOP_UPDATE_URL ?? ""),
  __APP_VERSION__: JSON.stringify(pkg.version),
};

const common = { bundle: true, sourcemap: testHooks ? "inline" : false, minify: !testHooks, legalComments: "linked", logLevel: "warning" };

// Main process (Node, CommonJS). Native and ESM-only modules stay external
// and are loaded at runtime from node_modules (asar-unpacked when packaged).
await build({
  ...common,
  entryPoints: { "main/index": join(root, "src/main/index.ts") },
  outdir: out,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "uiohook-napi", "get-windows", "electron-updater"],
  define,
});

// Preloads (sandboxed: one file each, only `electron` required).
await build({
  ...common,
  entryPoints: { "preload/shapes": join(root, "src/preload/shapes.ts"), "preload/internal": join(root, "src/preload/internal.ts") },
  outdir: out,
  platform: "node",
  format: "cjs",
  target: "chrome140",
  external: ["electron"],
  define,
});

// Renderers (browser, React).
await build({
  ...common,
  entryPoints: {
    "renderer/overlay": join(root, "src/renderer/overlay.tsx"),
    "renderer/ask": join(root, "src/renderer/ask.tsx"),
    "renderer/settings": join(root, "src/renderer/settings.tsx"),
    "renderer/audio": join(root, "src/renderer/audio.ts"),
    "renderer/offline": join(root, "src/renderer/offline.ts"),
    "renderer/pcm-worklet": join(root, "src/renderer/pcm-worklet.ts"),
  },
  outdir: out,
  platform: "browser",
  format: "iife",
  target: "chrome140",
  jsx: "automatic",
  define: { ...define, "process.env.NODE_ENV": JSON.stringify(testHooks ? "development" : "production") },
});

// Design tokens: the web app's own file, so desktop and web share one source.
copyFileSync(join(repo, "docs/design/tokens.css"), join(out, "renderer/tokens.css"));
copyFileSync(join(root, "src/renderer/styles.css"), join(out, "renderer/styles.css"));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  // The audio window opens the STT provider's WebSocket (wss) with a short-lived token.
  "connect-src 'self' wss: ws:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function html({ name, title, bodyClass, theme = "theme-system", body = '<div id="root"></div>' }) {
  return `<!doctype html>
<html lang="en" class="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="styles.css">
</head>
<body class="${bodyClass}">
${body}
<script src="${name}.js"></script>
</body>
</html>
`;
}

const pages = [
  { name: "overlay", title: "ShapesOS overlay", bodyClass: "overlay" },
  { name: "ask", title: "Ask ShapesOS", bodyClass: "ask" },
  { name: "settings", title: "ShapesOS settings", bodyClass: "page" },
  { name: "audio", title: "ShapesOS audio", bodyClass: "audio", body: "" },
  {
    name: "offline",
    title: "Can't reach ShapesOS",
    bodyClass: "page",
    body: `<main class="page-main" id="main-content">
<h1 class="aos-heading page-title">Can't reach ShapesOS</h1>
<p class="page-sub">ShapesOS at <span class="aos-mono" id="where"></span> didn't answer. Check your connection, or change the address in Settings.</p>
<p class="helper" id="why"></p>
<button type="button" class="btn btn--md btn-primary aos-press" id="retry">Try again</button>
</main>`,
  },
];
for (const p of pages) writeFileSync(join(out, "renderer", `${p.name}.html`), html(p));

const mainJs = readFileSync(join(out, "main/index.js"), "utf8");
const hasHook = mainJs.includes("__shapesTestHook") || mainJs.includes("TEST-ONLY HOOK");
if (!testHooks && hasHook) {
  console.error("build: the production main bundle contains the test-only hook");
  process.exit(1);
}
if (testHooks && !hasHook) {
  console.error("build: the test build is missing the test-only hook");
  process.exit(1);
}
console.log(`build: ${testHooks ? "TEST build (test-only hook included)" : "production build (test hook compiled out)"} → ${out}`);
