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
  options,
  locked,
  className,
}: {
  value: Permission;
  onChange?: (v: Permission) => void;
  /** Accessible name, e.g. "Email permission". */
  label: string;
  disabled?: boolean;
  /**
   * The choices the underlying setting supports, in kit order (default: all
   * three). A read-only allow-list has no "Off", so it passes ["ask", "auto"].
   */
  options?: readonly Permission[];
  /** Choices shown but not selectable, with the reason (title + sr text). */
  locked?: Partial<Record<Permission, string>>;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = PERMISSION_OPTIONS.filter((o) => !options || options.includes(o.value));
  const selectable = shown.filter((o) => !locked?.[o.value]);
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!onChange || disabled) return;
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta || selectable.length === 0) return;
    e.preventDefault();
    const at = Math.max(0, selectable.findIndex((o) => o.value === value));
    const next = selectable[(at + delta + selectable.length) % selectable.length]!;
    onChange(next.value);
    refs.current[shown.indexOf(next)]?.focus();
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKey}
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-full bg-canvas p-1", disabled && "opacity-60", className)}
    >
      {shown.map((o, i) => {
        const on = o.value === value;
        const why = locked?.[o.value];
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={why ? true : undefined}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            title={why}
            onClick={() => {
              if (!why && !on) onChange?.(o.value);
            }}
            className={cn(
              "h-8 rounded-full px-3 text-sm font-semibold whitespace-nowrap transition-[background-color,color] duration-150",
              on ? o.selected : why ? "cursor-not-allowed text-disabled-fg" : "text-ink hover:bg-hover",
            )}
          >
            {o.label}
            {why ? <span className="sr-only"> ({why})</span> : null}
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

/**
 * Helper or error line under a control. Errors carry the red square (shape +
 * color + text); pair it with aria-invalid + aria-describedby={id} on the
 * control it belongs to.
 */
export function FieldMessage({
  id,
  helper,
  error,
  className,
}: {
  id: string;
  helper?: ReactNode;
  error?: string | null;
  className?: string;
}) {
  if (error) {
    return (
      <p id={id} role="alert" className={cn("flex items-center gap-2 text-sm font-semibold text-failed-text", className)}>
        <span aria-hidden className="size-2 shrink-0 bg-failed" />
        {error}
      </p>
    );
  }
  if (helper) {
    return (
      <p id={id} className={cn("text-sm text-muted", className)}>
        {helper}
      </p>
    );
  }
  return null;
}

export function Field({
  label,
  helper,
  error,
  leading,
  trailing,
  hideLabel,
  className,
  inputClassName,
  ...input
}: {
  label: ReactNode;
  helper?: ReactNode;
  error?: string | null;
  /** Icon or prefix inside the field ("$", a clock icon). */
  leading?: ReactNode;
  /** Suffix inside the field ("USD"). */
  trailing?: ReactNode;
  /** Keep the label for screen readers only (a section heading already names the field). */
  hideLabel?: boolean;
  className?: string;
  inputClassName?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "id">) {
  const id = useId();
  const msgId = `${id}-msg`;
  const invalid = !!error;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className={cn("text-md font-semibold text-ink", hideLabel && "sr-only")}>
        {label}
      </label>
      <div
        className={cn(
          "flex h-control items-center gap-2.5 rounded-md border-[1.5px] bg-paper px-3.5 transition-[border-color,box-shadow] duration-150",
          invalid
            ? "border-failed focus-within:shadow-[0_0_0_3px_var(--aos-failed-tint)]"
            : "border-control focus-within:border-focus focus-within:shadow-[0_0_0_3px_var(--aos-focus-halo)]",
          input.disabled && "bg-canvas",
        )}
      >
        {leading ? <span className="flex shrink-0 items-center text-muted">{leading}</span> : null}
        <input
          id={id}
          data-focus-ring="container"
          aria-invalid={invalid || undefined}
          aria-describedby={helper || error ? msgId : undefined}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-subtle disabled:text-muted",
            inputClassName,
          )}
          {...input}
        />
        {trailing ? <span className="shrink-0 text-sm font-semibold text-muted">{trailing}</span> : null}
      </div>
      <FieldMessage id={msgId} helper={helper} error={error} />
    </div>
  );
}
