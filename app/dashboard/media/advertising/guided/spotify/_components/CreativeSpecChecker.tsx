// Marketr — Phase 18 slice 5: audio creative spec checker.
//
// The user picks their audio file and companion image; the component reads
// real file attributes (name, byte size, audio duration via metadata,
// image dimensions via decode) and checks them against the official Ad
// Studio specs. Anything not provided is reported as "couldn't verify",
// never assumed.

"use client";

import { useState, type ChangeEvent } from "react";
import { FileAudio, Loader2, CircleCheck, CircleX, CircleHelp } from "lucide-react";
import {
  checkSpotifyAudioCreative,
  type SpotifySpecCheck,
} from "@/lib/adplatforms/spotify/planning";

interface AudioMeta {
  fileName: string;
  fileSizeBytes: number;
  durationSeconds: number | null;
}

interface ImageMeta {
  width: number | null;
  height: number | null;
  ext: string;
  sizeBytes: number | null;
}

function loadAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const cleanup = () => URL.revokeObjectURL(url);
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 15000);
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      const d = Number.isFinite(audio.duration) ? audio.duration : null;
      cleanup();
      resolve(d);
    };
    audio.onerror = () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    };
    audio.src = url;
  });
}

function loadImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 15000);
    img.onload = () => {
      clearTimeout(timer);
      cleanup();
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    };
    img.src = url;
  });
}

function CheckIcon({ pass }: { pass: boolean | null }) {
  if (pass === true) return <CircleCheck className="h-4 w-4 shrink-0 text-emerald-600" />;
  if (pass === false) return <CircleX className="h-4 w-4 shrink-0 text-red-600" />;
  return <CircleHelp className="h-4 w-4 shrink-0 text-stone-400" />;
}

export default function CreativeSpecChecker() {
  const [audio, setAudio] = useState<AudioMeta | null>(null);
  const [image, setImage] = useState<ImageMeta | null>(null);
  const [scriptWords, setScriptWords] = useState("");
  const [reading, setReading] = useState(false);
  const [checks, setChecks] = useState<SpotifySpecCheck[] | null>(null);

  async function onAudio(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setReading(true);
    try {
      const durationSeconds = await loadAudioDuration(f);
      setAudio({ fileName: f.name, fileSizeBytes: f.size, durationSeconds });
    } finally {
      setReading(false);
    }
  }

  async function onImage(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setReading(true);
    try {
      const dims = await loadImageDimensions(f);
      setImage({
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        ext: f.name.split(".").pop() ?? "",
        sizeBytes: f.size,
      });
    } finally {
      setReading(false);
    }
  }

  function run() {
    if (!audio) return;
    const words = scriptWords.trim() === "" ? null : Number(scriptWords);
    setChecks(
      checkSpotifyAudioCreative({
        fileName: audio.fileName,
        fileSizeBytes: audio.fileSizeBytes,
        durationSeconds: audio.durationSeconds,
        imageWidth: image?.width ?? null,
        imageHeight: image?.height ?? null,
        imageExt: image?.ext ?? "",
        imageSizeBytes: image?.sizeBytes ?? null,
        scriptWords: Number.isFinite(words) && words !== null && words >= 0 ? words : null,
      }),
    );
  }

  const inputCls =
    "rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] text-stone-900 file:mr-2 file:rounded-md file:border-0 file:bg-stone-100 file:px-2 file:py-1 file:text-[12px] file:font-medium file:text-stone-700 hover:file:bg-stone-200";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-3 py-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Audio ad file (WAV / MP3 / OGG)
          <input type="file" accept=".wav,.mp3,.ogg,audio/*" onChange={onAudio} className={inputCls} />
          {audio && (
            <span className="text-[11px] text-stone-400">
              {audio.fileName} · {(audio.fileSizeBytes / 1024).toFixed(0)} KB
              {audio.durationSeconds !== null ? ` · ${audio.durationSeconds.toFixed(1)}s` : " · duration unreadable"}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Companion image (JPEG / PNG)
          <input type="file" accept=".jpg,.jpeg,.png,image/*" onChange={onImage} className={inputCls} />
          {image && (
            <span className="text-[11px] text-stone-400">
              {image.width !== null ? `${image.width}×${image.height}` : "dimensions unreadable"} ·{" "}
              {image.sizeBytes !== null ? `${(image.sizeBytes / 1024).toFixed(0)} KB` : "size unreadable"}
            </span>
          )}
        </label>
      </div>
      <label className="flex max-w-60 flex-col gap-1 text-[12px] text-stone-600">
        Script word count (optional)
        <input
          value={scriptWords}
          onChange={(e) => setScriptWords(e.target.value)}
          inputMode="numeric"
          placeholder="e.g. 60"
          className="rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
        />
      </label>
      <div>
        <button
          type="button"
          onClick={run}
          disabled={!audio || reading}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
        >
          {reading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileAudio className="h-3.5 w-3.5" />}
          {reading ? "Reading files…" : "Check creative"}
        </button>
      </div>
      {checks && (
        <ul className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <li
              key={c.rule}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
                c.pass === true
                  ? "border-emerald-200 bg-emerald-50/50"
                  : c.pass === false
                    ? "border-red-200 bg-red-50/50"
                    : "border-stone-200 bg-stone-50"
              }`}
            >
              <span className="mt-0.5">
                <CheckIcon pass={c.pass} />
              </span>
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-stone-900">{c.rule}</p>
                <p className="text-[12px] text-stone-500">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-stone-400">
        Checks run against the official Ad Studio specs above. Rules that couldn't be verified from your files are
        marked as such — confirm them in Ads Manager before launch.
      </p>
    </div>
  );
}
