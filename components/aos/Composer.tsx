"use client";

// ShapesOS — task composer (kit: command-and-inputs.png "Composer").
// Radius xl, raised. Top: the agent picker pill (monogram + name + chevron)
// and the duration hint. Then the multiline prompt (Field semantics: helper
// or error with the red square, aria-invalid + aria-describedby), file chips
// (mono name + size + remove), and the footer: attach, tool toggle chips
// (pressed = black) and the round black send button. Controlled and
// presentational; components/command-bar/NewTaskDialog.tsx wires it.

import { useId, useRef, type KeyboardEvent } from "react";
// Phase 19A (WS=server): kit primary actions are cursor targets (lib/cursor/registry.ts).
import { cursorTarget } from "@/lib/cursor/registry";
import { ArrowUp, Check, ChevronDown, FileText, Loader2, Paperclip, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/vault/shadcn/dropdown-menu";
import { AgentAvatar } from "./AgentAvatar";
import { ToolChip } from "./ToolChip";
import { FieldMessage } from "./Controls";

export interface ComposerAgentOption {
  key: string;
  name: string;
  hint: string;
}

export interface ComposerFile {
  id: string;
  name: string;
  /** Human size ("48 KB"). */
  size: string;
  uploading?: boolean;
}

export interface ComposerTool {
  key: string;
  label: string;
  pressed: boolean;
  /** Why the chip can't be picked for the chosen agent (disables it). */
  unavailable?: string | null;
}

export function TaskComposer({
  agents,
  agent,
  onAgentChange,
  hint,
  prompt,
  onPromptChange,
  placeholder = "Describe the goal. The agent plans it and asks before anything goes out.",
  helper,
  error,
  files = [],
  onAddFiles,
  onRemoveFile,
  tools = [],
  onToggleTool,
  onSend,
  sending,
  autoFocus,
  className,
}: {
  agents: readonly ComposerAgentOption[];
  agent: string;
  onAgentChange?: (key: string) => void;
  /** "Usually takes 3–5 min". */
  hint?: string;
  prompt: string;
  onPromptChange?: (v: string) => void;
  placeholder?: string;
  helper?: string;
  error?: string | null;
  files?: readonly ComposerFile[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (id: string) => void;
  tools?: readonly ComposerTool[];
  onToggleTool?: (key: string) => void;
  onSend?: () => void;
  sending?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const id = useId();
  const msgId = `${id}-msg`;
  const fileRef = useRef<HTMLInputElement>(null);
  const current = agents.find((a) => a.key === agent) ?? agents[0];
  const lead = agents[0];
  const subs = agents.slice(1);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // ⌘↵ / Ctrl+↵ sends; plain Enter is a new line (multiline prompt).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!sending) onSend?.();
    }
  }

  return (
    <div
      className={cn(
        "rounded-xl bg-paper p-3.5 shadow-raised sm:p-4 transition-[box-shadow] duration-150 has-[textarea:focus-visible]:shadow-[0_0_0_3px_var(--aos-focus-halo),var(--aos-shadow-raised)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Agent: ${current?.name ?? ""}. Change agent`}
            className="aos-press inline-flex h-9 max-w-[70%] items-center gap-2 rounded-full bg-canvas pr-3 pl-1.5 text-sm font-semibold text-ink hover:bg-hover"
          >
            <AgentAvatar name={current?.name ?? "?"} size="sm" className="rounded-full" />
            <span className="truncate">{current?.name}</span>
            <ChevronDown className="size-4 shrink-0" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="w-80 rounded-lg bg-paper p-1.5 text-ink shadow-raised ring-0">
            {lead ? (
              <DropdownMenuGroup aria-label="Lead agent">
                <DropdownMenuLabel className="px-3 pt-2 pb-1 text-xs font-semibold text-muted">Lead agent</DropdownMenuLabel>
                <AgentItem option={lead} selected={lead.key === agent} onPick={onAgentChange} />
              </DropdownMenuGroup>
            ) : null}
            {subs.length ? (
              <>
                <DropdownMenuSeparator className="mx-2 my-1.5 bg-line" />
                <DropdownMenuGroup aria-label="Sub-agents">
                  <DropdownMenuLabel className="px-3 pt-1 pb-1 text-xs font-semibold text-muted">Hand straight to a sub-agent</DropdownMenuLabel>
                  {subs.map((o) => (
                    <AgentItem key={o.key} option={o} selected={o.key === agent} onPick={onAgentChange} />
                  ))}
                </DropdownMenuGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {hint ? <span className="shrink-0 text-xs text-muted">{hint}</span> : null}
      </div>

      <label htmlFor={`${id}-prompt`} className="sr-only">
        Task for {current?.name}
      </label>
      <textarea
        id={`${id}-prompt`}
        value={prompt}
        onChange={(e) => onPromptChange?.(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        rows={3}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || helper ? msgId : undefined}
        className={cn(
          "-mx-2 mt-2 block max-h-64 min-h-20 w-[calc(100%+1rem)] resize-none rounded-md bg-transparent px-2 py-1.5 text-base leading-6 text-ink outline-none placeholder:text-subtle",
          error && "shadow-[0_0_0_1.5px_var(--aos-failed)]",
        )}
        data-focus-ring="container"
      />
      <FieldMessage id={msgId} helper={helper} error={error} className="mt-1" />

      {files.length ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Attached files">
          {files.map((f) => (
            <li key={f.id} className="inline-flex h-9 max-w-full items-center gap-2 rounded-md bg-canvas pr-1.5 pl-3 text-sm text-ink">
              {f.uploading ? <Loader2 className="size-4 shrink-0 aos-spin text-muted" aria-hidden /> : <FileText className="size-4 shrink-0" aria-hidden />}
              <span className="aos-mono min-w-0 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted">{f.uploading ? "Uploading" : f.size}</span>
              {onRemoveFile ? (
                <button
                  type="button"
                  onClick={() => onRemoveFile(f.id)}
                  aria-label={`Remove ${f.name}`}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3 sm:gap-2">
        {onAddFiles ? (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label="Attach a file"
              title="Attach a file"
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink hover:bg-hover-paper"
            >
              <Paperclip className="size-4" aria-hidden />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const list = e.target.files ? Array.from(e.target.files) : [];
                if (list.length) onAddFiles(list);
                e.target.value = "";
              }}
            />
          </>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 sm:gap-2" role="group" aria-label="Tools for this task">
          {tools.map((t) => (
            <ToolChip
              key={t.key}
              name={t.label}
              pressed={t.pressed && !t.unavailable}
              disabled={!!t.unavailable}
              title={t.unavailable ?? undefined}
              onClick={() => onToggleTool?.(t.key)}
              className="max-sm:gap-1 max-sm:px-2.5"
            />
          ))}
        </div>
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          aria-label={sending ? "Sending" : `Send to ${current?.name ?? "the agent"}`}
          title="Send (⌘↵)"
          {...cursorTarget("kit:composer:send", `Send to ${current?.name ?? "the agent"}`)}
          className="aos-press flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-paper hover:bg-ink-hover disabled:bg-disabled disabled:text-disabled-fg"
        >
          {sending ? <Loader2 className="size-5 aos-spin" aria-hidden /> : <ArrowUp className="size-5" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

function AgentItem({
  option,
  selected,
  onPick,
}: {
  option: ComposerAgentOption;
  selected: boolean;
  onPick?: (key: string) => void;
}) {
  return (
    <DropdownMenuItem
      className="min-h-12 gap-3 rounded-sm px-3 py-1.5 text-base data-highlighted:bg-hover-paper"
      onClick={() => onPick?.(option.key)}
    >
      <AgentAvatar name={option.name} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-ink">{option.name}</span>
        <span className="block truncate text-xs text-muted">{option.hint}</span>
      </span>
      {selected ? <Check className="size-4 shrink-0" aria-label="Selected" /> : null}
    </DropdownMenuItem>
  );
}
