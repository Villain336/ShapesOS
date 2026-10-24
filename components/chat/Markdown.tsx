"use client";

// ShapesOS — Phase 22 (chat): the transcript's markdown renderer.
// React elements from lib/chat/markdown.ts' tree: no dangerouslySetInnerHTML,
// so raw HTML in a model's text is text. Code blocks get a Copy button;
// links keep safe schemes only (safeHref) and in-app paths stay in the app.

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { parseMarkdown, type MdBlock, type MdInline } from "@/lib/chat/markdown";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/I18nProvider";

function InlineText({ nodes }: { nodes: readonly MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <span key={i}>{n.v}</span>;
          case "br":
            return <br key={i} />;
          case "code":
            return (
              <code key={i} className="aos-mono rounded-key bg-inset px-1 py-0.5 text-[0.8125rem] text-ink">
                {n.v}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-ink">
                <InlineText nodes={n.c} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <InlineText nodes={n.c} />
              </em>
            );
          case "link": {
            const cls = "font-semibold text-ink underline underline-offset-4 hover:text-running";
            if (n.href.startsWith("/")) {
              return (
                <Link key={i} href={n.href} className={cls}>
                  <InlineText nodes={n.c} />
                </Link>
              );
            }
            return (
              <a key={i} href={n.href} className={cls} target="_blank" rel="noopener noreferrer">
                <InlineText nodes={n.c} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

export function CodeBlock({ code, lang, className }: { code: string; lang?: string | null; className?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("aos-night relative overflow-hidden rounded-md", className)}>
      <div className="flex h-8 items-center justify-between gap-2 border-b border-night-border px-3 text-xs text-night-muted">
        <span className="aos-mono">{lang || "text"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-semibold text-paper hover:bg-night-hover"
          aria-label={copied ? t("chat.tool.copied") : t("chat.tool.copy")}
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? t("chat.tool.copied") : t("chat.tool.copy")}
        </button>
      </div>
      <pre className="aos-mono overflow-x-auto px-3 py-2.5 text-[0.8125rem] leading-6 text-paper">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Block({ b }: { b: MdBlock }) {
  switch (b.t) {
    case "p":
      return (
        <p className="my-2 first:mt-0 last:mb-0">
          <InlineText nodes={b.c} />
        </p>
      );
    case "h": {
      const Tag = (`h${Math.min(6, b.level + 2)}` as "h3" | "h4" | "h5" | "h6");
      return (
        <Tag className={cn("mt-4 mb-1.5 font-bold stretch-heading tracking-heading text-ink first:mt-0", b.level <= 2 ? "text-lg" : "text-base")}>
          <InlineText nodes={b.c} />
        </Tag>
      );
    }
    case "ul":
      return (
        <ul className={cn("my-2 pl-5", b.checks ? "list-none pl-0" : "list-disc")}>
          {b.items.map((it, i) => (
            <li key={i} className="my-0.5 flex gap-2">
              {b.checks ? (
                <input type="checkbox" checked={b.checks[i] === true} readOnly aria-label={b.checks[i] ? "Done" : "To do"} className="mt-1.5 size-3.5 shrink-0 accent-ink" />
              ) : null}
              <div className="min-w-0 flex-1">
                <Blocks blocks={it} />
              </div>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="my-2 list-decimal pl-5" start={b.start}>
          {b.items.map((it, i) => (
            <li key={i} className="my-0.5">
              <Blocks blocks={it} />
            </li>
          ))}
        </ol>
      );
    case "code":
      return <CodeBlock code={b.v} lang={b.lang} className="my-2" />;
    case "quote":
      return (
        <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-muted">
          <Blocks blocks={b.c} />
        </blockquote>
      );
    case "table":
      return (
        <div className="my-2 overflow-x-auto rounded-md shadow-hairline">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                {b.head.map((c, i) => (
                  <th key={i} className={cn("px-3 py-2 font-medium", b.align[i] === "right" && "text-right", b.align[i] === "center" && "text-center")}>
                    <InlineText nodes={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  {r.map((c, i) => (
                    <td key={i} className={cn("px-3 py-2 align-top", b.align[i] === "right" && "text-right tabular-nums", b.align[i] === "center" && "text-center")}>
                      <InlineText nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr className="my-3 border-line" />;
  }
}

function Blocks({ blocks }: { blocks: readonly MdBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
    </>
  );
}

/** Markdown text as React elements (safe by construction). */
export function Markdown({ text, className, children }: { text: string; className?: string; children?: ReactNode }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={cn("text-md leading-relaxed text-ink break-words", className)}>
      <Blocks blocks={blocks} />
      {children}
    </div>
  );
}

export default Markdown;
