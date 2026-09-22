// Marketr — automation canvas: dependency-free 5-field cron parsing.
//
// Supports the common subset: "*", "*/n", "a-b", "a,b,c", and literal values
// in each of minute hour day-of-month month day-of-week. Everything else is
// rejected with a clear error (validated on save).

const RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  const add = (v: number) => {
    if (Number.isInteger(v) && v >= min && v <= max) out.add(v);
  };
  for (const part of field.split(",").map((s) => s.trim())) {
    if (!part) throw new Error(`Invalid cron field "${field}"`);
    if (part === "*") {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!step) throw new Error(`Invalid cron step "${part}"`);
      for (let v = min; v <= max; v += step) out.add(v);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      const step = Number(rangeMatch[3] ?? "1");
      if (lo > hi || !step) throw new Error(`Invalid cron range "${part}"`);
      for (let v = lo; v <= hi; v += step) add(v);
      continue;
    }
    if (/^\d+$/.test(part)) {
      add(Number(part));
      continue;
    }
    throw new Error(`Unsupported cron expression part "${part}" (field "${field}")`);
  }
  if (out.size === 0) throw new Error(`Invalid cron field "${field}"`);
  return out;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

/** Parse and validate a 5-field cron expression. Throws on invalid input. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron must have 5 fields (got ${fields.length}): "${expr}"`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i][0], RANGES[i][1]));
  return { minute, hour, dom, month, dow };
}

/** True when `date` falls on a minute this cron fires. */
export function cronDue(expr: string, date: Date = new Date()): boolean {
  const c = parseCron(expr);
  return (
    c.minute.has(date.getMinutes()) &&
    c.hour.has(date.getHours()) &&
    c.dom.has(date.getDate()) &&
    c.month.has(date.getMonth() + 1) &&
    c.dow.has(date.getDay())
  );
}

/** Start of the current minute — used to avoid double-firing a schedule. */
export function startOfCurrentMinute(date: Date = new Date()): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}
