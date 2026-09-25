// Ambient declaration for @lob/lob-typescript-sdk.
//
// The SDK ships types at dist/index.d.ts, but its package.json "exports"
// map only exposes them under the "node" condition — TS's bundler
// resolution picks "default" (index.mjs) and reports TS7016. This is a
// known SDK packaging quirk, not something we can fix from here.
//
// lib/mail/lob.ts wraps every SDK call in try/catch with key-scrubbed
// errors and reads responses defensively, so the implicit-any surface is
// contained to that one module.
declare module "@lob/lob-typescript-sdk";
