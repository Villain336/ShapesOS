"use client";

// ShapesOS — Phase 9 (apps): a form rendered from an entity's fields.
// Typed inputs per field type; values are converted to what the server
// validates (money → cents, bool → boolean, empty → null clears). The
// server re-validates everything (lib/apps/records.ts) — this form only
// keeps people from typing what would be refused.

import { useId, useState } from "react";
import { Paperclip } from "lucide-react";
import { Switch, aosButton } from "@/components/aos";
import type { FieldSpec } from "@/lib/apps/spec";
import { parseMoneyInput, validateFieldValue } from "@/lib/apps/records";
import { ErrorLine, inputCls, textareaCls } from "./kit";

export type RelationOptions = Record<string, Array<{ id: string; title: string }>>;

function toInput(field: FieldSpec, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (field.type === "money" && typeof v === "number") return (v / 100).toFixed(2);
  if (field.type === "bool") return v === true ? "true" : "false";
  return String(v);
}

export function RecordForm({
  fields,
  initial,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
  relationOptions,
  fileNames,
  upload,
}: {
  fields: FieldSpec[];
  initial?: Record<string, unknown>;
  submitLabel: string;
  busyLabel: string;
  /** Resolves with field errors from the server (or nothing on success). */
  onSubmit: (data: Record<string, unknown>) => Promise<Record<string, string> | void>;
  onCancel?: () => void;
  relationOptions: RelationOptions;
  fileNames: Record<string, string>;
  upload: (file: File) => Promise<{ id: string; filename: string }>;
}) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, toInput(f, initial?.[f.key])])),
  );
  const [names, setNames] = useState<Record<string, string>>(fileNames);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  function collect(): { data: Record<string, unknown>; errors: Record<string, string> } {
    const data: Record<string, unknown> = {};
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const raw = values[f.key] ?? "";
      let v: unknown = raw === "" ? null : raw;
      if (f.type === "money" && raw !== "") {
        const cents = parseMoneyInput(raw);
        if (cents === null) {
          errs[f.key] = `${f.label} must be an amount like 12.50`;
          continue;
        }
        v = cents;
      }
      if (f.type === "bool") v = raw === "true";
      if (f.type === "number" && raw !== "") v = Number(raw);
      if (v === null && f.required) {
        errs[f.key] = `${f.label} is required`;
        continue;
      }
      const check = validateFieldValue(f, v);
      if (!check.ok) errs[f.key] = `${f.label} ${check.error}`;
      data[f.key] = v;
    }
    return { data, errors: errs };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { data, errors: errs } = collect();
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const serverErrors = await onSubmit(data);
      if (serverErrors) setErrors(serverErrors);
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(f: FieldSpec, file: File | undefined) {
    if (!file) return;
    setUploading(f.key);
    try {
      const up = await upload(file);
      set(f.key, up.id);
      setNames((n) => ({ ...n, [up.id]: up.filename }));
      setErrors(({ [f.key]: _drop, ...rest }) => rest);
    } catch (err) {
      setErrors((s) => ({ ...s, [f.key]: err instanceof Error ? err.message : "Upload failed" }));
    } finally {
      setUploading(null);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {fields.map((f) => {
        const id = `${formId}-${f.key}`;
        const msgId = `${id}-msg`;
        const err = errors[f.key];
        const common = { id, "aria-invalid": err ? true : undefined, "aria-describedby": err || f.help ? msgId : undefined } as const;
        const value = values[f.key] ?? "";
        let input: React.ReactNode;
        switch (f.type) {
          case "text":
            input =
              f.format === "multiline" ? (
                <textarea {...common} rows={4} className={textareaCls} value={value} maxLength={f.maxLength} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input
                  {...common}
                  className={inputCls}
                  type={f.format === "email" ? "email" : f.format === "url" ? "url" : "text"}
                  value={value}
                  maxLength={f.maxLength}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              );
            break;
          case "number":
            input = <input {...common} className={inputCls} type="number" inputMode="decimal" value={value} min={f.min} max={f.max} onChange={(e) => set(f.key, e.target.value)} />;
            break;
          case "money":
            input = (
              <div className="relative">
                <span aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-md text-muted">
                  {f.currency && f.currency !== "USD" ? f.currency : "$"}
                </span>
                <input {...common} className={`${inputCls} pl-9 tabular-nums`} inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => set(f.key, e.target.value)} />
              </div>
            );
            break;
          case "date":
            input = <input {...common} className={inputCls} type="date" value={value} onChange={(e) => set(f.key, e.target.value)} />;
            break;
          case "bool":
            input = (
              <div className="flex h-control items-center">
                <Switch checked={value === "true"} onChange={(on) => set(f.key, on ? "true" : "false")} labelledBy={`${id}-label`} />
              </div>
            );
            break;
          case "select":
            input = (
              <select {...common} className={inputCls} value={value} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">{f.required ? "Choose…" : "None"}</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            );
            break;
          case "relation": {
            const opts = relationOptions[f.target ?? ""] ?? [];
            input = (
              <select {...common} className={inputCls} value={value} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">{f.required ? "Choose…" : "None"}</option>
                {value && !opts.some((o) => o.id === value) ? <option value={value}>{value}</option> : null}
                {opts.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            );
            break;
          }
          case "file":
            input = (
              <div className="flex flex-wrap items-center gap-3">
                <label className={aosButton({ variant: "secondary", size: "sm", className: "cursor-pointer" })}>
                  <Paperclip size={15} aria-hidden />
                  {uploading === f.key ? "Uploading" : value ? "Replace file" : "Upload file"}
                  <input id={id} type="file" className="sr-only" onChange={(e) => pickFile(f, e.target.files?.[0])} disabled={uploading !== null} />
                </label>
                {value ? (
                  <>
                    <span className="truncate text-md text-ink">{names[value] ?? value}</span>
                    <button type="button" className="text-sm font-semibold text-muted underline-offset-4 hover:underline" onClick={() => set(f.key, "")}>
                      Remove
                    </button>
                  </>
                ) : null}
              </div>
            );
            break;
        }
        return (
          <div key={f.key} className="flex flex-col gap-2">
            <label id={`${id}-label`} htmlFor={id} className="text-md font-semibold text-ink">
              {f.label}
              {f.required ? <span className="text-muted"> (required)</span> : null}
            </label>
            {input}
            {err ? <ErrorLine id={msgId}>{err}</ErrorLine> : f.help ? <p id={msgId} className="text-sm text-muted">{f.help}</p> : null}
          </div>
        );
      })}
      {errors._ ? <ErrorLine>{errors._}</ErrorLine> : null}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        {onCancel ? (
          <button type="button" className={aosButton({ variant: "secondary" })} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className={aosButton({ variant: "primary" })} disabled={busy || uploading !== null}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
