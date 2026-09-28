// Marketr — Phase 13C clipper: segment selection.
//
// Pure function (no DB, no network): pick the top-N scored candidates,
// snap their cut points to sentence boundaries using word timestamps,
// enforce the 15–60s window, and dedupe overlapping picks.
// Greedy by score: the highest-scoring candidate always wins its window.

import type { ClipCandidate, Word, WordTimedTranscript } from "./types";

export interface SelectOptions {
  count: number;
  minSec?: number;
  maxSec?: number;
}

const SENTENCE_END = /[.!?…]["'”’)]?$/;

function isSentenceEnd(word: string): boolean {
  return SENTENCE_END.test(word.trim());
}

/** Index of the word containing time t (or nearest by start when between). */
function wordIndexAt(words: Word[], t: number): number {
  if (words.length === 0) return -1;
  for (let i = 0; i < words.length; i++) {
    if (t < words[i].end) return i;
  }
  return words.length - 1;
}

/** Walk back to the start of the current sentence; returns the start time. */
function snapStart(words: Word[], t: number): number {
  let i = wordIndexAt(words, t);
  if (i < 0) return t;
  while (i > 0 && !isSentenceEnd(words[i - 1].w)) i--;
  return words[i].start;
}

/** Walk forward to the end of the current sentence; returns the end time. */
function snapEnd(words: Word[], t: number): number {
  let i = wordIndexAt(words, t);
  if (i < 0) return t;
  while (i < words.length - 1 && !isSentenceEnd(words[i].w)) i++;
  return words[i].end;
}

/**
 * Select the top-N non-overlapping clips.
 *
 * Steps per candidate (highest score first):
 *  1. Snap start/end to sentence boundaries via word timestamps.
 *  2. If longer than maxSec, pull the end back to the latest sentence end
 *     that fits (falling back to a hard trim at a word boundary).
 *  3. If shorter than minSec, extend the end (then the start) until the
 *     minimum is met or the transcript runs out. If the whole transcript
 *     is shorter than minSec, the candidate is kept at full length.
 *  4. Skip candidates whose window overlaps an already-selected one.
 */
export function selectClips(
  candidates: ClipCandidate[],
  transcript: WordTimedTranscript,
  opts: SelectOptions,
): ClipCandidate[] {
  const count = Math.max(1, Math.floor(opts.count));
  const minSec = opts.minSec ?? 15;
  const maxSec = opts.maxSec ?? 60;
  const words = transcript.words;
  const selected: ClipCandidate[] = [];

  const overlaps = (a: ClipCandidate): boolean =>
    selected.some((s) => a.startSec < s.endSec && a.endSec > s.startSec);

  const ranked = [...candidates].sort((a, b) => b.viralityScore - a.viralityScore);

  for (const cand of ranked) {
    if (selected.length >= count) break;

    let startSec = words.length > 0 ? snapStart(words, cand.startSec) : cand.startSec;
    let endSec = words.length > 0 ? snapEnd(words, cand.endSec) : cand.endSec;

    // Enforce max: pull end back to a sentence end that fits.
    if (endSec - startSec > maxSec && words.length > 0) {
      let i = wordIndexAt(words, endSec);
      while (i > 0 && words[i].end - startSec > maxSec) i--;
      // Prefer a sentence end within the limit…
      let j = i;
      while (j > 0 && !isSentenceEnd(words[j].w) && words[j].end - startSec <= maxSec) j--;
      endSec =
        isSentenceEnd(words[j].w) && words[j].end > startSec
          ? words[j].end
          : Math.min(words[i].end, startSec + maxSec);
      if (endSec <= startSec) endSec = startSec + maxSec;
    } else if (endSec - startSec > maxSec) {
      endSec = startSec + maxSec;
    }

    // Enforce min: extend end first, then start.
    if (endSec - startSec < minSec && words.length > 0) {
      let i = wordIndexAt(words, endSec);
      while (i < words.length - 1 && words[i + 1].end - startSec < minSec) i++;
      endSec = words[i].end;
      if (endSec - startSec < minSec) {
        let k = wordIndexAt(words, startSec);
        while (k > 0 && endSec - words[k - 1].start > minSec) k--;
        startSec = words[k].start;
      }
    }

    const adjusted: ClipCandidate = {
      ...cand,
      startSec: +startSec.toFixed(2),
      endSec: +endSec.toFixed(2),
    };
    if (adjusted.endSec <= adjusted.startSec) continue;
    if (overlaps(adjusted)) continue;
    selected.push(adjusted);
  }

  return selected;
}
