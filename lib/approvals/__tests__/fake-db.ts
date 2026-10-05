// ShapesOS — tiny in-memory stand-in for the Prisma delegates the inbox and
// the notification producers use. Not a Prisma reimplementation: it records
// every query (so tests can assert workspace scoping) and evaluates the
// where-clause subset those modules use (equality, in/notIn, gt/lt,
// startsWith, not, NOT, OR, relation objects, `some`). `select` is ignored.

type Row = Record<string, unknown>;

export interface FakeCall {
  model: string;
  op: string;
  args: Record<string, unknown> | undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

const OPERATORS = new Set(["in", "notIn", "gt", "gte", "lt", "lte", "startsWith", "not", "equals", "some", "mode"]);

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (!isPlainObject(cond)) return value === cond || (value instanceof Date && cond instanceof Date && value.getTime() === cond.getTime());
  const keys = Object.keys(cond);
  if (keys.length > 0 && keys.every((k) => OPERATORS.has(k))) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === "in" && !(arg as unknown[]).includes(value)) return false;
      if (op === "notIn" && (arg as unknown[]).includes(value)) return false;
      if (op === "gt" && !(value != null && cmp(value, arg) > 0)) return false;
      if (op === "gte" && !(value != null && cmp(value, arg) >= 0)) return false;
      if (op === "lt" && !(value != null && cmp(value, arg) < 0)) return false;
      if (op === "lte" && !(value != null && cmp(value, arg) <= 0)) return false;
      if (op === "startsWith" && !(typeof value === "string" && value.startsWith(arg as string))) return false;
      if (op === "equals" && value !== arg) return false;
      if (op === "not" && (arg === null ? value === null || value === undefined : matchValue(value, arg))) return false;
      if (op === "some" && !(Array.isArray(value) && value.some((v) => matches(v as Row, arg as Row)))) return false;
    }
    return true;
  }
  // Relation filter: nested where on the related row.
  return isPlainObject(value) && matches(value as Row, cond as Row);
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "OR") {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
    } else if (key === "AND") {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
    } else if (key === "NOT") {
      const list = Array.isArray(cond) ? (cond as Row[]) : [cond as Row];
      if (list.some((w) => matches(row, w))) return false;
    } else if (!matchValue(row[key], cond)) {
      return false;
    }
  }
  return true;
}

export interface FakeDb {
  db: Record<string, Record<string, (args?: Record<string, unknown>) => Promise<unknown>>>;
  calls: FakeCall[];
  tables: Record<string, Row[]>;
}

/** Build a fake client over `tables` (model name → rows). `fail` makes a model throw. */
export function fakeDb(tables: Record<string, Row[]>, opts: { fail?: string[] } = {}): FakeDb {
  const calls: FakeCall[] = [];
  const fail = new Set(opts.fail ?? []);
  const delegate = (model: string) => {
    const rows = () => (tables[model] ??= []);
    const guard = (op: string, args?: Record<string, unknown>) => {
      calls.push({ model, op, args });
      if (fail.has(model)) throw new Error(`${model} is down`);
    };
    return {
      async findMany(args?: Record<string, unknown>) {
        guard("findMany", args);
        const out = rows().filter((r) => matches(r, args?.where as Row));
        return typeof args?.take === "number" ? out.slice(0, args.take) : out;
      },
      async findFirst(args?: Record<string, unknown>) {
        guard("findFirst", args);
        return rows().find((r) => matches(r, args?.where as Row)) ?? null;
      },
      async findUnique(args?: Record<string, unknown>) {
        guard("findUnique", args);
        return rows().find((r) => matches(r, args?.where as Row)) ?? null;
      },
      async count(args?: Record<string, unknown>) {
        guard("count", args);
        return rows().filter((r) => matches(r, args?.where as Row)).length;
      },
      async createMany(args?: Record<string, unknown>) {
        guard("createMany", args);
        const data = (args?.data ?? []) as Row[];
        let count = 0;
        for (const d of data) {
          const dup =
            args?.skipDuplicates &&
            d.dedupKey != null &&
            rows().some((r) => r.userId === d.userId && r.dedupKey === d.dedupKey);
          if (dup) continue;
          rows().push({ id: `n${rows().length + 1}`, readAt: null, createdAt: new Date(), ...d });
          count++;
        }
        return { count };
      },
      async updateMany(args?: Record<string, unknown>) {
        guard("updateMany", args);
        const hit = rows().filter((r) => matches(r, args?.where as Row));
        for (const r of hit) Object.assign(r, args?.data as Row);
        return { count: hit.length };
      },
    };
  };
  const db = new Proxy({} as FakeDb["db"], {
    get: (_t, model: string) => delegate(model),
  });
  return { db, calls, tables };
}

/** Deep-search a where clause for any `workspaceId` value. */
export function workspaceIdsIn(where: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(where)) {
    for (const w of where) workspaceIdsIn(w, out);
  } else if (isPlainObject(where)) {
    for (const [k, v] of Object.entries(where)) {
      if (k === "workspaceId" && typeof v === "string") out.add(v);
      else workspaceIdsIn(v, out);
    }
  }
  return out;
}
