// ShapesOS — Phase 11 (devtools): read-only SQL guard (PURE).
//
// The Supabase connector runs agent-written SQL against a customer's
// database. Three independent layers keep that read-only:
//   1. this guard: ONE statement, starting with SELECT / WITH / TABLE /
//      VALUES; no data-modifying keyword anywhere (INSERT, UPDATE, DELETE,
//      MERGE, SELECT … INTO, FOR UPDATE/SHARE …), no side-effect or
//      SQL-executing function (set_config, pg_sleep, dblink, query_to_xml,
//      nextval, pg_net …), balanced parentheses;
//   2. a READ ONLY transaction wrapped around it (readOnlyWrapped) with a
//      statement timeout, and a row cap through an outer LIMIT;
//   3. the provider's own read-only role (Supabase `read_only: true`).
// The guard scans a "skeleton" of the statement: comments removed, string
// and dollar-quoted literals blanked, quoted identifiers reduced to their
// letters (so a keyword hidden in "quotes" is still seen), so nothing inside
// a literal can fake or hide structure. Anything it cannot scan (an
// unterminated literal or comment) is refused.

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

const MAX_SQL = 20_000;

/** Comments out, literals blanked, quoted identifiers → word chars. Throws on unterminated input. */
export function sqlSkeleton(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    // -- line comment
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      out += " ";
      continue;
    }
    // /* block comment */ (nested, as in PostgreSQL)
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) throw new SqlGuardError("The query has an unterminated comment.");
      out += " ";
      continue;
    }
    // 'string' / E'string' (backslash escapes) / '' escapes
    if (c === "'") {
      const escapes = /[eE]$/.test(out) && !/[A-Za-z0-9_][eE]$/.test(out);
      i += 1;
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) throw new SqlGuardError("The query has an unterminated string.");
      out += "''";
      continue;
    }
    // "quoted identifier" → its word characters (keywords inside stay visible)
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end === -1) throw new SqlGuardError("The query has an unterminated quoted identifier.");
      // "" inside an identifier is an escaped quote: keep scanning past pairs.
      let j = end;
      while (sql[j + 1] === '"') {
        const k = sql.indexOf('"', j + 2);
        if (k === -1) throw new SqlGuardError("The query has an unterminated quoted identifier.");
        j = k;
      }
      out += ` ${sql.slice(i + 1, j).replace(/[^A-Za-z0-9_]/g, "_")} `;
      i = j + 1;
      continue;
    }
    // $tag$ dollar-quoted $tag$
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]$/.test(out)) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new SqlGuardError("The query has an unterminated dollar-quoted string.");
        i = end + tag.length;
        out += "''";
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

const START = /^\s*(select|with|table|values)\b/i;

/** Keywords that write, lock or create — anywhere in the statement. */
const FORBIDDEN_WORDS = [
  "insert", "update", "delete", "merge", "upsert", "into", "truncate", "drop", "alter", "create",
  "grant", "revoke", "copy", "call", "execute", "prepare", "vacuum", "reindex", "cluster",
  "listen", "notify", "unlisten", "begin", "commit", "rollback", "savepoint", "discard", "refresh",
  "checkpoint", "reassign", "import", "security_label",
];
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bfor\s+(no\s+key\s+)?update\b|\bfor\s+(key\s+)?share\b/i, "row locks (FOR UPDATE / FOR SHARE)"],
  [/\bcomment\s+on\b/i, "COMMENT ON"],
  [/\bset\s+(local\s+|session\s+)?[a-z_]+\s*(=|to)\b/i, "SET"],
  [/\bnet\s*\.\s*http/i, "outbound HTTP (pg_net)"],
  [/\bhttp(_[a-z_]+)?\s*\(/i, "outbound HTTP"],
  [/\bdblink\w*\s*\(/i, "dblink"],
  [/\blo_\w+\s*\(/i, "large-object functions"],
];
/** Functions with side effects, or that run SQL from a string. */
const FORBIDDEN_FUNCTIONS = [
  "set_config", "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_read_file", "pg_read_binary_file",
  "pg_ls_dir", "pg_stat_file", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
  "pg_rotate_logfile", "pg_switch_wal", "pg_create_restore_point", "pg_notify", "pg_advisory_lock",
  "pg_advisory_xact_lock", "pg_try_advisory_lock", "pg_try_advisory_xact_lock", "nextval", "setval",
  "txid_current", "pg_current_xact_id", "query_to_xml", "query_to_xml_and_xmlschema", "query_to_xmlschema",
  "cursor_to_xml", "pg_logical_emit_message", "pg_replication_origin_create", "pg_file_write",
  "pg_import_system_collations", "pg_stat_reset", "pg_stat_statements_reset",
];

/**
 * Validate a read-only query. Returns the statement (trailing semicolons
 * and whitespace removed) or throws SqlGuardError explaining the refusal.
 */
export function assertReadOnlySql(sql: unknown): string {
  if (typeof sql !== "string" || !sql.trim()) throw new SqlGuardError("query is required.");
  if (sql.length > MAX_SQL) throw new SqlGuardError(`query must be under ${MAX_SQL} characters.`);
  if (sql.includes("\u0000")) throw new SqlGuardError("query must not contain NUL characters.");
  const statement = sql.trim().replace(/[;\s]+$/, "");
  const skel = sqlSkeleton(statement);
  if (skel.includes(";")) throw new SqlGuardError("Only one statement is allowed — remove the extra ';'.");
  if (!START.test(skel)) throw new SqlGuardError("Only read queries are allowed: the query must start with SELECT, WITH, TABLE or VALUES.");
  if (/^\s*explain\b/i.test(skel)) throw new SqlGuardError("EXPLAIN is not allowed.");
  const lower = skel.toLowerCase();
  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) throw new SqlGuardError(`Read-only queries cannot use ${w.toUpperCase()}.`);
  }
  for (const [re, label] of FORBIDDEN_PATTERNS) {
    if (re.test(lower)) throw new SqlGuardError(`Read-only queries cannot use ${label}.`);
  }
  for (const f of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${f}\\s*\\(`).test(lower)) throw new SqlGuardError(`Read-only queries cannot call ${f}().`);
  }
  let depth = 0;
  for (const ch of skel) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) break;
    }
  }
  if (depth !== 0) throw new SqlGuardError("The query has unbalanced parentheses.");
  return statement;
}

/**
 * The guarded statement inside a READ ONLY transaction with a statement
 * timeout and a row cap. Sent as one simple-protocol string: PostgreSQL runs
 * it as one implicit transaction, so SET TRANSACTION READ ONLY covers the
 * query (verified locally: a CREATE TABLE after it fails with "cannot
 * execute CREATE TABLE in a read-only transaction"). The SELECT is last so
 * its rows are the result.
 */
export function readOnlyWrapped(statement: string, opts: { maxRows: number; timeoutMs: number }): string {
  const rows = Math.max(1, Math.min(Math.floor(opts.maxRows), 10_000));
  const ms = Math.max(1000, Math.min(Math.floor(opts.timeoutMs), 120_000));
  return [
    "SET TRANSACTION READ ONLY;",
    `SET LOCAL statement_timeout = ${ms};`,
    `SELECT * FROM (\n${statement}\n) AS shapes_readonly_query LIMIT ${rows};`,
  ].join("\n");
}
