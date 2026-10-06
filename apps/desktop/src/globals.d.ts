// Build-time constants (scripts/build.mjs `define`).
/** True only in the test build (`npm run build:test`); esbuild removes every
 *  `if (__TEST_HOOKS__)` branch from production bundles. */
declare const __TEST_HOOKS__: boolean;
/** DESKTOP_UPDATE_URL at build time ("" when unset); the runtime env wins. */
declare const __DESKTOP_UPDATE_URL__: string;
declare const __APP_VERSION__: string;
