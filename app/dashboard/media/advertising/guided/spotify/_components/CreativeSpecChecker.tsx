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
  if (pass === true) return <CircleCheck className="h-4 w-4 shrink-0 text-ink" />;
  if (pass === false) return <CircleX className="h-4 w-4 shrink-0 text-failed-text" />;
  return <CircleHelp className="h-4 w-4 shrink-0 text-subtle" />;
}

const inputCls =
  "rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 text-sm text-ink file:mr-2 file:h-chip file:rounded-full file:border-0 file:bg-ink file:px-3 file:text-sm file:font-semibold file:text-white";
const textInputCls =
  "h-control-sm w-60 rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

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

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-paper px-3 py-3 shadow-hairline">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Audio ad file (WAV / MP3 / OGG)
          <input type="file" accept=".wav,.mp3,.ogg,audio/*" onChange={onAudio} className={inputCls} />
          {audio && (
            <span className="text-xs text-subtle">
              {audio.fileName} · {(audio.fileSizeBytes / 1024).toFixed(0)} KB
              {audio.durationSeconds !== null ? ` · ${audio.durationSeconds.toFixed(1)}s` : " · duration unreadable"}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
          Companion image (JPEG / PNG)
          <input type="file" accept=".jpg,.jpeg,.png,image/*" onChange={onImage} className={inputCls} />
          {image && (
            <span className="text-xs text-subtle">
              {image.width !== null ? `${image.width}×${image.height}` : "dimensions unreadable"} ·{" "}
              {image.sizeBytes !== null ? `${(image.sizeBytes / 1024).toFixed(0)} KB` : "size unreadable"}
            </span>
          )}
        </label>
      </div>
      <label className="flex max-w-60 flex-col gap-1 text-xs font-semibold text-muted">
        Script word count (optional)
        <input
          value={scriptWords}
          onChange={(e) => setScriptWords(e.target.value)}
          inputMode="numeric"
          placeholder="e.g. 60"
          className={textInputCls}
        />
      </label>
      <div>
        <button
          type="button"
          onClick={run}
          disabled={!audio || reading}
          className={btnPrimarySm}
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
                  ? "border-line bg-paper"
                  : c.pass === false
                    ? "border-failed bg-failed-tint"
                    : "border-line bg-canvas"
              }`}
            >
              <span className="mt-0.5">
                <CheckIcon pass={c.pass} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{c.rule}</p>
                <p className={`text-sm ${c.pass === false ? "text-failed-text" : "text-muted"}`}>{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-subtle">
        Checks run against the official Ad Studio specs above. Rules that couldn't be verified from your files are
        marked as such — confirm them in Ads Manager before launch.
      </p>
    </div>
  );
}
