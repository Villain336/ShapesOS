"use client";

// ShapesOS — Phase 12 (people): the door check-in screen. Big input that a
// USB/Bluetooth QR scanner types into (it ends with Enter), plus the
// device camera through the browser's built-in BarcodeDetector where the
// browser has it (no new dependency). Every scan posts to
// /api/ops/events/check-in, which marks the attendee ONCE; a second scan of
// the same ticket answers "already checked in". Result colours follow the
// house rule: neutral surfaces, a failed-red square only for a refusal.

import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ScanLine } from "lucide-react";
import { aosButton } from "@/components/aos";
import { inputCls } from "@/components/ops-finance/kit";
import { jsonPost } from "@/components/ops-finance/useGated";

interface Result {
  status: "checked_in" | "already_checked_in" | "not_confirmed" | "invalid";
  message: string;
  attendee?: { name: string; ticketType: string; email: string | null };
}

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

type DetectorCtor = new (opts: { formats: string[] }) => DetectorLike;

export function CheckInScreen({ eventId, initialCount, total }: { eventId: string; initialCount: number; total: number }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [count, setCount] = useState(initialCount);
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastScan = useRef<{ value: string; at: number }>({ value: "", at: 0 });

  async function submit(value: string) {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      const r = await jsonPost("/api/ops/events/check-in", { code: v, eventId });
      const d = (await r.json().catch(() => ({}))) as Result & { error?: string };
      if (!r.ok) setResult({ status: "invalid", message: d.error ?? "Check-in failed." });
      else {
        setResult(d);
        if (d.status === "checked_in") setCount((c) => c + 1);
      }
    } catch {
      setResult({ status: "invalid", message: "No connection — try again." });
    } finally {
      setBusy(false);
      setCode("");
      inputRef.current?.focus();
    }
  }

  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null;
    let stop = false;
    const Detector = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Detector) {
      setCameraError("This browser can't read QR codes from the camera — use a scanner or type the code.");
      setCamera(false);
      return;
    }
    const detector = new Detector({ formats: ["qr_code"] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        while (!stop) {
          const found = await detector.detect(videoRef.current).catch(() => []);
          const raw = found[0]?.rawValue;
          const now = Date.now();
          // Debounce: the same code in front of the camera is one scan.
          if (raw && (raw !== lastScan.current.value || now - lastScan.current.at > 4000)) {
            lastScan.current = { value: raw, at: now };
            await submit(raw);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setCameraError("Camera unavailable — allow camera access or use a scanner.");
        setCamera(false);
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
    // submit is stable enough for this loop (it reads state through setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  const ok = result?.status === "checked_in";
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
        className="flex flex-wrap items-center gap-3"
      >
        <label className="flex min-w-[280px] flex-1 items-center gap-2">
          <ScanLine size={20} aria-hidden />
          <span className="sr-only">Ticket code</span>
          <input ref={inputRef} autoFocus className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan a ticket or paste its link" disabled={busy} />
        </label>
        <button type="submit" className={aosButton({ variant: "primary" })} disabled={busy || !code.trim()}>
          Check in
        </button>
        <button type="button" className={aosButton({ variant: "secondary" })} onClick={() => { setCameraError(null); setCamera((c) => !c); }}>
          {camera ? <CameraOff size={18} aria-hidden /> : <Camera size={18} aria-hidden />}
          {camera ? "Stop camera" : "Use camera"}
        </button>
      </form>
      {camera ? <video ref={videoRef} className="aspect-video w-full max-w-md rounded-md bg-ink" muted playsInline /> : null}
      {cameraError ? <p className="text-sm text-muted">{cameraError}</p> : null}
      <div aria-live="polite" className="min-h-[96px]">
        {result ? (
          <div className={`flex items-start gap-3 rounded-lg px-5 py-4 shadow-hairline ${ok ? "bg-paper" : "bg-canvas"}`}>
            {result.status === "invalid" || result.status === "not_confirmed" ? <span aria-hidden className="mt-2 size-3 shrink-0 bg-failed" /> : null}
            <div>
              <p className="text-[22px] font-bold leading-tight">{ok ? result.attendee?.name ?? "Checked in" : result.status === "already_checked_in" ? "Already checked in" : "Not admitted"}</p>
              <p className="text-md text-muted">
                {result.message}
                {result.attendee ? ` · ${result.attendee.ticketType}` : ""}
              </p>
            </div>
          </div>
        ) : null}
      </div>
      <p className="text-md tabular-nums text-muted">
        {count} of {total} checked in
      </p>
    </div>
  );
}
