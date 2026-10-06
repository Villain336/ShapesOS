// ShapesOS Desktop: Settings (server, keys, exclusions, voice, permissions,
// launch at login, updates). Nothing sensitive beyond the server URL and
// preferences is stored, and never a provider key.

import { ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatHotkey } from "../shared/hotkeys";
import type { PermissionKind, PermissionStatus, SaveResult, SettingsPayload } from "../shared/ipc";
import type { DesktopSettings, SettingsErrors } from "../shared/settings";
import { desktop } from "./bridge";

const PERMISSIONS: { kind: PermissionKind; title: string; why: string }[] = [
  {
    kind: "microphone",
    title: "Microphone",
    why: "Hear you while you hold the talk key. Audio streams to ShapesOS's speech service only while the key is held.",
  },
  {
    kind: "screen",
    title: "Screen recording",
    why: "See your screen while you hold the talk key, so answers can point at the right thing. Screenshots are never saved.",
  },
  {
    kind: "accessibility",
    title: "Accessibility",
    why: "Notice the talk key in any app and paste dictated text where you are typing.",
  },
];

function Field({ id, label, error, helper, children }: { id: string; label: string; error?: string; helper?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <div className="error" id={`${id}-error`}>
          <span className="aos-shape aos-shape--failed" role="img" aria-label="Error" />
          {error}
        </div>
      ) : helper ? (
        <div className="helper">{helper}</div>
      ) : null}
    </div>
  );
}

