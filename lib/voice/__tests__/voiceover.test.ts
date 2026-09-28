// Marketr — Phase 13D Worker B: voiceover lifecycle tests.
// Run: npx tsx --test lib/voice/__tests__/voiceover.test.ts
// Requires DATABASE_URL. VoiceStudio fetch is mocked — no real backend.
//
// Asserts:
//  1) createVoiceoverJob rejects an empty script (validation, pre-DB).
//  2) create → process (mocked synthesis) → ready: audioRef is a real
//     storage key, audio bytes retrievable, pronunciation snapshot stored,
//     WAV duration estimated.
//  3) A down backend lands the job in failed with an honest error
//     ("VoiceStudio backend is down"), never "ready" with no audio.
//  4) attachJobToClip links a real 13C clip tenant-scopically.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import {
  createVoiceoverJob,
  processVoiceoverJob,
  attachJobToClip,
  getJobAudio,
  getVoiceoverJob,
  deleteVoiceoverJob,
} from "../voiceover";
import { clearVoicesCache } from "../voicestudio";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

const WS = "13d-voiceover-battery";
const realFetch = globalThis.fetch;

function wavBytes(): Buffer {
  // 44-byte PCM WAV header: 8000Hz mono 16-bit, 16000 data bytes → 1.0s.
  const data = 16000;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(8000, 24); // sample rate
  b.writeUInt32LE(16000, 28); // byte rate
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}

function mockFetch(handler: (url: string) => Promise<Response>) {
  globalThis.fetch = (async (url: unknown) => handler(String(url))) as typeof fetch;
}

describe("voiceover lifecycle", () => {
  let clipId: string;

  before(async () => {
    await prisma.workspace.deleteMany({ where: { id: WS } });
    await prisma.workspace.create({
      data: { id: WS, name: "13d voiceover battery", ownerUserId: "13d-owner" },
    });
    // Fixture rows on RLS'd tables must be written inside the workspace scope.
    const { clip: clipRow } = await withWorkspaceScope(WS, async (tx) => {
      const src = await tx.clipSource.create({
        data: {
          workspaceId: WS,
          origin: "upload",
          title: "battery source",
          transcriptStatus: "ready",
        },
      });
      const clip = await tx.clip.create({
        data: {
          workspaceId: WS,
          sourceId: src.id,
          startSec: 0,
          endSec: 10,
          viralityScore: 90,
        },
      });
      await tx.pronunciationEntry.create({
        data: { workspaceId: WS, term: "Marketr", phonetic: "marketer", source: "manual" },
      });
      return { clip };
    });
    clipId = clipRow.id;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    clearVoicesCache();
    await prisma.workspace.deleteMany({ where: { id: WS } });
  });

  it("rejects an empty script at creation (validation, pre-DB)", async () => {
    await assert.rejects(
      () => createVoiceoverJob(WS, { script: "   ", voiceId: "alloy" }),
      /empty/i,
    );
    await assert.rejects(
      () => createVoiceoverJob(WS, { script: "hello", voiceId: "" }),
      /voice/i,
    );
  });

  it("renders ready with stored audio + pronunciation snapshot + duration", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/v1/audio/voices")) {
        return new Response(
          JSON.stringify({ voices: [{ voice_id: "alloy", name: "Alloy", type: "openai_alias" }] }),
          { status: 200 },
        );
      }
      return new Response(wavBytes() as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    const job = await createVoiceoverJob(WS, {
      script: "Marketr ships faster.",
      voiceId: "alloy",
    });
    assert.equal(job.status, "pending");
    assert.equal(job.progress, 0);

    const done = await processVoiceoverJob(WS, job.id);
    assert.equal(done.status, "ready");
    assert.equal(done.progress, 1);
    assert.ok(done.audioRef, "ready job must carry a storage key");
    assert.equal(done.voiceBackend, "voicestudio");
    assert.deepEqual(done.pronunciation, [{ term: "Marketr", phonetic: "marketer" }]);
    assert.ok(
      done.durationSec !== null && Math.abs(done.durationSec - 1.0) < 0.01,
      `WAV duration should parse to ~1.0s, got ${done.durationSec}`,
    );

    const audio = await getJobAudio(WS, job.id);
    assert.ok(audio, "audio bytes must be retrievable");
    assert.equal(audio.mime, "audio/wav");
    assert.ok(audio.bytes.length > 44);

    // Re-processing a ready job is a no-op, not a double render.
    const again = await processVoiceoverJob(WS, job.id);
    assert.equal(again.audioRef, done.audioRef);

    await deleteVoiceoverJob(WS, job.id);
    assert.equal(await getVoiceoverJob(WS, job.id), null);
  });

  it("lands failed (never ready) when the VoiceStudio backend is down", async () => {
    mockFetch(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    const job = await createVoiceoverJob(WS, {
      script: "This will fail honestly.",
      voiceId: "alloy",
    });
    const done = await processVoiceoverJob(WS, job.id);
    assert.equal(done.status, "failed");
    assert.ok(!done.audioRef, "failed job must not claim audio");
    assert.match(done.error ?? "", /backend is down/i);
    await deleteVoiceoverJob(WS, job.id);
  });

  it("attaches a job to a 13C clip tenant-scopically", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/v1/audio/voices")) {
        return new Response(
          JSON.stringify({ voices: [{ voice_id: "alloy", name: "Alloy", type: "openai_alias" }] }),
          { status: 200 },
        );
      }
      return new Response(wavBytes() as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    });
    const job = await createVoiceoverJob(WS, {
      script: "Attach me.",
      voiceId: "alloy",
      clipId,
    });
    assert.equal(job.clipId, clipId);

    const job2 = await createVoiceoverJob(WS, { script: "Attach me too.", voiceId: "alloy" });
    const attached = await attachJobToClip(WS, job2.id, clipId);
    assert.equal(attached.clipId, clipId);

    // Another workspace's clip id must be rejected.
    await assert.rejects(
      () => attachJobToClip(WS, job2.id, "cm000000000000000000000000"),
      /not found/i,
    );

    await deleteVoiceoverJob(WS, job.id);
    await deleteVoiceoverJob(WS, job2.id);
  });
});
