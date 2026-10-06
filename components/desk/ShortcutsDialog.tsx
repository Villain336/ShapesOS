"use client";

// ShapesOS — Phase 18.1 (WS=desk): the keyboard cheat-sheet ("?").
//
// Every shortcut in the registry (lib/keyboard/shortcuts.ts), grouped, with
// its keys as keycaps. Rebindable ones have "Change": press the new keys,
// then Save — the server refuses a clash, a browser combo or a bare
// navigation key and says why (PATCH /api/desk/prefs). "Reset" puts the
// default back. Stored as the member's "shortcuts" preference.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Keyboard, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "@/components/aos/button";
import { KeyCaps } from "@/components/aos/AgentAvatar";
import {
  SHORTCUTS,
  comboKeycaps,
  effectiveCombo,
  formatCombo,
  rebind,
  SHORTCUTS_BY_ID,
  type KeyStep,
  type RebindErrorCode,
  type ShortcutGroup,
} from "@/lib/keyboard/shortcuts";
import { notifyShortcutsChanged } from "./events";
// Phase 18.1 (integration): the cheat-sheet in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";
import { shortcutText, type Catalogue, type Translator } from "@/lib/i18n";

/** A shortcut's label in the active catalogue (the registry's English otherwise). */
function labelOf(messages: Catalogue, id: string): string {
  return shortcutText(messages, id).label ?? SHORTCUTS_BY_ID.get(id)?.label ?? id;
}

/** Why a rebinding was refused, in the person's language. */
function refusal(t: Translator, messages: Catalogue, code: RebindErrorCode | undefined, values: Record<string, string> | undefined, fallback: string): string {
  const v = values ?? {};
  const other = v.otherId ? `${labelOf(messages, v.otherId)}` : t("desk.shortcuts.errors.another");
  switch (code) {
    case "unknown":
      return t("desk.shortcuts.errors.unknown");
    case "fixed":
      return t("desk.shortcuts.errors.fixed", { label: labelOf(messages, v.id ?? "") });
    case "invalid":
      return t("desk.shortcuts.errors.invalid");
    case "reserved":
      return t("desk.shortcuts.errors.reserved", { combo: v.combo });
    case "navigation":
      return t("desk.shortcuts.errors.navigation", { combo: v.combo });
    case "modifier":
      return t("desk.shortcuts.errors.modifier");
    case "taken":
      return t("desk.shortcuts.errors.taken", { combo: v.combo, other });
    case "clash":
      return t("desk.shortcuts.errors.clash", { combo: v.combo, theirs: v.theirs, other });
    default:
      return fallback;
  }
}

const noopSubscribe = () => () => {};

const GROUP_ORDER: ShortcutGroup[] = ["General", "Navigation", "Agents", "App switcher", "Split view", "Desktop"];

function isMac(): boolean {
  if (typeof navigator === "undefined") return true;
  return /mac|iphone|ipad/i.test(navigator.platform ?? "");
}

/** The combo a keydown spells (for capture while rebinding). */
function stepFromEvent(e: KeyboardEvent, mac: boolean): KeyStep | null {
  if (["Control", "Alt", "Meta", "Shift"].includes(e.key)) return null;
  const code = e.code ?? "";
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : e.key === " " ? "Space" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = mac ? e.metaKey : false;
  return { mod, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey && key !== "?", key };
}

