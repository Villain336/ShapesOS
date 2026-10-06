"use client";

// Marketr — new-project form (dashboard).

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { Field } from "@/components/vault/Field";
import { Button } from "@/components/vault/atoms/Button";
import { Input } from "@/components/vault/shadcn/input";
// Phase 18.1 (integration): on Home (the Projects widget) in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";

export default function ProjectCreateForm() {
  const router = useRouter();
  const { t } = useI18n();
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? t("kit.projectForm.failed"));
        return;
      }
      setDomain("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={t("kit.projectForm.title")}
        description={t("kit.projectForm.description")}
      />
      <CardBody>
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <Field
            label={t("kit.projectForm.domain")}
            htmlFor="domain"
            error={error ?? undefined}
            className="flex-1"
          >
            <Input
              id="domain"
              required
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="accent" size="md" disabled={busy}>
            {busy ? t("kit.projectForm.adding") : t("kit.projectForm.add")}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
