"use client";

// ShapesOS — Agentic OS form controls (kit: command-and-inputs.png):
//   PermissionSegmented — Ask first (needs yellow, black text) / Auto-run
//     (running blue) / Off (ink); a radiogroup with arrow-key movement.
//   Switch — 44×26 pill, ink when on, #8A8A86 when off, role="switch".
//   SwitchRow — label + helper on the left, switch on the right.
//   Field — 44px input, radius-md, 1.5px control border, focus halo,
//     helper text, error state (red border, red square + message).

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Permission segmented control
// ---------------------------------------------------------------------------

export type Permission = "ask" | "auto" | "off";

export const PERMISSION_OPTIONS: ReadonlyArray<{ value: Permission; label: string; selected: string }> = [
  { value: "ask", label: "Ask first", selected: "bg-needs text-ink" },
  { value: "auto", label: "Auto-run", selected: "bg-running text-paper" },
  { value: "off", label: "Off", selected: "bg-ink text-paper" },
];

export function PermissionSegmented({
  value,
  onChange,
  label,
  disabled,
  className,
}: {
  value: Permission;
  onChange?: (v: Permission) => void;
  /** Accessible name, e.g. "Email permission". */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const idx = PERMISSION_OPTIONS.findIndex((o) => o.value === value);
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!onChange || disabled) return;
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (idx + delta + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length;
    onChange(PERMISSION_OPTIONS[next]!.value);
    refs.current[next]?.focus();
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-full bg-canvas p-1", disabled && "opacity-60", className)}
    >
      {PERMISSION_OPTIONS.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange?.(o.value)}
            className={cn(
              "h-8 rounded-full px-3 text-sm font-semibold whitespace-nowrap transition-[background-color,color] duration-150",
              on ? o.selected : "text-ink hover:bg-hover",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled,
  className,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  /** Accessible name when no visible label is linked via labelledBy. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        "relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full transition-[background-color] duration-150 disabled:opacity-50",
        checked ? "bg-ink" : "bg-disabled-fg",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-[3px] left-[3px] size-5 rounded-full bg-paper transition-transform duration-150 ease-aos",
          checked && "translate-x-[18px]",
        )}
      />
    </button>
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  className,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-4 px-4 py-3", className)}>
      <div className="min-w-0 flex-1">
        <p id={`${id}-l`} className="text-md leading-5 font-semibold text-ink">
          {title}
        </p>
        {description ? (
          <p id={`${id}-d`} className="text-xs text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        labelledBy={`${id}-l`}
        describedBy={description ? `${id}-d` : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export function Field({
  label,
  helper,
  error,
  leading,
  trailing,
  className,
  inputClassName,
  ...input
}: {
  label: string;
  helper?: string;
  error?: string | null;
  /** Icon or prefix inside the field ("$", a clock icon). */
  leading?: ReactNode;
  /** Suffix inside the field ("USD"). */
  trailing?: ReactNode;
  className?: string;
  inputClassName?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">) {
  const id = useId();
  const msgId = `${id}-msg`;
  const invalid = !!error;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="text-md font-semibold text-ink">
        {label}
      </label>
      <div
        className={cn(
          "flex h-control items-center gap-2.5 rounded-md border-[1.5px] bg-paper px-3.5 transition-[border-color,box-shadow] duration-150",
          invalid
            ? "border-failed focus-within:shadow-[0_0_0_3px_var(--aos-failed-tint)]"
            : "border-control focus-within:border-focus focus-within:shadow-[0_0_0_3px_var(--aos-focus-halo)]",
        )}
      >
        {leading ? <span className="flex shrink-0 items-center text-muted">{leading}</span> : null}
        <input
          id={id}
          data-focus-ring="container"
          aria-invalid={invalid || undefined}
          aria-describedby={helper || error ? msgId : undefined}
          className={cn("h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-subtle", inputClassName)}
          {...input}
        />
        {trailing ? <span className="shrink-0 text-sm font-semibold text-muted">{trailing}</span> : null}
      </div>
      {error ? (
        <p id={msgId} className="flex items-center gap-2 text-sm font-semibold text-failed-text">
          <span aria-hidden className="size-2 shrink-0 bg-failed" />
          {error}
        </p>
      ) : helper ? (
        <p id={msgId} className="text-sm text-muted">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
