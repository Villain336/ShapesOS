<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

## Marketr UI house pattern (lesson 2026-09-25 — Tico flagged drift twice)
The reference is the Creative Studio CODE (app/dashboard/studio/StudioApp.tsx), not a written summary. Exact patterns: page shell `bg-[#FAFAF7] p-4 md:p-6`, title `text-xl font-bold tracking-tight text-stone-900`, subtitle `text-[13px] text-stone-500`, sub-tabs with Lucide icon + label and ACTIVE = `border-violet-600 text-violet-700` (never plain-text dark-underline tabs), primary buttons `bg-violet-600 hover:bg-violet-700` (NEVER teal/green), data lists as DENSE TABLES with badge columns and rows `hover:bg-violet-50/40` (not cards), filter toolbar = dropdowns + search + violet button, info notes `border-stone-200 bg-stone-50`. Before calling any new page done, diff it against StudioApp.tsx class-by-class. (Phase 7 drift: icon chips/pills/custom cards. Phase 8 drift: teal Search button, card lists, plain tabs.)
