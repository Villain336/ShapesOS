<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

## Marketr UI house pattern (lesson 2026-09-25 — Tico flagged drift twice)
The reference is the Creative Studio CODE (app/dashboard/studio/StudioApp.tsx), not a written summary. Exact patterns: page shell `bg-[#FAFAF7] p-4 md:p-6`, title `text-xl font-bold tracking-tight text-stone-900`, subtitle `text-[13px] text-stone-500`, sub-tabs with Lucide icon + label and ACTIVE = `border-[var(--brand-600)] text-[var(--brand-700)]` (never plain-text dark-underline tabs), primary buttons `bg-[var(--brand-600)] hover:bg-[var(--brand-700)]` (NEVER teal/green), data lists as DENSE TABLES with badge columns and rows `hover:bg-[var(--brand-50)]/40` (not cards), filter toolbar = dropdowns + search + brand button, info notes `border-stone-200 bg-stone-50`. Brand law: `--brand-600/700/50` in `app/globals.css` (@theme inline, Tailwind v4) default to violet (#7c3aed/#6d28d9/#f5f3ff); tenant brand kits override them — NEVER hardcode a primary color, always the vars (see `docs/audit/THEMING.md`). Before calling any new page done, diff it against StudioApp.tsx class-by-class. (Phase 7 drift: icon chips/pills/custom cards. Phase 8 drift: teal Search button, card lists, plain tabs.)

## tsc needs the heap flag too (lesson 2026-09-26)
`npx tsc --noEmit` OOMs at the default ~2GB heap on this repo exactly like `next build` does — and a backgrounded OOM can surface as a fake-clean exit, so a silent tsc pass is NOT proof of type safety. Always run `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit` and treat `next build`'s own "Running TypeScript ..." step as the real gate. (Caught 2026-09-26: two real type errors in new Knowledge Brain code that a fake-clean tsc had "passed".)
