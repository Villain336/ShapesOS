// ShapesOS Desktop overlay: one per display, transparent and click-through.
// Draws the companion pointer, circles/arrows/step numbers, captions near
// the cursor, the capture indicator, and the proposal / dictation cards
// (the only clickable parts: hovering them turns click-through off).

import { Info, Mic, ScanEye } from "lucide-react";
import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactNode } from "react";
import type { OverlayCard, OverlayDictation, OverlayDrawing, OverlayState } from "../shared/ipc";
import { desktop } from "./bridge";

function Interactive({ children, className, style, label }: { children: ReactNode; className: string; style: React.CSSProperties; label: string }) {
  return (
    <section
      className={className}
      style={style}
      aria-label={label}
      onMouseEnter={() => desktop.send("overlay:interactive", true)}
      onMouseLeave={() => desktop.send("overlay:interactive", false)}
    >
      {children}
    </section>
  );
}

function Pointer({ p }: { p: NonNullable<OverlayState["pointer"]> }) {
  // The tip of the arrow is at (2, 2) in the SVG; offset so it lands on x, y.
  return (
    <div className="pointer" data-testid="pointer" data-x={Math.round(p.x)} data-y={Math.round(p.y)} style={{ transform: `translate(${p.x - 2}px, ${p.y - 2}px)` }}>
      <svg width="28" height="32" viewBox="0 0 28 32" aria-hidden="true">
        <path className="pointer-arrow" d="M2 2 L2 26 L8.5 20 L13 30 L17.5 28 L13 18.5 L22 18.5 Z" />
      </svg>
      {p.label ? <div className="pointer-label">{p.label}</div> : null}
    </div>
  );
}

function arrowHead(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = 16;
  const w = 0.5;
  const p1 = { x: b.x - len * Math.cos(ang - w), y: b.y - len * Math.sin(ang - w) };
  const p2 = { x: b.x - len * Math.cos(ang + w), y: b.y - len * Math.sin(ang + w) };
  return `M${b.x} ${b.y} L${p1.x} ${p1.y} L${p2.x} ${p2.y} Z`;
}

function Mark({ d }: { d: OverlayDrawing }) {
  const first = d.points[0]!;
  if (d.kind === "circle") {
    const r = d.points[1] ? Math.max(18, Math.hypot(d.points[1].x - first.x, d.points[1].y - first.y)) : 36;
    return (
      <g data-testid="mark-circle">
        <ellipse className="mark-under" cx={first.x} cy={first.y} rx={r * 1.15} ry={r} />
        <ellipse className="mark" cx={first.x} cy={first.y} rx={r * 1.15} ry={r} />
        {d.label ? <text className="mark-label" x={first.x + r * 1.15 + 8} y={first.y - r + 4}>{d.label}</text> : null}
      </g>
    );
  }
  if (d.kind === "arrow") {
    const path = d.points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
    const a = d.points[d.points.length - 2]!;
    const b = d.points[d.points.length - 1]!;
    return (
      <g data-testid="mark-arrow">
        <path className="mark-under" d={path} />
        <path className="mark" d={path} />
        <path className="mark-head" d={arrowHead(a, b)} />
        {d.label ? <text className="mark-label" x={first.x + 8} y={first.y - 8}>{d.label}</text> : null}
      </g>
    );
  }
  return (
    <g data-testid="mark-step">
      <circle className="step-dot" cx={first.x} cy={first.y} r={14} />
      <text className="step-num" x={first.x} y={first.y + 5} textAnchor="middle">{d.step ?? 1}</text>
      {d.label ? <text className="mark-label" x={first.x + 22} y={first.y + 5}>{d.label}</text> : null}
    </g>
  );
}

