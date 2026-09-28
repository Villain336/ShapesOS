# Phase 13C — Clipper (OpusClip-style video clipping module)

**Status:** SPEC DRAFT — queued after 13B. **Decided by Tico:** 2026-09-27 — Marketr module (not standalone).
**Goal:** Long video in, viral shorts out. Extends the Phase 12 native Repurpose pipeline with the video leg.

## Pipeline

1. **Ingest** — uploads + URL import (YouTube, Zoom recordings, webinars). Tenant-scoped storage (R2 path per the Cloudflare plan).
2. **Transcribe** — word-level timestamps (whisper-class; provider-pluggable, BYO key).
3. **Hook & virality scoring** — LLM scores candidate segments: hook strength in first 3s, emotional arc, quotability, topic virality vs niche. Each clip gets a 0–100 virality score with reasons.
4. **Segment selection** — top N segments, 15–60s, clean cut points on sentence boundaries.
5. **Auto-reframe** — 9:16 with face/speaker tracking; safe-area aware for TikTok/Reels/Shorts UI overlays.
6. **Captions** — word-highlight styled captions using the workspace **brand kit** (fonts, colors) — this is where Marketr beats generic clippers.
7. **Draft-for-approval** — clips land as drafts, never auto-post (the Okara lesson: draft-first avoids API bans and keeps the human in control). One-tap push to Postiz queue after approval.

## Compute reality

ffmpeg/cutting/reframe stays on the **container/VPS lane** (per the Cloudflare migration plan — never the edge). Jobs go through the queue system with progress UI. Heavy but well-understood.

## UI

- New **Clips** area (or Studio tab — decide at build): source library, clip drafts with virality scores, caption editor, brand-style presets, approve → Postiz.
- Batch: "clip this 2-hour webinar into 10 shorts" as one job.

## Data model (new)

- `ClipSource` (workspaceId, origin, duration, transcript ref)
- `Clip` (sourceId, start/end, viralityScore, scoreReasons, captionStyle, status: draft|approved|queued|posted, postizRef)

## Verification

- tsc clean, build green, tests green (new: scoring eval on seeded videos, caption-brand-kit fidelity, RLS on new tables).
- Acceptance: seeded 30-min video → ≥5 sensible clips, hooks in first 3s, captions match brand kit, zero auto-posts without approval.
- Secret scan clean, screenshots, local-only commit.

## House rules (repo law)

- UI: diff every new page against `app/dashboard/studio/StudioApp.tsx` class-by-class (page shell, tabs, buttons, dense tables). Never hardcode primary colors — `--brand-600/700/50` vars only (`docs/audit/THEMING.md`).
- tsc: always `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit`; treat `next build`'s type step as the real gate (lesson 2026-09-26).

## Sequencing

- After 13B. Feeds 13D: the voiceover agents (13D) supply AI narration tracks for clips.
