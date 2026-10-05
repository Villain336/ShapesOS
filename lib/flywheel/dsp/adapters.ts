// Marketr — Phase 7 F5: DSP plug-in adapter registry.
//
// Four adapters (TTD, DV360, Amazon, Basis). v1 ships the interface + the
// seat-guard machinery, not live API integrations: every adapter throws
// SeatNotConnectedError unless a seat is connected, and seat connection
// requires the agency's own credentials via a vault config_ref. No seat in v1
// means every adapter fails closed — that is the design, not a gap.

import {
  DspAdapter,
  DspKind,
  DspOpResult,
  DspReportResult,
  DSP_KINDS,
  SeatNotConnectedError,
  SeatStatus,
} from "./types";

export interface DspAdapterRecord {
  id: string;
  workspaceId: string;
  dsp: DspKind;
  seatStatus: SeatStatus;
  /** Vault ref only — never credential material (zero custody). */
  configRef: string | null;
  connectedAt: Date | null;
  connectedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A connected-seat adapter delegates to the platform; a seat-less one
 *  fails closed on every mutating op. Live API wiring is Phase 8+ work. */
export class BaseDspAdapter implements DspAdapter {
  readonly kind: DspKind;
  seatStatus: SeatStatus;

  constructor(kind: DspKind, seatStatus: SeatStatus = "none") {
    this.kind = kind;
    this.seatStatus = seatStatus;
  }

  private guard(): void {
    if (this.seatStatus !== "connected") {
      throw new SeatNotConnectedError(this.kind);
    }
  }

  async pause(opts: { platformRef: string; reason: string; actor: string }): Promise<DspOpResult> {
    this.guard();
    void opts;
    // Real pause call targets are provisioned by the kill-switch mapping
    // (lib/flywheel/dsp/killswitch.ts); the HTTP/API wiring ships when the
    // agency connects a seat.
    return {
      executed: false,
      platformRef: opts.platformRef,
      outcome: "not_supported",
      detail: `Seat connected but ${this.kind} API wiring is not provisioned yet (Phase 8+). No pause was attempted.`,
    };
  }

  async setCap(opts: { platformRef: string; capCents: number; approvalId: string }): Promise<DspOpResult> {
    this.guard();
    void opts;
    return {
      executed: false,
      platformRef: opts.platformRef,
      outcome: "not_supported",
      detail: `Seat connected but ${this.kind} API wiring is not provisioned yet (Phase 8+). No cap was set.`,
    };
  }

  async report(opts: { platformRef: string }): Promise<DspReportResult> {
    this.guard();
    return {
      platformRef: opts.platformRef,
      spendCents: 0,
      impressions: 0,
      capCents: null,
      currency: "USD",
    };
  }
}

/** Build the adapter for a record. Seat-less → the same adapter fails closed. */
export function adapterFor(record: DspAdapterRecord): DspAdapter {
  return new BaseDspAdapter(record.dsp, record.seatStatus);
}

export interface DspAdapterStore {
  upsert(workspaceId: string, dsp: DspKind): Promise<DspAdapterRecord>;
  get(workspaceId: string, dsp: DspKind): Promise<DspAdapterRecord | null>;
  list(workspaceId: string): Promise<DspAdapterRecord[]>;
  connect(workspaceId: string, dsp: DspKind, configRef: string, actor: string): Promise<DspAdapterRecord>;
  disconnect(workspaceId: string, dsp: DspKind, actor: string): Promise<DspAdapterRecord>;
}

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** Default: every DSP starts with NO seat (fail closed out of the box). */
export function seedAdapters(workspaceId: string): Array<{ dsp: DspKind; seatStatus: SeatStatus }> {
  return DSP_KINDS.map((dsp) => ({ dsp, seatStatus: "none" as SeatStatus }));
}

export function createMemoryDspAdapterStore(): DspAdapterStore {
  const rows = new Map<string, DspAdapterRecord>();
  const now = () => new Date();
  return {
    async upsert(workspaceId, dsp) {
      const key = `${workspaceId}:${dsp}`;
      const existing = rows.get(key);
      if (existing) return { ...existing };
      const row: DspAdapterRecord = {
        id: uid("dspad"), workspaceId, dsp, seatStatus: "none",
        configRef: null, connectedAt: null, connectedBy: null,
        createdAt: now(), updatedAt: now(),
      };
      rows.set(key, row);
      return { ...row };
    },
    async get(workspaceId, dsp) {
      const r = rows.get(`${workspaceId}:${dsp}`);
      return r ? { ...r } : null;
    },
    async list(workspaceId) {
      return [...rows.values()].filter((r) => r.workspaceId === workspaceId).map((r) => ({ ...r }));
    },
    async connect(workspaceId, dsp, configRef, actor) {
      if (!configRef || !configRef.startsWith("vault://")) {
        // Zero-custody: seats connect ONLY through a vault reference. Inline
        // credentials (or a missing ref) fail closed — Marketr never receives
        // raw seat credentials.
        throw new Error(
          `Refusing ${dsp} seat connection without a vault config ref. ` +
            `Bring your own seat: store credentials in the vault and connect with ` +
            `config_ref "vault://...". ShapesOS never accepts raw credentials.`,
        );
      }
      const key = `${workspaceId}:${dsp}`;
      const base = rows.get(key) ?? (await this.upsert(workspaceId, dsp));
      const row: DspAdapterRecord = {
        ...base, seatStatus: "connected", configRef, connectedAt: now(), connectedBy: actor, updatedAt: now(),
      };
      rows.set(key, row);
      return { ...row };
    },
    async disconnect(workspaceId, dsp, actor) {
      void actor;
      const key = `${workspaceId}:${dsp}`;
      const base = rows.get(key);
      if (!base) throw new Error(`DSP adapter not found: ${dsp}.`);
      const row: DspAdapterRecord = {
        ...base, seatStatus: "none", configRef: null, connectedAt: null, connectedBy: null, updatedAt: now(),
      };
      rows.set(key, row);
      return { ...row };
    },
  };
}
