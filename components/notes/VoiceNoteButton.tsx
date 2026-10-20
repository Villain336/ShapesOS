"use client";

// ShapesOS — Phase 18.2 (WS=content): record a voice note in the browser.
// MediaRecorder → POST /api/notes/voice → the existing transcription provider
// → a private note. Without a transcription key the server says so (503) and
// nothing is faked. The recording itself is not stored.

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { aosButton } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { NoteDetail } from "@/lib/notes/service";
import { notifyNotesChanged } from "./events";

const MAX_SECONDS = 10 * 60;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

export function VoiceNoteButton({
  onSaved,
  links,
  size = "sm",
}: {
  onSaved?: (note: NoteDetail) => void;
  /** Records to link the note to (e.g. the record page it was recorded on). */
  links?: Array<{ kind: string; id: string; label?: string }>;
  size?: "xs" | "sm";
}) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "recording" | "saving">("idle");
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (tick.current) clearInterval(tick.current);
      rec.current?.stream.getTracks().forEach((tr) => tr.stop());
    },
    [],
  );

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toastError(t("notes.voice.unsupported"));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toastError(t("notes.voice.denied"));
      return;
    }
    const mime = pickMime();
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    r.onstop = () => void upload(r.mimeType || mime || "audio/webm");
    rec.current = r;
    started.current = Date.now();
    setSeconds(0);
    r.start(1000);
    setState("recording");
    tick.current = setInterval(() => {
      const s = Math.floor((Date.now() - started.current) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) stop();
    }, 500);
  }

  function stop() {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    const r = rec.current;
    if (r && r.state !== "inactive") r.stop();
    r?.stream.getTracks().forEach((tr) => tr.stop());
  }

  async function upload(mime: string) {
    setState("saving");
    const secs = Math.max(1, Math.round((Date.now() - started.current) / 1000));
    const blob = new Blob(chunks.current, { type: mime.split(";")[0] });
    const form = new FormData();
    form.append("audio", new File([blob], "voice-note", { type: blob.type }));
    form.append("seconds", String(secs));
    if (links?.length) form.append("links", JSON.stringify(links));
    const res = await fetch("/api/notes/voice", { method: "POST", body: form }).catch(() => null);
    setState("idle");
    if (!res) {
      toastError(t("common.couldNotReach"));
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { note?: NoteDetail; error?: string };
    if (!res.ok || !body.note) {
      toastError(t("notes.voice.failed"), body.error);
      return;
    }
    toast({ title: t("notes.voice.saved", { title: body.note.title }) });
    notifyNotesChanged();
    onSaved?.(body.note);
  }

  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  if (state === "recording") {
    return (
      <button type="button" onClick={stop} className={aosButton({ variant: "secondary", size })} aria-live="polite">
        <Square className="size-3.5 fill-current" aria-hidden />
        {t("notes.voice.stop", { time: `${mm}:${ss}` })}
      </button>
    );
  }
  return (
    <button type="button" onClick={() => void start()} disabled={state === "saving"} className={aosButton({ variant: "secondary", size })}>
      <Mic className="size-4" aria-hidden />
      {state === "saving" ? t("notes.voice.transcribing") : t("notes.voice.record")}
    </button>
  );
}

export default VoiceNoteButton;