function Switch({ label, helper, checked, onChange }: { label: string; helper?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row">
      <div className="row-text">
        <span className="row-title">{label}</span>
        {helper ? <span className="helper">{helper}</span> : null}
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function permissionText(s: PermissionStatus): string {
  return { granted: "Allowed", denied: "Off", "not-determined": "Not asked yet", restricted: "Blocked by the system", unknown: "Unknown", "not-needed": "Not needed" }[s];
}

function SettingsApp() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<DesktopSettings | null>(null);
  const [exclusions, setExclusions] = useState("");
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = await desktop.invoke<SettingsPayload>("settings:get");
    setData(p);
    setDraft(p.settings);
    setExclusions(p.settings.exclusions.join("\n"));
  }, []);
  useEffect(() => {
    void load();
    return desktop.on("settings:changed", () => void load());
  }, [load]);

  if (!data || !draft) return <main className="page-main">Loading settings…</main>;
  const st = data.status;
  const set = <K extends keyof DesktopSettings>(k: K, v: DesktopSettings[K]) => setDraft({ ...draft, [k]: v });

  const save = async () => {
    const patch = { ...draft, exclusions: exclusions.split("\n").map((l) => l.trim()).filter(Boolean) };
    const r = await desktop.invoke<SaveResult>("settings:save", patch);
    if (r.ok) {
      setErrors({});
      setSaved("Saved");
      setTimeout(() => setSaved(null), 2000);
    } else {
      setErrors(r.errors);
      setSaved(null);
    }
  };

  const keyField = (k: "holdKey" | "toggleKey" | "stopKey" | "typeKey" | "spotlightKey", label: string, helper: string) => (
    <Field id={k} label={label} error={errors[k]} helper={`${helper} Now: ${formatHotkey(draft[k], st.platform)}`}>
      <input
        id={k}
        className="input aos-mono"
        value={draft[k]}
        aria-invalid={!!errors[k]}
        aria-describedby={errors[k] ? `${k}-error` : undefined}
        onChange={(e) => set(k, e.target.value)}
      />
    </Field>
  );

  return (
    <main className="page-main" id="main-content">
      <h1 className="aos-heading page-title">Settings</h1>
      <p className="page-sub">
        {st.signedIn ? `Signed in as ${st.userName ?? "you"}.` : "Not signed in. Sign in inside the ShapesOS window."} Version {st.version}.
      </p>

      <section className="section" aria-labelledby="s-server">
        <h2 id="s-server" className="aos-subheading">Server</h2>
        <Field id="serverUrl" label="ShapesOS address" error={errors.serverUrl} helper="The hosted app, or your own self-hosted server.">
          <input
            id="serverUrl"
            className="input"
            value={draft.serverUrl}
            aria-invalid={!!errors.serverUrl}
            aria-describedby={errors.serverUrl ? "serverUrl-error" : undefined}
            onChange={(e) => set("serverUrl", e.target.value)}
          />
        </Field>
      </section>

      <section className="section" aria-labelledby="s-talk">
        <h2 id="s-talk" className="aos-subheading">Talk</h2>
        <div className="field">
          <span className="label">How the talk key works</span>
          <Segmented
            label="Talk key mode"
            value={draft.holdMode}
            options={[
              ["hold", "Hold to talk"],
              ["toggle", "Press to start and stop"],
            ]}
            onChange={(v) => set("holdMode", v)}
          />
          {draft.holdMode === "hold" && !st.holdKeyAvailable ? (
            <div className="note">
              Hold to talk isn't available right now{st.holdKeyError ? ` (${st.holdKeyError})` : ""}, so the toggle key is used instead.
            </div>
          ) : null}
        </div>
        {keyField("holdKey", "Talk key (hold)", "Hold it while you speak; let go to send.")}
        {keyField("toggleKey", "Talk key (toggle)", "Press once to start, again to send.")}
        {keyField("stopKey", "Stop key", "Cuts the answer at once.")}
        {keyField("typeKey", "Type instead", "Opens a small input near the cursor.")}
        {keyField("spotlightKey", "Open ShapesOS search", "Brings ShapesOS forward and opens ⌘K.")}
      </section>

      <section className="section" aria-labelledby="s-see">
        <h2 id="s-see" className="aos-subheading">Seeing your screen</h2>
        <p className="helper">Screenshots are taken only while the talk key is held, sent to ShapesOS for that answer, and never saved.</p>
        <div className="field">
          <span className="label">Which screens</span>
          <Segmented
            label="Which screens"
            value={draft.captureScreens}
            options={[
              ["all", "All screens"],
              ["cursor", "The screen under the cursor"],
            ]}
            onChange={(v) => set("captureScreens", v)}
          />
        </div>
        <Field
          id="exclusions"
          label="Never capture these"
          error={errors.exclusions}
          helper="One per line: an app name, bundle:com.example.app, url:bank.com or title:word."
        >
          <textarea
            id="exclusions"
            className="textarea"
            value={exclusions}
            aria-invalid={!!errors.exclusions}
            aria-describedby={errors.exclusions ? "exclusions-error" : undefined}
            onChange={(e) => setExclusions(e.target.value)}
          />
        </Field>
        <button type="button" className="btn btn-secondary aos-press" onClick={() => void desktop.invoke("settings:reset-exclusions")}>
          Restore the default list
        </button>
      </section>

      <section className="section" aria-labelledby="s-voice">
        <h2 id="s-voice" className="aos-subheading">Voice</h2>
        <div className="row">
          <div className="row-text">
            <span className="row-title">Voice: {st.voice ?? "not signed in"}</span>
            <span className="helper">
              {st.providers
                ? `Speech in: ${label(st.providers.stt)} · Speech out: ${label(st.providers.tts)} · Vision: ${label(st.providers.vision)}`
                : "Sign in to see what your server offers."}
              {st.talkMinutes ? ` · ${st.talkMinutes.used} of ${st.talkMinutes.included} talk minutes used this month` : ""}
            </span>
          </div>
          <button type="button" className="btn btn-secondary aos-press" onClick={() => void desktop.invoke("settings:open-shapes", "/dashboard/settings/cursor")}>
            Change voice
            <ExternalLink size={16} aria-hidden="true" />
          </button>
        </div>
        <Switch label="Speak answers" helper="Captions always show." checked={draft.speakAnswers} onChange={(v) => set("speakAnswers", v)} />
      </section>

      <section className="section" aria-labelledby="s-agent">
        <h2 id="s-agent" className="aos-subheading">Background runs</h2>
        <p className="helper">Say "…in the background, max $3" to hand work to ShapesOS's agents with a spend cap.</p>
        <Field id="agentDefaultUsd" label="Cap when you don't say one (USD)" error={errors.agentDefaultUsd}>
          <input id="agentDefaultUsd" className="input" type="number" min={0.01} step={0.5} value={draft.agentDefaultUsd} onChange={(e) => set("agentDefaultUsd", Number(e.target.value))} />
        </Field>
        <Field id="agentCeilingUsd" label="Highest cap you can say (USD)" error={errors.agentCeilingUsd}>
          <input id="agentCeilingUsd" className="input" type="number" min={0.01} step={1} value={draft.agentCeilingUsd} onChange={(e) => set("agentCeilingUsd", Number(e.target.value))} />
        </Field>
      </section>

      <section className="section" aria-labelledby="s-perm">
        <h2 id="s-perm" className="aos-subheading">Permissions</h2>
        {PERMISSIONS.map((p) => {
          const s = st.permissions[p.kind];
          if (s === "not-needed") return null;
          return (
            <div className="row" key={p.kind}>
              <div className="row-text">
                <span className="row-title">
                  {p.title}: {permissionText(s)}
                </span>
                <span className="helper">{p.why}</span>
              </div>
              {s === "granted" ? (
                <ShieldCheck size={20} aria-label="Allowed" />
              ) : (
                <button
                  type="button"
                  className="btn btn-primary aos-press"
                  onClick={async () => {
                    await desktop.invoke("settings:ask-permission", p.kind);
                    await load();
                  }}
                >
                  {s === "not-determined" ? "Allow" : "Open System Settings"}
                </button>
              )}
            </div>
          );
        })}
        {Object.values(st.permissions).every((s) => s === "not-needed") ? <p className="helper">This system doesn't ask for extra permissions.</p> : null}
      </section>

      <section className="section" aria-labelledby="s-app">
        <h2 id="s-app" className="aos-subheading">App</h2>
        <Switch label="Open at login" checked={draft.launchAtLogin} onChange={(v) => set("launchAtLogin", v)} />
        <Switch label="Desktop notifications" helper="New items from the ShapesOS bell." checked={draft.notifications} onChange={(v) => set("notifications", v)} />
        <Switch label="Install updates automatically" checked={draft.autoUpdate} onChange={(v) => set("autoUpdate", v)} />
        <div className="row">
          <div className="row-text">
            <span className="row-title">Update channel</span>
            <span className="helper">{st.updates.reason ?? `Updates: ${st.updates.state}`}</span>
          </div>
          <Segmented
            label="Update channel"
            value={draft.updateChannel}
            options={[
              ["stable", "Stable"],
              ["beta", "Beta"],
            ]}
            onChange={(v) => set("updateChannel", v)}
          />
        </div>
        <div className="row">
          <span className="helper">{updateMsg ?? (st.storage === "encrypted" ? "Settings are stored encrypted." : "Stored without encryption: this system has no keychain.")}</span>
          <button
            type="button"
            className="btn btn-secondary aos-press"
            onClick={async () => setUpdateMsg(await desktop.invoke<string>("settings:check-updates"))}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Check for updates
          </button>
        </div>
      </section>

      <div className="actions">
        {saved ? <span className="status-line">{saved}</span> : null}
        {Object.keys(errors).length ? <span className="error">Fix the highlighted fields.</span> : null}
        <button type="button" className="btn btn--md btn-primary aos-press" onClick={() => void save()}>
          Save settings
        </button>
      </div>
    </main>
  );
}

function label(p: string): string {
  if (p === "none") return "not configured";
  if (p === "mock") return "test mock";
  return { assemblyai: "AssemblyAI", deepgram: "Deepgram", elevenlabs: "ElevenLabs", voicestudio: "VoiceStudio", openai: "OpenAI", anthropic: "Claude" }[p] ?? p;
}

createRoot(document.getElementById("root")!).render(<SettingsApp />);
