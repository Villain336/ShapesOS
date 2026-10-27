// Shared workspace instructions editor (admins) / reader (everyone else).

"use client";

import { useCallback, useEffect, useState } from "react";

const MAX = 4000;
const cardCls = "rounded-xl border border-line bg-paper p-5";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";

interface Current { revision: number; body: string; updatedAt: string | null; updatedBy: string | null }
interface Rev { revision: number; body: string; createdAt: string; createdBy: string }

export default function InstructionsForm() {
  const [cur, setCur] = useState<Current | null>(null);
  const [revs, setRevs] = useState<Rev[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/instructions", { cache: "no-store" });
    if (!res.ok) {
      setMsg({ kind: "error", text: "Could not load the shared instructions." });
      return;
    }
    const j = await res.json();
    setCur(j.instructions);
    setRevs(j.revisions);
    setCanEdit(!!j.canEdit);
    setText(j.instructions.body);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!cur) return;
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings/instructions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text, expectedRevision: cur.revision }),
    });
    setBusy(false);
    if (res.ok) {
      setMsg({ kind: "ok", text: "Saved. New agent turns include this text." });
      await load();
    } else {
      const j = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: j.error ?? "Could not save." });
    }
  }

  if (!cur) return <p className="text-sm text-muted">Loading...</p>;
  const dirty = text.trim() !== cur.body.trim();

  return (
    <div className="flex flex-col gap-4" data-testid="instructions">
      <section className={cardCls}>
        <label htmlFor="shared-instructions" className="block text-md font-semibold text-ink">
          Instructions for agents
        </label>
        <p className="mt-1 text-sm text-muted">
          Agents are asked to follow this where it fits the request. It cannot make an agent skip an approval, spend money or share secrets, and an agent can still miss or ignore it.
        </p>
        <textarea
          id="shared-instructions"
          className="mt-3 min-h-[10rem] w-full rounded-md border-[1.5px] border-control bg-paper p-3 text-sm text-ink focus:border-focus focus:outline-none"
          value={text}
          readOnly={!canEdit}
          maxLength={MAX}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-between text-sm text-muted">
          <span>{text.length} / {MAX}</span>
          {canEdit ? (
            <button type="button" className={btnPrimary} disabled={busy || !dirty} onClick={save}>
              {busy ? "Saving..." : "Save"}
            </button>
          ) : (
            <span>Only admins can edit.</span>
          )}
        </div>
        {msg ? (
          <p role={msg.kind === "error" ? "alert" : "status"} className="mt-2 text-sm text-ink">{msg.text}</p>
        ) : null}
        <p className="mt-2 text-sm text-muted" data-testid="instructions-meta">
          {cur.revision === 0 ? "No instructions set." : `Revision ${cur.revision}, saved ${cur.updatedAt ? new Date(cur.updatedAt).toLocaleString() : ""} by ${cur.updatedBy ?? "an admin"}.`}
        </p>
      </section>
      {revs.length > 0 ? (
        <section className={cardCls}>
          <h2 className="text-md font-semibold text-ink">History</h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-muted">
            {revs.map((r) => (
              <li key={r.revision}>
                Revision {r.revision}, {new Date(r.createdAt).toLocaleString()}, {r.createdBy}
                {canEdit ? (
                  <button type="button" className="ml-2 underline" onClick={() => setText(r.body)}>
                    Load into editor
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
