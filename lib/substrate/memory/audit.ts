// Marketr — Growth Memory audit log (Phase 8 G3).
//
// Process-local, structured, exportable. (The Phase-7-wide persistent audit
// store is still a future decision.) Both API routes and lib code log here.

export interface MemoryAuditEvent {
  at: string;
  workspaceId: string;
  userId: string;
  action: string;
  ref: string;
  detail: Record<string, unknown>;
}

const _events: MemoryAuditEvent[] = [];

export function memoryAudit() {
  return {
    log(
      workspaceId: string,
      userId: string,
      action: string,
      ref: string,
      detail: Record<string, unknown> = {},
    ) {
      _events.push({ at: new Date().toISOString(), workspaceId, userId, action, ref, detail });
      if (_events.length > 5000) _events.splice(0, _events.length - 5000);
    },
    recent(workspaceId: string, limit = 100): MemoryAuditEvent[] {
      return _events.filter((e) => e.workspaceId === workspaceId).slice(-limit).reverse();
    },
  };
}
