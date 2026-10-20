// Marketr — A1 AEO command center (client actions).
// Approve buttons for action plans, prompt-set activation/creation, and the
// weekly run trigger. All writes go through the authority API; nothing
// publishes without human approval (the Phase 6 exit gate).

"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import { Textarea } from "@/components/vault/shadcn/textarea";
import { CheckCircle2, Play, RefreshCw } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

// Agentic OS pressables: done = approve, running = run verbs.
const btnP =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
const btnD =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:bg-done/90 disabled:opacity-40";
const btnR =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white aos-press hover:bg-running/90 disabled:opacity-40";

function usePost() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, body?: unknown) {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      router.refresh();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { post, busy, result, setResult, error };
}

export function ApproveActionButton({ id }: { id: string }) {
  const { post, busy, result, setResult, error } = usePost();

  async function act() {
    if (!await confirmAction("Approve this action? Approval never publishes by itself — fixes enter the supervised ladder, third-party plans are commitments for you to execute.")) return;
    const data = (await post(`/api/authority/aeo/actions/${id}/approve`)) as {
      action?: { status?: string };
    } | null;
    if (data) setResult(`Approved (status: ${data.action?.status ?? "approved"}).`);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className={btnD} onClick={act} disabled={busy}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        {busy ? "Approving…" : "Approve"}
      </button>
      {result && <span className="text-xs text-muted">{result}</span>}
      {error && <span className="text-xs text-failed-text">Error: {error}</span>}
    </span>
  );
}

export function ActivatePromptSetButton({ id }: { id: string }) {
  const { post, busy, result, setResult, error } = usePost();

  async function act() {
    const data = (await post(`/api/authority/aeo/prompt-sets/${id}/activate`)) as {
      version?: number;
    } | null;
    if (data) setResult("Activated.");
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className={btnP} onClick={act} disabled={busy}>
        <Play className="h-3.5 w-3.5" />
        {busy ? "Activating…" : "Activate"}
      </button>
      {result && <span className="text-xs text-muted">{result}</span>}
      {error && <span className="text-xs text-failed-text">Error: {error}</span>}
    </span>
  );
}

export function CreatePromptSetForm() {
  const { post, busy, result, setResult, error } = usePost();
  const [text, setText] = useState("");

  const count = text.split("\n").map((l) => l.trim()).filter(Boolean).length;
  const countOk = count >= 20 && count <= 50;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const prompts = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const data = (await post("/api/authority/aeo/prompt-sets", { prompts })) as {
      version?: number;
      promptCount?: number;
    } | null;
    if (data) {
      setResult(`Saved as v${data.version} (${data.promptCount} prompts). Activate it above to use for runs.`);
      setText("");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label htmlFor="aeo-prompts" className="text-[0.8125rem] font-medium text-muted">Prompts (one per line, 20–50 money prompts)</Label>
        <Textarea
          id="aeo-prompts"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={"Best CRM for a 10-person agency\nAgency accounting software vs QuickBooks\n…"}
          className="mt-1 font-mono text-xs border-line bg-paper text-[0.8125rem] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]"
        />
      </div>
      <div className="flex items-center justify-between">
        <p className={`text-xs ${countOk ? "text-muted" : "text-ink"}`}>
          {count} prompt{count === 1 ? "" : "s"} — {countOk ? "within the 20–50 range" : "needs 20–50 to save"}
        </p>
        <button type="submit" className={btnP} disabled={busy || !countOk}>
          {busy ? "Saving…" : "Create prompt set"}
        </button>
      </div>
      {result && <p className="text-xs text-muted">{result}</p>}
      {error && <p className="text-xs text-failed-text">Error: {error}</p>}
    </form>
  );
}

export function TriggerRunCard({ hasActiveSet, brand }: { hasActiveSet: boolean; brand: string }) {
  const { post, busy, result, setResult, error } = usePost();
  const [brandInput, setBrandInput] = useState(brand);
  const [ownedDomain, setOwnedDomain] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!brandInput.trim()) {
      setResult(null);
      return;
    }
    const data = (await post("/api/authority/aeo/runs", {
      brand: brandInput.trim(),
      ownedDomain: ownedDomain.trim() || undefined,
    })) as { runs?: unknown[] } | null;
    if (data) {
      setResult(
        `Run queued (${Array.isArray(data.runs) ? data.runs.length : 0} engines). Results appear per-engine as the run completes.`,
      );
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="aeo-brand" className="text-[0.8125rem] font-medium text-muted">Brand (for entity matching)</Label>
          <Input
            id="aeo-brand"
            value={brandInput}
            onChange={(e) => setBrandInput(e.target.value)}
            placeholder="Acme Studio"
            className="mt-1 border-line bg-paper text-[0.8125rem] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]"
          />
        </div>
        <div>
          <Label htmlFor="aeo-domain" className="text-[0.8125rem] font-medium text-muted">Owned domain (optional)</Label>
          <Input
            id="aeo-domain"
            value={ownedDomain}
            onChange={(e) => setOwnedDomain(e.target.value)}
            placeholder="acme.com"
            className="mt-1 border-line bg-paper text-[0.8125rem] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]"
          />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
          Weekly cadence is the default (daily available at ~4.3× cost). Cost envelope: ~$1–5/mo per brand.
        </p>
        <button type="submit" className={btnR} disabled={busy || !hasActiveSet || !brandInput.trim()}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Starting…" : "Run now"}
        </button>
      </div>
      {!hasActiveSet && (
        <p className="text-xs text-ink">No active prompt set — activate one above before running.</p>
      )}
      {result && <p className="text-xs text-muted">{result}</p>}
      {error && <p className="text-xs text-failed-text">Error: {error}</p>}
    </form>
  );
}
