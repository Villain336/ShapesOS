/**
 * Generates app/(payload)/admin/importMap.js without the payload CLI.
 *
 * Two interop workarounds (Payload 3.90.2 + Next 16.3.5 + Node 24):
 * 1. The payload CLI loads payload.config.ts through tsx's require() hook,
 *    which throws ERR_REQUIRE_ASYNC_MODULE because something in the config's
 *    import graph uses top-level await. Dynamic import() handles TLA fine,
 *    so we call generateImportMap directly.
 * 2. payload's bin/loadEnv.js does `import nextEnvImport from '@next/env'`
 *    but @next/env (Next 16) ships named exports with no default export, so
 *    tsx's transform crashes destructuring `.default`. We shim the CJS
 *    loader to synthesize a default export. loadEnv itself is never called —
 *    only the module top-level destructure needs to succeed.
 *
 * Run: npx tsx scripts/payload-importmap.mts
 */
import { Module } from "node:module";
import path from "node:path";

const ROOT = "/home/hatch/workspace/marketr";
process.chdir(ROOT);

// --- workaround 2: synthesize a default export for @next/env -------------
const originalLoad = (Module as any)._load;
(Module as any)._load = function (
  request: string,
  parent: any,
  isMain: boolean,
) {
  if (request === "@next/env") {
    const actual = originalLoad.call(this, request, parent, isMain);
    if (actual && !(actual as any).default) {
      return { ...actual, default: actual, __esModule: true };
    }
    return actual;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// --- workaround 1: dynamic import() instead of the CLI's require() --------
const { generateImportMap } = await import(
  path.join(ROOT, "node_modules/payload/dist/bin/generateImportMap/index.js")
);
const configModule = await import(path.join(ROOT, "payload.config.ts"));
// buildConfig() returns a Promise<SanitizedConfig> in Payload v3
const config = await configModule.default;

await generateImportMap(config, { force: true });
console.log("import map generated");
