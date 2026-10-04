<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

## VoiceStudio backend realities (lesson 2026-09-28)
The local VoiceStudio backend (`~/workspace/voicestudio`, :3900) is a SINGLE-worker CPU engine: one generation at a time, minutes per request on this box (a 12-char test took >5 min while loaded; ~50 chars took ~4 min idle). Consequences: (1) never fire concurrent syntheses — the backend 429s ("pool saturated", safe to retry in ~66s) and abandoned >600s jobs keep holding the device; (2) client timeout must be minutes, not seconds (lib/voice/voicestudio.ts defaults 600s, and classifies OUR OWN timeout as engine-slow, never "down"); (3) if a stuck job wedges it, restart with `bash ~/workspace/voicestudio/run-backend.sh` (idempotent, kills + relaunches + waits for /health) — /health stays instant even when the worker is saturated, so it is NOT proof the engine is free. Voice ids are discovered via GET /v1/audio/voices (14 OpenAI aliases + demo0001 as of 2026-09-28) — never invent them.

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

## Marketr UI house pattern (lesson 2026-09-25 — Tico flagged drift twice)
The reference is the Creative Studio CODE (app/dashboard/studio/StudioApp.tsx), not a written summary. Exact patterns: page shell `bg-[#FAFAF7] p-4 md:p-6`, title `text-xl font-bold tracking-tight text-stone-900`, subtitle `text-[13px] text-stone-500`, sub-tabs with Lucide icon + label and ACTIVE = `border-[var(--brand-600)] text-[var(--brand-700)]` (never plain-text dark-underline tabs), primary buttons `bg-[var(--brand-600)] hover:bg-[var(--brand-700)]` (NEVER teal/green), data lists as DENSE TABLES with badge columns and rows `hover:bg-[var(--brand-50)]/40` (not cards), filter toolbar = dropdowns + search + brand button, info notes `border-stone-200 bg-stone-50`. Brand law: `--brand-600/700/50` in `app/globals.css` (@theme inline, Tailwind v4) default to violet (#7c3aed/#6d28d9/#f5f3ff); tenant brand kits override them — NEVER hardcode a primary color, always the vars (see `docs/audit/THEMING.md`). Before calling any new page done, diff it against StudioApp.tsx class-by-class. (Phase 7 drift: icon chips/pills/custom cards. Phase 8 drift: teal Search button, card lists, plain tabs.)

## tsc needs the heap flag too (lesson 2026-09-26)
`npx tsc --noEmit` OOMs at the default ~2GB heap on this repo exactly like `next build` does — and a backgrounded OOM can surface as a fake-clean exit, so a silent tsc pass is NOT proof of type safety. Always run `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck` (it runs `next typegen` first — `tsc` alone fails on the generated `LayoutProps`/route types; 4096 OOMs as of 2026-10-03) and treat `next build`'s own "Running TypeScript ..." step as the real gate. (Caught 2026-09-26: two real type errors in new Knowledge Brain code that a fake-clean tsc had "passed".)

## Agentic OS design system is the law (Tico 2026-10-01)
The "Marketr UI house pattern" above (violet --brand-600, StudioApp.tsx reference, bg-[#FAFAF7]) is SUPERSEDED for all UI work. The Agentic OS design system at docs/design/DESIGN.md governs everything now: Archivo (next/font, wdth axis), JetBrains Mono for code/IDs/paths only, canvas #F3F3F1, white surfaces, black sidebar (288/80), black primary actions, status color+shape language (running blue circle / needs-you yellow triangle / done green quarter-disc / failed red square — agent states ONLY, never decoration), tokens only (no raw hex, no Tailwind default colors/grays/radii), pills for pressables, Lucide icons only, no gradients/glow/glass, no fifth accent, sentence case, headings wider not just bolder. Tico deferred dynamic tenant brand-color: do not remove the brand-kit settings machinery, but the Agentic OS tokens are the base theme.

## Tests, migrations and CI (2026-10-03)
- `npm test` = unit suites (DATABASE_URL is unset on purpose). `npm run test:db` = suites listed in `scripts/test/db-tests.txt`; a new suite that touches Postgres MUST be added there.
- Migrations: `npm run db:migrate` (`scripts/db/migrate.sh`, repairs renamed-migration history first). Every new model/enum in `schema.prisma` needs a migration — CI runs `scripts/ci/check-schema-drift.mjs` and fails on drift. Never reuse/rename a migration timestamp so it sorts before its dependencies.
- The runtime app must connect as a non-superuser role (`scripts/db/create-app-role.sql`) — superusers bypass FORCE RLS.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
