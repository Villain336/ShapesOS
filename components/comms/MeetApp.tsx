"use client";

// ShapesOS — Phase 18.2 (WS=comms): the Meet app (/dashboard/meet).
// Meetings on LiveKit (livekit-client, loaded only when you join) with a
// server-minted token; when LiveKit isn't configured the page says so and
// joining is off. After the call: the transcript (an uploaded recording or
// pasted text — nothing records during the call), then the meeting agent's
// notes, decisions and action items, which a person saves as a notes doc and
// their reminders / ops tasks.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Participant, Room as LkRoom } from "livekit-client";
import { ArrowLeft, ArrowUpRight, Bot, CalendarDays, FileText, Hash, Loader2, Mic, MicOff, PhoneOff, Sparkles, Upload, Video, VideoOff } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { aosButton } from "@/components/aos/button";
import { cn } from "@/lib/utils";
import type { MeetingView, LiveKitState } from "@/lib/comms/meet/meet.server";
import { Card, Chip, EmptyState, ErrorLine, iconBtnCls, inputCls, labelCls, MockChip, Note, PersonTile, textareaCls } from "./ui";

async function readError(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

const ORIGIN_ICON = { adhoc: Video, calendar: CalendarDays, channel: Hash } as const;

export function MeetApp({
  canEdit,
  initialMeeting,
  start,
}: {
  canEdit: boolean;
  initialMeeting?: string | null;
  start?: { title: string | null; origin: "adhoc" | "calendar" | "channel"; ref: string | null } | null;
}) {
  const { t, format } = useI18n();
  const router = useRouter();
  const [meetings, setMeetings] = useState<MeetingView[] | null>(null);
  const [livekit, setLivekit] = useState<LiveKitState | null>(null);
  const [opsProjects, setOpsProjects] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(initialMeeting ?? null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(start?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState(start ?? null);

  const load = useCallback(async () => {
    try {
      const j = await api<{ meetings: MeetingView[]; livekit: LiveKitState; opsProjects: { id: string; name: string }[] }>("/api/comms/meet");
      setMeetings(j.meetings);
      setLivekit(j.livekit);
      setOpsProjects(j.opsProjects);
      setError(null);
    } catch (e) {
      setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
      setMeetings((p) => p ?? []);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    router.replace(selected ? `/dashboard/meet?m=${encodeURIComponent(selected)}` : "/dashboard/meet", { scroll: false });
  }, [selected, router]);

  const startMeeting = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await api<{ meeting: MeetingView }>("/api/comms/meet", {
        method: "POST",
        json: { title: title.trim() || null, origin: origin?.origin ?? "adhoc", originRef: origin?.ref ?? null },
      });
      setTitle("");
      setOrigin(null);
      await load();
      setSelected(j.meeting.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const meeting = meetings?.find((m) => m.id === selected) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <div className="min-w-0">
        <h1 className="aos-heading text-ink">{t("comms.meet.title")}</h1>
        <p className="mt-1 max-w-[80ch] text-sm text-muted">{t("comms.meet.subtitle")}</p>
      </div>
      {livekit && !livekit.configured ? (
        <Note action={<Chip>{t("comms.meet.notConfigured")}</Chip>}>
          <span className="font-semibold text-ink">{t("comms.meet.notConfiguredTitle")}.</span> {t("comms.meet.notConfiguredBody", { reason: livekit.reason ?? livekit.mode })}
        </Note>
      ) : null}
      <ErrorLine message={error} />
      <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className={cn("flex min-w-0 flex-col gap-4", selected ? "hidden lg:flex" : "flex")}>
          <Card className="p-4">
            <h2 className="aos-subheading text-ink">{t("comms.meet.start")}</h2>
            {origin && origin.origin !== "adhoc" ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                {origin.origin === "calendar" ? <CalendarDays className="size-4" aria-hidden /> : <Hash className="size-4" aria-hidden />}
                {origin.origin === "calendar" ? t("comms.meet.fromCalendar") : t("comms.meet.fromChannel")}
              </p>
            ) : null}
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void startMeeting();
              }}
            >
              <label htmlFor="meet-title" className={labelCls}>
                {t("comms.meet.titleLabel")}
              </label>
              <div className="flex gap-2">
                <input id="meet-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("comms.meet.titlePlaceholder")} maxLength={200} className={inputCls} />
                <button type="submit" disabled={busy} className={aosButton({ variant: "primary", size: "md" })}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Video className="size-4" aria-hidden />}
                  {busy ? t("comms.meet.starting") : t("comms.meet.startNow")}
                </button>
              </div>
            </form>
          </Card>
          <Card aria-labelledby="meet-recent">
            <h2 id="meet-recent" className="aos-subheading border-b border-line px-4 py-3 text-ink">
              {t("comms.meet.recent")}
            </h2>
            {meetings === null ? (
              <Loader2 className="m-4 size-4 animate-spin text-muted" aria-hidden />
            ) : meetings.length === 0 ? (
              <EmptyState icon={Video} title={t("comms.meet.noMeetings")} body={t("comms.meet.noMeetingsBody")} />
            ) : (
              <ul className="divide-y divide-line">
                {meetings.map((m) => {
                  const Icon = ORIGIN_ICON[m.origin];
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(m.id)}
                        aria-current={m.id === selected ? "true" : undefined}
                        className={cn("flex w-full items-center gap-3 px-4 py-3 text-left", m.id === selected ? "bg-hover" : "hover:bg-hover-paper")}
                      >
                        <Icon className="size-4 shrink-0 text-ink" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-md font-semibold text-ink">{m.title}</span>
                          <span className="block truncate text-xs text-muted">
                            {format.date(m.startedAt, "dateTime")} · {t("comms.meet.startedBy", { name: m.startedByName })}
                          </span>
                        </span>
                        <Chip>{m.status === "open" ? t("comms.meet.statusOpen") : t("comms.meet.statusEnded")}</Chip>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        {selected ? (
          <MeetingDetail
            key={selected}
            id={selected}
            canEdit={canEdit}
            livekit={livekit}
            opsProjects={opsProjects}
            summaryRow={meeting}
            onBack={() => setSelected(null)}
            onChanged={() => void load()}
          />
        ) : (
          <Card className="hidden items-center justify-center lg:flex">
            <EmptyState icon={Video} title={t("comms.meet.start")} body={t("comms.meet.noMeetingsBody")} />
          </Card>
        )}
      </div>
    </div>
  );
}

function MeetingDetail({
  id,
  canEdit,
  livekit,
  opsProjects,
  summaryRow,
  onBack,
  onChanged,
}: {
  id: string;
  canEdit: boolean;
  livekit: LiveKitState | null;
  opsProjects: { id: string; name: string }[];
  summaryRow: MeetingView | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t, format } = useI18n();
  const [m, setM] = useState<MeetingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inCall, setInCall] = useState(false);

  const reload = useCallback(async () => {
    try {
      setM((await api<{ meeting: MeetingView }>(`/api/comms/meet/${encodeURIComponent(id)}`)).meeting);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload, summaryRow?.status]);

  const update = (next: MeetingView) => {
    setM(next);
    onChanged();
  };

  if (!m) {
    return (
      <Card className="p-4">
        <ErrorLine message={error} />
        {!error ? <Loader2 className="size-4 animate-spin text-muted" aria-hidden /> : null}
      </Card>
    );
  }
  const Icon = ORIGIN_ICON[m.origin];
  const canJoin = m.status === "open" && !!livekit?.configured;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-3">
          <button type="button" onClick={onBack} className={cn(iconBtnCls, "lg:hidden")} aria-label={t("comms.meet.back")}>
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="aos-subheading text-ink">{m.title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
              <Chip>
                <Icon className="size-3.5" aria-hidden />
                {t(`comms.meet.origins.${m.origin}`)}
              </Chip>
              <Chip>{m.status === "open" ? t("comms.meet.statusOpen") : t("comms.meet.statusEnded")}</Chip>
              <span>{format.date(m.startedAt, "dateTime")}</span>
              <span>· {t("comms.meet.startedBy", { name: m.startedByName })}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {m.channel ? (
              <Link href={`/dashboard/messages?c=${encodeURIComponent(m.channel.id)}`} className={aosButton({ variant: "secondary", size: "sm" })}>
                <Hash className="size-4" aria-hidden />
                {t("comms.meet.openChannel")}
              </Link>
            ) : null}
            {canJoin && !inCall ? (
              <button type="button" onClick={() => setInCall(true)} className={aosButton({ variant: "primary", size: "sm" })}>
                <Video className="size-4" aria-hidden />
                {t("comms.meet.join")}
              </button>
            ) : null}
            {m.status === "open" && m.canManage ? (
              <button
                type="button"
                onClick={() =>
                  void api<{ meeting: MeetingView }>(`/api/comms/meet/${encodeURIComponent(m.id)}`, { method: "PATCH", json: { end: true } })
                    .then((j) => {
                      setInCall(false);
                      update(j.meeting);
                    })
                    .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                }
                className={aosButton({ variant: "secondary", size: "sm" })}
              >
                {t("comms.meet.end")}
              </button>
            ) : null}
          </div>
        </div>
        {m.status === "ended" ? <p className="mt-2 text-sm text-muted">{t("comms.meet.ended")}</p> : null}
        <ErrorLine message={error} className="mt-2" />
      </Card>
      {inCall ? <CallRoom meetingId={m.id} onLeave={() => setInCall(false)} /> : null}
      <TranscriptCard m={m} canEdit={canEdit} onSaved={update} />
      <AgentCard m={m} canEdit={canEdit} opsProjects={opsProjects} onSaved={update} />
    </div>
  );
}

/** The call itself: livekit-client, loaded only now. */
function CallRoom({ meetingId, onLeave }: { meetingId: string; onLeave: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<"connecting" | "connected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const roomRef = useRef<LkRoom | null>(null);
  const lkRef = useRef<typeof import("livekit-client") | null>(null);
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const tok = await api<{ url: string; token: string }>(`/api/comms/meet/${encodeURIComponent(meetingId)}/token`, { method: "POST" });
        const lk = await import("livekit-client");
        lkRef.current = lk;
        const room = new lk.Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;
        const bump = () => setTick((n) => n + 1);
        const E = lk.RoomEvent;
        for (const ev of [E.ParticipantConnected, E.ParticipantDisconnected, E.TrackSubscribed, E.TrackUnsubscribed, E.LocalTrackPublished, E.LocalTrackUnpublished, E.TrackMuted, E.TrackUnmuted, E.ActiveSpeakersChanged]) room.on(ev, bump);
        room.on(E.Disconnected, () => {
          if (!cancelled) leaveRef.current();
        });
        await room.connect(tok.url, tok.token);
        if (cancelled) {
          await room.disconnect();
          return;
        }
        setState("connected");
        await room.localParticipant.enableCameraAndMicrophone().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        bump();
      } catch (e) {
        if (cancelled) return;
        setState("error");
        setError(tRef.current("comms.meet.connectError", { error: e instanceof Error ? e.message : "" }));
      }
    })();
    return () => {
      cancelled = true;
      void roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, [meetingId]);

  const room = roomRef.current;
  const lk = lkRef.current;
  const people: Participant[] = room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
  return (
    <Card className="p-4" aria-label={t("comms.meet.inCall")}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="aos-subheading min-w-0 flex-1 text-ink">
          {t("comms.meet.inCall")} {state === "connected" ? <span className="text-sm font-normal text-muted">· {t("comms.meet.people", { count: people.length })}</span> : null}
        </h3>
        {state === "connected" && room ? (
          <>
            <button
              type="button"
              aria-pressed={!mic}
              onClick={() => void room.localParticipant.setMicrophoneEnabled(!mic).then(() => setMic(!mic))}
              className={aosButton({ variant: "secondary", size: "sm" })}
              aria-label={mic ? t("comms.meet.micOff") : t("comms.meet.micOn")}
            >
              {mic ? <Mic className="size-4" aria-hidden /> : <MicOff className="size-4" aria-hidden />}
            </button>
            <button
              type="button"
              aria-pressed={!cam}
              onClick={() => void room.localParticipant.setCameraEnabled(!cam).then(() => setCam(!cam))}
              className={aosButton({ variant: "secondary", size: "sm" })}
              aria-label={cam ? t("comms.meet.camOff") : t("comms.meet.camOn")}
            >
              {cam ? <Video className="size-4" aria-hidden /> : <VideoOff className="size-4" aria-hidden />}
            </button>
          </>
        ) : null}
        <button type="button" onClick={onLeave} className={aosButton({ variant: "primary", size: "sm" })}>
          <PhoneOff className="size-4" aria-hidden />
          {t("comms.meet.leave")}
        </button>
      </div>
      {state === "connecting" ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("comms.meet.joining")}
        </p>
      ) : null}
      <ErrorLine message={error} />
      {lk && people.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {people.map((p) => (
            <li key={p.identity}>
              <Tile p={p} lk={lk} local={p === room?.localParticipant} />
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Tile({ p, lk, local }: { p: Participant; lk: typeof import("livekit-client"); local: boolean }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const camTrack = p.getTrackPublication(lk.Track.Source.Camera)?.track ?? null;
  const camOn = !!camTrack && !p.getTrackPublication(lk.Track.Source.Camera)?.isMuted;
  const micPub = p.getTrackPublication(lk.Track.Source.Microphone);
  const micTrack = micPub?.track ?? null;
  useEffect(() => {
    const el = video.current;
    if (!camTrack || !el) return;
    camTrack.attach(el);
    return () => void camTrack.detach(el);
  }, [camTrack]);
  useEffect(() => {
    const el = audio.current;
    if (local || !micTrack || !el) return; // never play your own voice back
    micTrack.attach(el);
    return () => void micTrack.detach(el);
  }, [micTrack, local]);
  const name = local ? t("comms.meet.you") : p.name || p.identity;
  return (
    <figure className={cn("relative aspect-video overflow-hidden rounded-md bg-night", p.isSpeaking && "ring-2 ring-paper ring-offset-2 ring-offset-ink")}>
      <video ref={video} autoPlay playsInline muted={local} className={cn("size-full object-cover", !camOn && "hidden")} />
      {!camOn ? (
        <div className="flex size-full items-center justify-center">
          <PersonTile name={name} size={56} className="bg-paper text-ink" />
        </div>
      ) : null}
      <audio ref={audio} autoPlay />
      <figcaption className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-paper">
        {micPub?.isMuted || !micTrack ? <MicOff className="size-3" aria-hidden /> : <Mic className="size-3" aria-hidden />}
        {name}
      </figcaption>
    </figure>
  );
}

function TranscriptCard({ m, canEdit, onSaved }: { m: MeetingView; canEdit: boolean; onSaved: (m: MeetingView) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"upload" | "paste" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const applied = !!m.summary?.applied;

  const upload = async (file: File) => {
    setBusy("upload");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/comms/meet/${encodeURIComponent(m.id)}/transcript`, { method: "POST", body: form });
      if (!res.ok) throw new Error(await readError(res));
      onSaved(((await res.json()) as { meeting: MeetingView }).meeting);
      setNotice(t("comms.meet.transcriptSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const paste = async () => {
    setBusy("paste");
    setError(null);
    try {
      const j = await api<{ meeting: MeetingView }>(`/api/comms/meet/${encodeURIComponent(m.id)}/transcript`, { method: "POST", json: { text } });
      onSaved(j.meeting);
      setText("");
      setNotice(t("comms.meet.transcriptSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const src = (m.transcriptSource === "pasted" || m.transcriptSource === "uploaded" ? m.transcriptSource : "none") as "pasted" | "uploaded" | "none";
  return (
    <Card className="p-4" aria-labelledby={`tr-${m.id}`}>
      <h3 id={`tr-${m.id}`} className="aos-subheading text-ink">
        {t("comms.meet.transcriptTitle")}
      </h3>
      <p className="mt-1 text-sm text-muted">{t("comms.meet.transcriptHint")}</p>
      <p className="mt-2 text-sm font-semibold text-ink">{t(`comms.meet.transcriptFrom.${src}`)}</p>
      {m.transcript ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-semibold text-ink">{t("comms.meet.transcriptTitle")}</summary>
          <pre className="mt-2 max-h-72 overflow-y-auto rounded-md bg-canvas p-3 font-sans text-sm whitespace-pre-wrap text-ink">{m.transcript}</pre>
        </details>
      ) : null}
      {canEdit && !applied ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              id={`rec-${m.id}`}
              type="file"
              accept="audio/*,video/*"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
            <label htmlFor={`rec-${m.id}`} className={cn(aosButton({ variant: "secondary", size: "sm" }), "cursor-pointer", busy && "pointer-events-none opacity-60")}>
              {busy === "upload" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
              {busy === "upload" ? t("comms.meet.transcribing") : t("comms.meet.uploadRecording")}
            </label>
            <span className="text-xs text-muted">{t("comms.meet.uploadHint")}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`paste-${m.id}`} className={labelCls}>
              {t("comms.meet.pasteTranscript")}
            </label>
            <textarea id={`paste-${m.id}`} rows={4} value={text} onChange={(e) => setText(e.target.value)} className={textareaCls} />
            <div>
              <button type="button" onClick={() => void paste()} disabled={!text.trim() || !!busy} className={aosButton({ variant: "primary", size: "sm" })}>
                {t("comms.meet.saveTranscript")}
              </button>
            </div>
          </div>
          <p className="text-xs text-muted">{t("comms.meet.recordingImports")}</p>
        </div>
      ) : !canEdit ? (
        <p className="mt-2 text-sm text-muted">{t("comms.meet.viewerNote")}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-sm text-ink">
          {notice}
        </p>
      ) : null}
      <ErrorLine message={error} className="mt-2" />
    </Card>
  );
}

function AgentCard({ m, canEdit, opsProjects, onSaved }: { m: MeetingView; canEdit: boolean; opsProjects: { id: string; name: string }[]; onSaved: (m: MeetingView) => void }) {
  const { t, format } = useI18n();
  const [busy, setBusy] = useState<"summary" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveDoc, setSaveDoc] = useState(true);
  const [targets, setTargets] = useState<Record<number, { target: "reminder" | "task" | "skip"; opsProjectId: string | null }>>({});
  const s = m.summary;

  const summarize = async () => {
    setBusy("summary");
    setError(null);
    try {
      onSaved((await api<{ meeting: MeetingView }>(`/api/comms/meet/${encodeURIComponent(m.id)}/summary`, { method: "POST" })).meeting);
      setTargets({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    if (!s) return;
    setBusy("apply");
    setError(null);
    try {
      const items = s.actionItems.map((_, i) => ({ index: i, target: targets[i]?.target ?? "reminder", opsProjectId: targets[i]?.opsProjectId ?? opsProjects[0]?.id ?? null }));
      onSaved((await api<{ meeting: MeetingView }>(`/api/comms/meet/${encodeURIComponent(m.id)}/apply`, { method: "POST", json: { saveDoc, items } })).meeting);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-4" aria-labelledby={`ag-${m.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="size-4 text-ink" aria-hidden />
        <h3 id={`ag-${m.id}`} className="aos-subheading min-w-0 flex-1 text-ink">
          {t("comms.meet.agentTitle")}
        </h3>
        {s?.mock ? <MockChip label={t("comms.common.mock")} /> : null}
        {canEdit && !s?.applied ? (
          <button type="button" onClick={() => void summarize()} disabled={!!busy || !m.hasTranscript} className={aosButton({ variant: s ? "secondary" : "primary", size: "sm" })}>
            {busy === "summary" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            {busy === "summary" ? t("comms.meet.summarizing") : s ? t("comms.meet.rewrite") : t("comms.meet.summarize")}
          </button>
        ) : null}
      </div>
      {!m.hasTranscript ? <p className="mt-2 text-sm text-muted">{t("comms.meet.needsTranscript")}</p> : null}
      {s ? (
        <div className="mt-3 flex flex-col gap-4">
          {s.mock ? <Note>{t("comms.meet.mockSummary")}</Note> : null}
          <section>
            <h4 className="text-sm font-semibold text-ink">{t("comms.meet.notes")}</h4>
            <p className="mt-1 text-md whitespace-pre-wrap text-ink">{s.notes || t("comms.meet.noneRecorded")}</p>
          </section>
          <section>
            <h4 className="text-sm font-semibold text-ink">{t("comms.meet.decisions")}</h4>
            {s.decisions.length ? (
              <ul className="mt-1 list-disc pl-5 text-md text-ink">
                {s.decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">{t("comms.meet.noneRecorded")}</p>
            )}
          </section>
          <section>
            <h4 className="text-sm font-semibold text-ink">{t("comms.meet.actionItems")}</h4>
            {s.actionItems.length ? (
              <ul className="mt-1 divide-y divide-line rounded-md shadow-hairline">
                {s.actionItems.map((a, i) => {
                  const cur = targets[i] ?? { target: "reminder" as const, opsProjectId: opsProjects[0]?.id ?? null };
                  return (
                    <li key={i} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-md font-semibold text-ink">{a.title}</span>
                        <span className="block text-xs text-muted">
                          {[a.owner ? t("comms.meet.owner", { name: a.owner }) : null, a.due ? t("comms.meet.due", { date: format.date(`${a.due}T12:00:00Z`, "date") }) : null].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      {canEdit && !s.applied && !s.mock ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <label className="sr-only" htmlFor={`tg-${m.id}-${i}`}>
                            {t("comms.meet.saveAs")}
                          </label>
                          <select
                            id={`tg-${m.id}-${i}`}
                            value={cur.target}
                            onChange={(e) => setTargets((p) => ({ ...p, [i]: { ...cur, target: e.target.value as "reminder" | "task" | "skip" } }))}
                            className={cn(inputCls, "h-control-sm w-auto text-sm")}
                          >
                            <option value="reminder">{t("comms.meet.targetReminder")}</option>
                            <option value="task" disabled={!opsProjects.length}>
                              {t("comms.meet.targetTask")}
                            </option>
                            <option value="skip">{t("comms.meet.targetSkip")}</option>
                          </select>
                          {cur.target === "task" ? (
                            <>
                              <label className="sr-only" htmlFor={`op-${m.id}-${i}`}>
                                {t("comms.meet.opsProject")}
                              </label>
                              <select
                                id={`op-${m.id}-${i}`}
                                value={cur.opsProjectId ?? ""}
                                onChange={(e) => setTargets((p) => ({ ...p, [i]: { ...cur, opsProjectId: e.target.value } }))}
                                className={cn(inputCls, "h-control-sm w-auto text-sm")}
                              >
                                {opsProjects.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    {o.name}
                                  </option>
                                ))}
                              </select>
                            </>
                          ) : null}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">{t("comms.meet.noneRecorded")}</p>
            )}
          </section>
          {s.applied ? (
            <div className="flex flex-wrap items-center gap-2" role="status">
              <span className="text-sm text-ink">{t("comms.meet.applied", { reminders: s.applied.reminders.length, tasks: s.applied.tasks.length })}</span>
              {m.notesDocId ? (
                <Link href={`/dashboard/office?open=${encodeURIComponent(m.notesDocId)}`} className={aosButton({ variant: "secondary", size: "sm" })}>
                  <FileText className="size-4" aria-hidden />
                  {t("comms.meet.openDoc")}
                </Link>
              ) : null}
              {s.applied.reminders.length ? (
                <Link href="/dashboard/reminders" className={aosButton({ variant: "quiet", size: "sm" })}>
                  {t("comms.meet.openReminders")}
                  <ArrowUpRight className="size-4" aria-hidden />
                </Link>
              ) : null}
            </div>
          ) : canEdit && !s.mock ? (
            <div className="flex flex-col gap-3 border-t border-line pt-3">
              <label className="flex items-center gap-2.5 text-sm text-ink">
                <input type="checkbox" checked={saveDoc} onChange={(e) => setSaveDoc(e.target.checked)} className="size-4 accent-[var(--aos-ink)]" />
                {t("comms.meet.saveDoc")}
              </label>
              <div>
                <button type="button" onClick={() => void apply()} disabled={!!busy} className={aosButton({ variant: "primary", size: "sm" })}>
                  {busy === "apply" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {busy === "apply" ? t("comms.meet.applying") : t("comms.meet.apply")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <ErrorLine message={error} className="mt-2" />
    </Card>
  );
}