function Caps({ combo, mac }: { combo: string; mac: boolean }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {comboKeycaps(combo, mac).map((step, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-xs text-muted">{t("desk.shortcuts.then")}</span> : null}
          <KeyCaps keys={step} />
        </span>
      ))}
    </span>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  overrides,
  onOverridesChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  overrides: Record<string, string>;
  onOverridesChange: (next: Record<string, string>) => void;
}) {
  const mac = useSyncExternalStore(noopSubscribe, isMac, () => true);
  const { t, messages } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  const changeOpen = (v: boolean) => {
    if (!v) {
      setEditing(null);
      setCaptured(null);
      setError(null);
    }
    onOpenChange(v);
  };

  // While "Change" is armed, the next key combination is captured (Esc cancels).
  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => captureRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setEditing(null);
        setCaptured(null);
        return;
      }
      const step = stepFromEvent(e, mac);
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      setCaptured(formatCombo([step]));
      setError(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, mac]);

  async function save(id: string, combo: string | null) {
    // Same rules as the server, first — no round trip for an obvious clash.
    const local = rebind(overrides, id, combo);
    if (!local.ok) {
      setError(refusal(t, messages, local.code, local.values, local.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/desk/prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortcut: { id, combo } }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        shortcuts?: Record<string, string>;
        error?: string;
        code?: RebindErrorCode;
        values?: Record<string, string>;
      };
      if (!res.ok || !body.shortcuts) {
        throw new Error(body.code ? refusal(t, messages, body.code, body.values, body.error ?? "") : (body.error ?? t("desk.shortcuts.notSaved")));
      }
      onOverridesChange(body.shortcuts);
      notifyShortcutsChanged(body.shortcuts);
      setEditing(null);
      setCaptured(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("desk.shortcuts.notSaved"));
    } finally {
      setSaving(false);
    }
  }

  const groups = useMemo(
    () => GROUP_ORDER.map((g) => ({ group: g, items: SHORTCUTS.filter((s) => s.group === g) })).filter((g) => g.items.length),
    [],
  );

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-ink/40" />
        <Dialog.Popup
          data-testid="shortcuts-dialog"
          className="fixed top-[8vh] left-1/2 z-[61] flex max-h-[84vh] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-paper text-ink shadow-overlay"
        >
          <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
            <Keyboard className="size-4 text-muted" aria-hidden />
            <Dialog.Title className="flex-1 text-lg font-bold stretch-heading text-ink">{t("desk.shortcuts.title")}</Dialog.Title>
            <Dialog.Close aria-label={t("desk.shortcuts.close")} className="flex size-9 items-center justify-center rounded-full hover:bg-hover">
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="px-5 pt-3 text-sm text-muted">
            {(() => {
              // The keycap sits where {key} is in the sentence.
              const [before, after = ""] = t("desk.shortcuts.intro", { key: "\u0000" }).split("\u0000");
              return (
                <>
                  {before}
                  <KeyCaps keys={["?"]} className="mx-0.5 align-middle" />
                  {after}
                </>
              );
            })()}
          </Dialog.Description>
          {error ? (
            <p role="alert" className="mx-5 mt-3 flex items-start gap-2 text-sm text-failed-text">
              <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
              {error}
            </p>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-5">
            {groups.map(({ group, items }) => (
              <section key={group} aria-labelledby={`sc-${group.replace(/\s+/g, "-")}`} className="mt-4">
                <h3 id={`sc-${group.replace(/\s+/g, "-")}`} className="mb-1 text-xs font-semibold text-muted">
                  {t(`desk.shortcuts.groups.${group}`)}
                </h3>
                <ul className="flex flex-col">
                  {items.map((s) => {
                    const combo = effectiveCombo(s.id, overrides);
                    const changed = !!overrides[s.id];
                    const isEditing = editing === s.id;
                    const text = shortcutText(messages, s.id);
                    const label = text.label ?? s.label;
                    const hint = s.hint ? (text.hint ?? s.hint) : null;
                    return (
                      <li key={s.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-1.5 last:border-b-0" data-shortcut={s.id}>
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-medium text-ink">{label}</span>
                          {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
                        </span>
                        {isEditing ? (
                          <div ref={captureRef} tabIndex={-1} className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus" aria-live="polite">
                            <span className={cn("rounded-md px-2 py-1 text-sm", captured ? "bg-canvas" : "text-muted")}>
                              {captured ? <Caps combo={captured} mac={mac} /> : t("desk.shortcuts.pressKeys")}
                            </span>
                            <button type="button" disabled={!captured || saving} onClick={() => captured && void save(s.id, captured)} className={aosButton({ variant: "primary", size: "xs" })}>
                              {saving ? t("desk.shortcuts.saving") : t("desk.shortcuts.save")}
                            </button>
                            <button type="button" onClick={() => { setEditing(null); setCaptured(null); setError(null); }} className={aosButton({ variant: "quiet", size: "xs" })}>
                              {t("desk.shortcuts.cancel")}
                            </button>
                          </div>
                        ) : (
                          <>
                            <Caps combo={combo} mac={mac} />
                            {s.alternates?.length ? (
                              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                                {t("desk.shortcuts.or")} <Caps combo={s.alternates[0]!} mac={mac} />
                              </span>
                            ) : null}
                            {s.rebindable ? (
                              <span className="flex items-center gap-1">
                                <button type="button" onClick={() => { setEditing(s.id); setCaptured(null); setError(null); }} className={aosButton({ variant: "secondary", size: "xs" })} aria-label={t("desk.shortcuts.changeFor", { label })}>
                                  {t("desk.shortcuts.change")}
                                </button>
                                {changed ? (
                                  <button type="button" onClick={() => void save(s.id, null)} className="flex size-8 items-center justify-center rounded-full text-ink hover:bg-hover" aria-label={t("desk.shortcuts.resetFor", { label })} title={t("desk.shortcuts.resetHint")}>
                                    <RotateCcw className="size-3.5" aria-hidden />
                                  </button>
                                ) : null}
                              </span>
                            ) : null}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
