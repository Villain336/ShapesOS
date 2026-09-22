"use client";

// Marketr — project settings: General form (milestone 21, part D2).
// Edits brandContext + domains via PUT /api/projects/[projectId]/settings.
// A null brandContext means "inherited" (Marketr's default voice); empty
// domains means the project's own domain is the only one.

import { useState } from "react";
import { CheckCircle, Warning, X } from "@/components/vault/phosphor";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { Field } from "@/components/vault/Field";
import { Textarea } from "@/components/vault/shadcn/textarea";
import { Input } from "@/components/vault/shadcn/input";
import { buttonVariants } from "@/components/vault/atoms/button-variants";
import { cn } from "@/lib/utils";

type SaveState = "idle" | "saving" | "saved" | "error";

export default function GeneralForm({
  projectId,
  canEdit,
  initialBrandContext,
  initialDomains,
}: {
  projectId: string;
  canEdit: boolean;
  initialBrandContext: string | null;
  initialDomains: string[];
}) {
  const [brandContext, setBrandContext] = useState(initialBrandContext ?? "");
  const [domains, setDomains] = useState<string[]>(initialDomains);
  const [domainInput, setDomainInput] = useState("");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const brandDirty = brandContext !== (initialBrandContext ?? "");
  const domainsDirty =
    domains.length !== initialDomains.length ||
    domains.some((d, i) => d !== initialDomains[i]);
  const dirty = brandDirty || domainsDirty;

  const brandInherited = (initialBrandContext ?? "").trim() === "";

  async function save() {
    setState("saving");
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandContext: brandContext.trim() === "" ? null : brandContext,
          domains,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Save failed (${res.status})`);
      }
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  async function resetBrandContext() {
    setBrandContext("");
    await saveBrandOnly("");
  }

  async function saveBrandOnly(value: string) {
    setState("saving");
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandContext: value.trim() === "" ? null : value,
          domains,
        }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      setState("saved");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  function addDomain() {
    const d = domainInput.trim().toLowerCase();
    if (!d || domains.includes(d)) return;
    setDomains((prev) => [...prev, d]);
    setDomainInput("");
  }

  return (
    <Card>
      <CardHeader
        title="Brand & domains"
        description="Brand context is injected into Marketr's prompt for this project"
        actions={
          !brandInherited ? (
            <span className="rounded-full bg-accent-tint px-2 py-0.5 text-[11.5px] font-medium text-accent-ink">
              Overridden
            </span>
          ) : (
            <span className="rounded-full bg-inset px-2 py-0.5 text-[11.5px] text-ink-3">
              Inherited default
            </span>
          )
        }
      />
      <CardBody className="flex flex-col gap-4">
        <Field
          label="Brand context"
          hint="Voice, audience, positioning — Marketr reads this before every answer for this project."
          htmlFor="brand-context"
        >
          <Textarea
            id="brand-context"
            value={brandContext}
            onChange={(e) => setBrandContext(e.target.value)}
            disabled={!canEdit}
            rows={4}
            placeholder="e.g. Playful but precise. Audience: first-time founders. Never mention competitors by name."
            className="resize-y"
          />
        </Field>
        {!brandInherited && canEdit && (
          <button
            type="button"
            onClick={() => void resetBrandContext()}
            className="self-start text-[12.5px] text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink"
          >
            Reset to inherited default
          </button>
        )}

        <Field
          label="Extra domains"
          hint="Beyond the project domain — used for tracking and publishing."
          htmlFor="domain-input"
        >
          <div className="flex flex-col gap-2">
            {domains.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {domains.map((d) => (
                  <span
                    key={d}
                    className="inline-flex items-center gap-1.5 rounded-full bg-inset py-1 pl-3 pr-1.5 text-[12.5px] text-ink"
                  >
                    {d}
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={`Remove ${d}`}
                        onClick={() =>
                          setDomains((prev) => prev.filter((x) => x !== d))
                        }
                        className="flex size-5 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-line hover:text-ink"
                      >
                        <X className="size-3" weight="bold" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {canEdit && (
              <div className="flex gap-2">
                <Input
                  id="domain-input"
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addDomain();
                    }
                  }}
                  placeholder="blog.example.com"
                />
                <button
                  type="button"
                  onClick={addDomain}
                  className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
                >
                  Add
                </button>
              </div>
            )}
          </div>
        </Field>

        {state === "error" && error && (
          <p className="flex items-center gap-1.5 text-[12.5px] text-red">
            <Warning className="size-3.5" />
            {error}
          </p>
        )}
        {state === "saved" && (
          <p className="flex items-center gap-1.5 text-[12.5px] text-green">
            <CheckCircle className="size-3.5" weight="duotone" />
            Saved
          </p>
        )}

        {canEdit && (
          <div>
            <button
              type="button"
              disabled={!dirty || state === "saving"}
              onClick={() => void save()}
              className={cn(buttonVariants({ variant: "accent", size: "sm" }))}
            >
              {state === "saving" ? "Saving…" : "Save changes"}
            </button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
