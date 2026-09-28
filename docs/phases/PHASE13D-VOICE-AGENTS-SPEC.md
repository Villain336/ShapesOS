# Phase 13D — Voice/Text Agents (LiveKit)

**Status:** APPROVED — building (Tico: "Start" 2026-09-28). **Decided by Tico:** 2026-09-27 — Marketr module (not standalone). Primary jobs: **lead follow-up + voiceovers**.
**Goal:** LiveKit-powered conversational agents inside Marketr that (1) follow up with prospects by voice/text and book meetings, and (2) generate voiceovers for clips and video content.

## Agent 1 — Lead follow-up

- **Voice calls + SMS/chat** to prospects from the prospect model: qualify, handle objections, book meetings to the calendar, log everything to the CRM.
- **Runs on LiveKit Agents framework** (STT → LLM → TTS pipeline). LiveKit Cloud vs self-hosted: decide at build (Cloud = speed, self-hosted = cost/privacy; note the Cloudflare migration — self-hosted LiveKit fits the residual VPS).
- **Persona + knowledge**: uses the 13B company intelligence layer (brand voice, products, objection handling, style rules) — the agent sells *like the company*.
- **Compliance is load-bearing, not a footnote:**
  - Outbound AI calls only to **opted-in** prospects (prior express consent). FCC's 2024 AI-robocall ruling made AI-generated voices in unsolicited calls illegal — this is not optional.
  - **AI disclosure** at call start ("Hi, I'm an AI assistant calling on behalf of X").
  - Call recording gated on state two-party-consent rules; recordings tenant-scoped.
  - Kill-switch per workspace; full transcripts + audit trail on every call.
- Draft-first lineage: call scripts are approved before the agent dials; new objection branches get flagged for review.

## Agent 2 — Voiceovers

- TTS narration tracks for 13C clips and Studio video content: paste script → pick voice → rendered track, mixed under the clip.
- **Voice backend (default): VoiceStudio** — Tico's standing instruction (2026-09-27: "Use Voicestudio repo for voice"). ALL TTS goes through the local VoiceStudio backend (`~/workspace/voicestudio`): OpenAI-compatible `POST /v1/audio/speech` at `http://localhost:3900`, voices via `GET /v1/audio/voices`, MCP at `/mcp`. Local-first, no per-minute API cost, no keys to configure. Provider voices (ElevenLabs etc.) are a per-workspace opt-in fallback ONLY if the workspace supplies its own key — never the default.
- **Brand-matched voices**: per-workspace VoiceStudio voice picks (saved voice profiles, consistent voice per brand).
- Pronunciation dictionary per workspace (product names, people — from the 13B knowledge graph).

## Shared substrate

- **LiveKit room per session**; agent worker on the container/VPS lane (needs real compute + low-latency media — never the edge).
- **TTS for the LiveKit agent pipeline defaults to VoiceStudio** (local `http://localhost:3900`, OpenAI-compatible endpoint). The agent worker calls VoiceStudio for speech output; no cloud TTS vendor in the default path.
- Text side (SMS/chat) routes through the existing messaging home — one conversation record whether the prospect called or texted.
- Per-workspace agent config: voice, persona prompt (from 13B), hours, consent lists, escalation rules ("get a human when…").

## Data model (new)

- `VoiceAgent` (workspaceId, name, purpose: followup|voiceover, voiceId, config)
- `CallSession` (agentId, prospectId, transcript, recording ref, outcome, consentProof)
- `VoiceoverJob` (workspaceId, script, voiceId, audio ref, clipRef)
- Consent/audit fields are first-class, not metadata.

## Verification

- tsc clean, build green, tests green (new: consent-gating tests — no-consent → no-dial, always; disclosure present in every call open; RLS on new tables).
- Acceptance: seeded prospect with consent → full qualify→book flow logged to CRM; seeded prospect *without* consent → hard refusal; voiceover renders and attaches to a 13C clip.
- Legal review of the disclosure/consent UX before any live dialing (Tico's call on counsel).
- Secret scan clean, screenshots, local-only commit.

## House rules (repo law)

- UI: diff every new page against `app/dashboard/studio/StudioApp.tsx` class-by-class (page shell, tabs, buttons, dense tables). Never hardcode primary colors — `--brand-600/700/50` vars only (`docs/audit/THEMING.md`).
- tsc: always `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit`; treat `next build`'s type step as the real gate (lesson 2026-09-26).

## Sequencing

- After 13C (voiceovers attach to clips). The 13B intelligence layer is its brain — 13D without 13B would be a generic callbot; with it, it's *your* salesperson.
