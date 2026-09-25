// Marketr — A1 AEO command center (client actions).
// Approve buttons for action plans, prompt-set activation/creation, and the
// weekly run trigger. All writes go through the authority API; nothing
// publishes without human approval (the Phase 6 exit gate).

"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import { Textarea } from "@/components/vault/shadcn/textarea";
import { CheckCircle2, Play, RefreshCw } from "lucide-react";

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
    if (!window.confirm("Approve this action? Approval never publishes by itself — fixes enter the supervised ladder, third-party plans are commitments for you to execute.")) return;
    const data = (await post(`/api/authority/aeo/actions/${id}/approve`)) as {
      action?: { status?: string };
    } | null;
    if (data) setResult(`Approved (status: ${data.action?.status ?? "approved"}).`);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" onClick={act} disabled={busy}>
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
        {busy ? "Approving…" : "Approve"}
      </Button>
      {result && <span className="text-xs text-emerald-700">{result}</span>}
      {error && <span className="text-xs text-red-700">Error: {error}</span>}
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
      <Button type="button" size="sm" variant="outline" onClick={act} disabled={busy}>
        <Play className="mr-1 h-3.5 w-3.5" />
        {busy ? "Activating…" : "Activate"}
      </Button>
      {result && <span className="text-xs text-emerald-700">{result}</span>}
      {error && <span className="text-xs text-red-700">Error: {error}</span>}
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
        <Label htmlFor="aeo-prompts">Prompts (one per line, 20–50 money prompts)</Label>
        <Textarea
          id="aeo-prompts"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={"Best CRM for a 10-person agency\nAgency accounting software vs QuickBooks\n…"}
          className="mt-1 font-mono text-xs"
        />
      </div>
      <div className="flex items-center justify-between">
        <p className={`text-xs ${countOk ? "text-stone-600" : "text-amber-700"}`}>
          {count} prompt{count === 1 ? "" : "s"} — {countOk ? "within the 20–50 range" : "needs 20–50 to save"}
        </p>
        <Button type="submit" size="sm" disabled={busy || !countOk}>
          {busy ? "Saving…" : "Create prompt set"}
        </Button>
      </div>
      {result && <p className="text-xs text-emerald-700">{result}</p>}
      {error && <p className="text-xs text-red-700">Error: {error}</p>}
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
          <Label htmlFor="aeo-brand">Brand (for entity matching)</Label>
          <Input
            id="aeo-brand"
            value={brandInput}
            onChange={(e) => setBrandInput(e.target.value)}
            placeholder="Acme Studio"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="aeo-domain">Owned domain (optional)</Label>
          <Input
            id="aeo-domain"
            value={ownedDomain}
            onChange={(e) => setOwnedDomain(e.target.value)}
            placeholder="acme.com"
            className="mt-1"
          />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-stone-500">
          Weekly cadence is the default (daily available at ~4.3× cost). Cost envelope: ~$1–5/mo per brand.
        </p>
        <Button type="submit" size="sm" disabled={busy || !hasActiveSet || !brandInput.trim()}>
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Starting…" : "Run now"}
        </Button>
      </div>
      {!hasActiveSet && (
        <p className="text-xs text-amber-700">No active prompt set — activate one above before running.</p>
      )}
      {result && <p className="text-xs text-emerald-700">{result}</p>}
      {error && <p className="text-xs text-red-700">Error: {error}</p>}
    </form>
  );
}
