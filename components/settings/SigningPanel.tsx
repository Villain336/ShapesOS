// Marketr — signing settings: Documenso signing requests UI (API-only).
// Create-from-template-PDF form + status table. Without a configured
// Documenso instance it renders an honest empty state with the
// docker-compose quick start — never fabricated documents.
// NOTE: no embedded signing UI by design (that needs Documenso's
// commercial license); signers use Documenso's own emailed link.

"use client";

import { useCallback, useEffect, useState } from "react";
import { PenLine, RefreshCw, TerminalSquare } from "lucide-react";

interface SigningRequest {
  id: string;
  title: string;
  templateName: string | null;
  documensoDocumentId: string | null;
  status: string;
  signers: Array<{ name: string; email: string }>;
  createdAt: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; requests: SigningRequest[] };

// Document statuses are workflow states, not agent states — neutral chip.
function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex whitespace-nowrap items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      {status}
    </span>
  );
}

export function SigningPanel({ configured }: { configured: boolean }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [title, setTitle] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [signersText, setSignersText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/documenso/requests");
      const json = (await res.json()) as {
        requests?: SigningRequest[];
        error?: string;
      };
      if (!res.ok) {
        setState({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({ kind: "ready", requests: json.requests ?? [] });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Request failed." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function parseSigners(): { ok: boolean; value: Array<{ name: string; email: string }>; error?: string } {
    const lines = signersText.split("\n").map((l) => l.trim()).filter(Boolean);
    const value: Array<{ name: string; email: string }> = [];
    for (const line of lines) {
      // "Name <email>" or bare "email"
      const m = /^(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>$/.exec(line);
      if (m) {
        value.push({ name: m[1]!.trim() || m[2]!, email: m[2]! });
      } else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(line)) {
        value.push({ name: line, email: line });
      } else {
        return { ok: false, value: [], error: `Could not parse signer line: "${line}"` };
      }
    }
    if (value.length === 0) return { ok: false, value: [], error: "Add at least one signer." };
    return { ok: true, value };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormOk(null);
    if (!file) {
      setFormError("Choose a template PDF first.");
      return;
    }
    if (!title.trim()) {
      setFormError("Give the document a title.");
      return;
    }
    const parsed = parseSigners();
    if (!parsed.ok) {
      setFormError(parsed.error ?? "Invalid signers.");
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("title", title.trim());
      if (templateName.trim()) form.append("templateName", templateName.trim());
      form.append("signers", JSON.stringify(parsed.value));
      form.append("file", file, file.name);
      const res = await fetch("/api/documenso/requests", { method: "POST", body: form });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setFormError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setFormOk("Signing request sent — signers get Documenso's own emailed link.");
      setTitle("");
      setTemplateName("");
      setSignersText("");
      setFile(null);
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function onRefresh(id: string) {
    setRefreshing(id);
    try {
      await fetch(`/api/documenso/requests/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      await load();
    } finally {
      setRefreshing(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!configured && (
        <div className="rounded-lg bg-paper p-5 shadow-hairline">
          <div className="flex items-center gap-2 text-ink">
            <PenLine className="h-5 w-5 text-muted" />
            <h2 className="aos-subheading">Documenso is not connected</h2>
          </div>
          <p className="mt-2 text-sm text-muted">
            Signing requests are API-only against an unmodified Documenso
            Community Edition instance (AGPL). Signers get Documenso&apos;s own
            emailed signing link — the white-labeled embedded signing UI is the
            paid Enterprise feature and is intentionally not offered here.
          </p>
          <div className="mt-3 rounded-md border border-line bg-canvas p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <TerminalSquare className="h-4 w-4" /> Quick start (self-host CE)
            </p>
            <p className="mt-2 text-xs text-muted">
              Run Documenso per its own docker guide, then set{" "}
              <code className="font-mono">DOCUMENSO_URL</code> and{" "}
              <code className="font-mono">DOCUMENSO_API_KEY</code> on the host
              (Settings → Providers shows the status).
            </p>
          </div>
        </div>
      )}

      <form
        onSubmit={onSubmit}
        className="rounded-lg bg-paper p-5 shadow-hairline"
      >
        <h2 className="aos-subheading">New signing request</h2>
        <p className="mt-0.5 text-sm text-muted">
          Upload a template PDF, add signers, send. API-only — no embedded
          signing UI.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="sr-title">
              Document title
            </label>
            <input
              id="sr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="MSA — Acme Corp"
              className="h-control-sm w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="sr-template">
              Template name (optional)
            </label>
            <input
              id="sr-template"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="msa-v3"
              className="h-control-sm w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="sr-file">
              Template PDF
            </label>
            <input
              id="sr-file"
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-muted file:h-control-sm file:rounded-md file:border-[1.5px] file:border-control file:bg-paper file:px-3 file:text-sm file:font-semibold file:text-ink"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="sr-signers">
              Signers (one per line: Name &lt;email&gt;)
            </label>
            <textarea
              id="sr-signers"
              value={signersText}
              onChange={(e) => setSignersText(e.target.value)}
              placeholder={"Jane Doe <jane@acme.com>\nbob@acme.com"}
              rows={3}
              className="h-auto w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none"
            />
          </div>
        </div>
        {formError && <div className="mb-4 mt-3 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"><span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" /><span>{formError}</span></div>}
        {formOk && <p className="mt-3 text-sm text-muted">{formOk}</p>}
        <button
          type="submit"
          disabled={submitting || !configured}
          className="mt-4 inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40"
        >
          {submitting ? "Sending…" : "Create & send signing request"}
        </button>
        {!configured && (
          <p className="mt-2 text-xs text-muted">
            Connect Documenso first — the form is disabled until then.
          </p>
        )}
      </form>

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th className="px-4 py-2.5">Title</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Signers</th>
              <th className="px-4 py-2.5">Created</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {state.kind === "loading" && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {state.kind === "error" && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-failed-text">
                  {state.message}
                </td>
              </tr>
            )}
            {state.kind === "ready" &&
              state.requests.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-ink">{r.title}</div>
                    {r.templateName && (
                      <div className="font-mono text-xs text-muted">{r.templateName}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {r.signers.map((s) => s.name).join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => void onRefresh(r.id)}
                      disabled={refreshing === r.id || !r.documensoDocumentId}
                      className="inline-flex items-center gap-1 rounded-full bg-paper px-3 py-1 text-xs font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshing === r.id ? "animate-spin" : ""}`} />
                      Refresh
                    </button>
                  </td>
                </tr>
              ))}
            {state.kind === "ready" && state.requests.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  No signing requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
