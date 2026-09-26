// Marketr — Phase 10 M5: ambient types for node:sqlite.
//
// node:sqlite ships with the runtime (Node >= 22.5) but @types/node is pinned
// to v20, so it has no declarations. Minimal typing of the surface Marketr
// uses (Phase 10 M5 CC-graph index lookups).

declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
  }

  export interface StatementSync {
    run(
      ...params: unknown[]
    ): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path?: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