function Caption({ c }: { c: NonNullable<OverlayState["caption"]> }) {
  const icon =
    c.kind === "listening" ? <Mic size={16} aria-hidden="true" /> : c.kind === "notice" ? <Info size={16} aria-hidden="true" /> : null;
  return (
    <div className="caption" role="status" aria-live="polite" data-testid="caption" data-kind={c.kind} style={{ left: c.x, top: c.y }}>
      {c.kind === "error" ? <span className="aos-shape aos-shape--failed" role="img" aria-label="Failed" /> : icon}
      <span className="caption-text">{c.text}</span>
    </div>
  );
}

function ProposalCard({ c }: { c: OverlayCard }) {
  const done = c.status === "approved" || c.status === "rejected";
  return (
    <Interactive className="card" style={{ left: c.x, top: c.y }} label="Approval needed">
      <div data-testid="proposal" data-approval={c.approvalId} data-status={c.status} data-voice={String(c.voiceApprovable)}>
        <div className="card-head">
          <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Needs you" />
          <span>Approve</span>
          <span className="aos-mono">{c.tool}</span>
        </div>
        <p className="card-body">{c.summary}</p>
        <div className="card-meta">
          <span className="chip">{c.tierLabel}</span>
        </div>
        <div className={c.voiceApprovable ? "card-hint" : "card-hint card-hint--strong"} data-testid="proposal-hint">
          {c.hint}
        </div>
        {done ? (
          <div className="card-result">
            {c.status === "approved" ? (
              <span className="aos-shape aos-shape--done" role="img" aria-label="Done" />
            ) : (
              <span className="aos-shape aos-shape--queued" role="img" aria-label="Rejected" />
            )}
            {c.status === "approved" ? "Approved" : "Rejected"}
          </div>
        ) : (
          <div className="card-actions">
            <button
              type="button"
              className="btn btn-approve aos-press"
              data-testid="approve"
              disabled={c.status === "sending"}
              onClick={() => desktop.send("overlay:decide", { approvalId: c.approvalId, decision: "approve" })}
            >
              {c.status === "sending" ? "Approving" : "Approve"}
            </button>
            <button
              type="button"
              className="btn btn-deny aos-press"
              data-testid="reject"
              disabled={c.status === "sending"}
              onClick={() => desktop.send("overlay:decide", { approvalId: c.approvalId, decision: "reject" })}
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </Interactive>
  );
}

function DictationCard({ d }: { d: OverlayDictation }) {
  return (
    <Interactive className="card" style={{ left: d.x, top: d.y }} label="Dictation preview">
      <div data-testid="dictation" data-status={d.status}>
        <div className="card-head">Paste this where you're typing?</div>
        <div className="card-preview">{d.text}</div>
        {d.status === "preview" ? (
          <div className="card-actions">
            <button type="button" className="btn btn-primary aos-press" onClick={() => desktop.send("overlay:dictation", { action: "paste" })}>
              Paste
            </button>
            <button type="button" className="btn btn-secondary aos-press" onClick={() => desktop.send("overlay:dictation", { action: "cancel" })}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="card-result">{d.status === "pasting" ? "Pasting" : d.message}</div>
        )}
      </div>
    </Interactive>
  );
}

function Overlay() {
  const [s, setS] = useState<OverlayState | null>(null);
  useEffect(() => desktop.on("overlay:state", (p) => setS(p as OverlayState)), []);
  if (!s) return null;
  return (
    <div className="overlay-root" data-testid="overlay" data-display={s.displayId}>
      {s.drawings.length ? (
        <svg className="marks" aria-hidden="true">
          {s.drawings.map((d) => (
            <Mark key={d.id} d={d} />
          ))}
        </svg>
      ) : null}
      {s.pointer ? <Pointer key="pointer" p={s.pointer} /> : null}
      {s.capturing ? (
        <div className="capture-pill" role="status" data-testid="capture-indicator">
          <ScanEye size={16} aria-hidden="true" />
          Seeing your screen
        </div>
      ) : null}
      {s.caption ? <Caption c={s.caption} /> : null}
      {s.proposal ? <ProposalCard c={s.proposal} /> : null}
      {s.dictation ? <DictationCard d={s.dictation} /> : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Overlay />);
