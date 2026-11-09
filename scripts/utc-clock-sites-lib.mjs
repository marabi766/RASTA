// A database clock must not reach a `timestamp(3)` column in the session's zone (FU-188).
//
// `timestamp(3)` holds UTC wall time. A bare now(), clock_timestamp() or
// CURRENT_TIMESTAMP is a timestamptz: written into such a column or compared with it,
// PostgreSQL converts it in the SESSION's zone. Refused, in production SQL (literals of
// services/*/src and packages/*/src) and in the bodies of the functions the migrations
// leave live:
//
//   R1  a bare clock in a statement that names a `timestamp(3)` column of a table it uses,
//       or uses a table it cannot name (spliced);
//   R2  an INSERT that leaves a `timestamp(3)` column to a session-dependent DEFAULT;
//   R3  a bare clock in a fragment that names no table, except a plain reading of the clock
//       (`SELECT clock_timestamp() AS now`: an instant, right in any zone);
//   R4  a routine with a bare clock that names a `timestamp` type (a local, parameter, result
//       or cast) or a type it cannot read (`%TYPE`): the conversion goes through the session.
//
// WHAT IT CANNOT PROVE, IT REFUSES (PR #906 r1 F2, r2 F2 = FU-226). Each construct is read by
// an explicit grammar, and what falls outside it counts as unsafe, never as absent:
//   - relations: FROM lists (every comma), JOIN, DELETE … USING, INSERT/MERGE INTO and UPDATE
//     targets (`UPDATE ONLY (t)`); a name resolves to a replayed public table, a listed
//     catalogue relation or a CTE in its WITH's scope, else it is unresolved (`other.t`,
//     `pg_missing`, `"PUBLIC".t`); a table named anywhere else (`NULL::t`, `NULL::public.t`,
//     `NULL::"T"`) counts for R1, in another schema (`pg_temp.t`, `::other.x`) it is unresolved;
//   - strings by their decoded value (dollar quotes, E'…' and U&'…' escapes), U&"…" names;
//   - R0 (PR #979 r1, r2): SQL anywhere in a string or a `||` chain of strings, a DO or EXECUTE
//     statement, a UESCAPE, a session setting that may move names (search_path, SET ROLE,
//     set_config() of an unlisted one; SET/RESET read by its grammar). Every literal is read;
//     SQL or an undecodable string in a migration's DO block goes to review; strings lexically
//     enclosed by unlisted calls are refused. Recognized SQL-text executor calls (core XML/full-text,
//     dblink*, pg_background_* and cron.*) are refused in production SQL, live routine/view bodies
//     and every migration statement's tokens, including DDL expressions; in DO bodies they go to
//     review. Inputs need not contain a string; no data-flow proof is attempted. DISCARD and writes
//     to pg_settings are session changes. Only reviewed non-executing extensions are replayed;
//   - temporary CREATE modifiers and schemas, and SELECT INTO definitions: refused before
//     replay dispatch and in production/live SQL. Only explicit PL/pgSQL routines/DO bodies
//     can use plain SELECT INTO for variables; temporary/table modifiers remain refused.
//   - types as PostgreSQL reads them (`pg_catalog.timestamp`, `"timestamp"`);
//   - a pin: grouping, `AT TIME ZONE 'UTC'` or timezone('UTC', …), then date_trunc() or a cast
//     to plain timestamp, used where nothing converts it back (no coalesce(), CASE branch,
//     other cast or zone; listed calls only, read outward through every parenthesis);
//   - a text that does not lex is lexed again past the stray quote, never skipped;
//   - migrations: a statement, ALTER action, trigger binding or DO block it does not model, a
//     partition's own defaults or column ALTERs, DDL or EXECUTE in a routine; conditional DDL
//     (IF [NOT] EXISTS) as PostgreSQL runs it. DDL or EXECUTE in a DO block goes to review.
//     A column definition is read from its tokens; a session setting, CREATE SCHEMA, a second
//     CREATE of a known name, a name its patterns would cut or fold (a quoted name they do not
//     read, `$` in a word, U&"…", a character outside ASCII outside strings): refused.
// A reviewed exemption is bound to what its review relied on: a routine to its signature,
// body, trigger bindings and the column types of the tables it fires on or names; a DO block
// to its body and migration; a literal to its text and the column types it `assumes`.
//
// LIMITS. This reads clocks, not types. It cannot see an instant reaching a `timestamp(3)`
// column with no clock in the statement (a timestamptz column copied across, a
// `$n::timestamptz` parameter), a pinned clock compared with or added to a timestamptz operand,
// a pinned constant spliced into another literal (it is read where it is written), a CASE or
// COALESCE sibling's type (refused for now, FU-226 part B), a column spliced with `${column}` on a named table,
// `AT TIME ZONE 'UTC'` wrongly written into a timestamptz column, one-shot DML of a migration
// (already applied; not live), or SQL outside production source and migrations (seeds,
// runbooks). What it cannot see the runtime check refuses: no application session runs outside
// UTC (nest-common utc-session.ts).
//
// Allowed spellings: `<clock> AT TIME ZONE 'UTC'` and `timezone('UTC', <clock>)`, with
// parentheses around the clock, not followed by another zone conversion. LOCALTIMESTAMP,
// LOCALTIME, CURRENT_TIME, CURRENT_DATE, timeofday() and the strings 'now', 'today',
// 'tomorrow', 'yesterday' have no such spelling: they are the session's wall clock.
//
// Column types and defaults come from replaying each service's migrations, because
// SQL-only tables exist; a type that disagrees with schema.prisma throws.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { authoredFiles } from './authored-source-inventory.cjs';
import { productionFiles, readSchemas, sqlLiterals } from './eligibility-clock-derive.mjs';
import { lex as lexSql, stripComments } from './eligibility-clock-sql.mjs';

const CALLS = new Set(['now', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp']);
const KEYWORD_CLOCK = 'current_timestamp';
const SESSION_WALL = new Set(['localtimestamp', 'localtime', 'current_time', 'current_date']);
// A string's VALUE that PostgreSQL may read as the session's clock: one of these words among a
// few date/time fields (`'tomorrow 10:00'`, `' NOW '`), not a sentence that mentions one.
const CLOCK_WORD = /(?:^|[^a-z])(?:now|today|tomorrow|yesterday)(?:$|[^a-z])/i;
const isStringClock = (value) =>
  CLOCK_WORD.test(value) && /^[\w\s:.,+\-/]*$/.test(value) && value.trim().split(/\s+/).length <= 6;
const isUtcString = (t) => t?.type === 'string' && t.value.toUpperCase() === "'UTC'";
/** An identifier's name: folded, because the spellings a guard must catch differ only in case. */
const nameOf = (t) =>
  t?.type === 'quoted' ? t.value.toLowerCase() : t?.type === 'word' ? t.lower : null;
const isOp = (t, value) => t?.type === 'op' && t.value === value;
const isWord = (t, ...values) => t?.type === 'word' && values.includes(t.lower);
const isAtTimeZone = (tokens, i) =>
  isWord(tokens[i], 'at') && isWord(tokens[i + 1], 'time') && isWord(tokens[i + 2], 'zone');
// A parenthesis after these groups an expression; after any other name it is a call.
const BEFORE_GROUPING = new Set(
  'select when then else and or not where on by having returning values in between return if from exists any all some filter over group'.split(
    ' ',
  ),
);
const isGrouping = (before) => nameOf(before) === null || BEFORE_GROUPING.has(before.lower);

const chr = (code) => (code > 0x10ffff ? '\uFFFD' : String.fromCodePoint(code));
const ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const unescape = (body) =>
  body.replace(
    /\\(?:x([0-9a-f]{1,2})|u([0-9a-f]{4})|U([0-9a-f]{8})|([0-7]{1,3})|(.))/gis,
    (...g) =>
      g[5] !== undefined
        ? (ESCAPES[g[5]] ?? g[5])
        : chr(parseInt(g[1] ?? g[2] ?? g[3] ?? g[4], g[4] ? 8 : 16)),
  );
const unicodeUnescape = (body) =>
  body.replace(
    /\\(?:([0-9a-f]{4})|\+([0-9a-f]{6})|(\\))/gi,
    (_, a, b, slash) => slash ?? chr(parseInt(a ?? b, 16)),
  );

/**
 * Tokens, each `U&"…"` read as the one identifier PostgreSQL reads (PR #979 r1 F1: `U&"\006Eow"()`
 * is now()). With UESCAPE its escapes are not decoded here: `unreadable`, so refused.
 */
function lex(text) {
  const tokens = [];
  for (const t of lexSql(text)) {
    const [u, amp] = [tokens.at(-2), tokens.at(-1)];
    if (t.type === 'quoted' && isOp(amp, '&') && isWord(u, 'u') && u.start + 2 === t.start) {
      const value = unicodeUnescape(t.value);
      tokens.splice(-2, 2, {
        ...t,
        value,
        lower: value.toLowerCase(),
        start: u.start,
        unicode: true,
      });
    } else if (isWord(t, 'uescape') && tokens.at(-1)?.unicode) {
      tokens.push({ ...t, unreadable: true });
    } else tokens.push(t);
  }
  return tokens;
}

/**
 * What a string token may mean, decoded as PostgreSQL decodes it (PR #906 r2 F2): a dollar
 * quote, E'…' and U&'…' escapes, and '…' read both with and without backslash escapes (the
 * value of standard_conforming_strings is not in the text). Null: it cannot be read.
 */
function stringValues(tokens, i) {
  const t = tokens[i];
  if (t.unterminated) return null;
  const dollar = /^\$\w*\$/.exec(t.value)?.[0];
  if (dollar) return [t.value.slice(dollar.length, t.value.length - dollar.length)];
  const escaped = /^e/i.test(t.value);
  const body = t.value.slice(escaped ? 2 : 1, -1).replaceAll("''", "'");
  const [u, amp] = [tokens[i - 2], tokens[i - 1]];
  if (isOp(amp, '&') && isWord(u, 'u') && u.start + 1 === amp.start && amp.start + 1 === t.start) {
    return isWord(tokens[i + 1], 'uescape') ? null : [unicodeUnescape(body)];
  }
  return escaped ? [unescape(body)] : [body, unescape(body)];
}

/**
 * The type named at tokens[i] and its last token: 'ts' (timestamp without time zone), 'tz', or
 * 'other'. Qualified by pg_catalog, quoted or in any case it is the same type (PR #906 r2 F2).
 */
export function typeAt(tokens, i) {
  let j = i;
  if (nameOf(tokens[j]) === 'pg_catalog' && isOp(tokens[j + 1], '.')) j += 2;
  const name = nameOf(tokens[j]);
  if ((name !== 'timestamp' && name !== 'timestamptz') || isOp(tokens[j + 1], '.')) {
    return { kind: 'other', end: j };
  }
  const end = isOp(tokens[j + 1], '(') ? closing(tokens, j + 1) : j;
  if (name === 'timestamptz') return { kind: 'tz', end };
  const zoned = isWord(tokens[end + 2], 'time') && isWord(tokens[end + 3], 'zone');
  if (isWord(tokens[end + 1], 'with') && zoned) return { kind: 'tz', end: end + 3 };
  if (isWord(tokens[end + 1], 'without') && zoned) return { kind: 'ts', end: end + 3 };
  return { kind: 'ts', end };
}

const QUERY_HEADS = ['select', 'with', 'values', 'insert', 'update', 'delete'];
/** The parenthesis opening the one tokens[i] stands in, or -1. */
function enclosing(tokens, i) {
  for (let k = i - 1, depth = 0; k >= 0; k -= 1) {
    if (isOp(tokens[k], ')')) depth += 1;
    else if (isOp(tokens[k], '(') && (depth -= 1) < 0) return k;
  }
  return -1;
}
/** Whether tokens[i] stands inside the parentheses of a call (not a grouping, not a subquery). */
function insideCall(tokens, i) {
  const open = enclosing(tokens, i);
  return open >= 0 && !isGrouping(tokens[open - 1]) && !isWord(tokens[open + 1], ...QUERY_HEADS);
}
/** The arguments of the call opened at tokens[open]: its commas at depth one, plus one. */
function argumentCount(tokens, open) {
  let count = 1;
  for (let k = open + 1, depth = 0; k < closing(tokens, open); k += 1) {
    if (isOp(tokens[k], '(')) depth += 1;
    else if (isOp(tokens[k], ')')) depth -= 1;
    else if (depth === 0 && isOp(tokens[k], ',')) count += 1;
  }
  return count;
}

// Calls a pinned value may pass through: these keep it a plain timestamp (date_trunc of two
// arguments, min, max) or end it in a type with no zone (to_char, extract, date_part, count).
// Any other call (coalesce, greatest, a cast, three-argument date_trunc) may convert it.
const KEEPS_TIMESTAMP = new Set(['date_trunc', 'min', 'max']);
const ENDS_TIMESTAMP = new Set(['to_char', 'extract', 'date_part', 'count']);

/** Whether every parenthesis around tokens[i], read outward, keeps it a plain timestamp. */
function enclosureKeepsPin(tokens, i) {
  for (let open = enclosing(tokens, i); open >= 0; open = enclosing(tokens, open)) {
    const name = nameOf(tokens[open - 1]);
    if (ENDS_TIMESTAMP.has(name)) return true;
    const kept =
      isGrouping(tokens[open - 1]) ||
      isWord(tokens[open + 1], ...QUERY_HEADS) ||
      (KEEPS_TIMESTAMP.has(name) && argumentCount(tokens, open) <= 2);
    if (!kept) return false;
  }
  return true;
}

/** `name('<arg>'[::text], tokens[start..end])` with name in `names`: the call's span, or null. */
function callAround(tokens, start, end, names, argument) {
  if (!isOp(tokens[start - 1], ',') || !isOp(tokens[end + 1], ')')) return null;
  const text = isOp(tokens[start - 3], '::') && isWord(tokens[start - 2], 'text');
  const arg = start - (text ? 4 : 2);
  if (
    !argument(tokens[arg]) ||
    !isOp(tokens[arg - 1], '(') ||
    !names.has(nameOf(tokens[arg - 2]))
  ) {
    return null;
  }
  const first = arg - 2;
  const qualified = isOp(tokens[first - 1], '.') && nameOf(tokens[first - 2]) === 'pg_catalog';
  return { start: qualified ? first - 2 : first, end: end + 1 };
}

// Where a value pinned to UTC may go next, and come from: a comparison, an assignment,
// arithmetic, a list or a clause. Anything else (a call such as coalesce(), a CASE branch, an
// array, another zone or a cast to another type) may turn it back into a session-zone value.
const PIN_NEIGHBOURS = new Set([',', ';', '=', '<', '<=', '>', '>=', '<>', '!=', '+', '-']);
const PIN_BEFORE = new Set(
  'select where and or when if elsif return returning between default by set from'.split(' '),
);
const PIN_AFTER = new Set(
  'and or as from where then loop is between order group limit offset fetch for union intersect except into having window asc desc nulls returning on when'.split(
    ' ',
  ),
);
const TIMEZONE = new Set(['timezone']);
const DATE_TRUNC = new Set(['date_trunc']);

/**
 * Whether the clock at tokens[first..last] is pinned to UTC: read outward through an explicit
 * grammar (grouping, `AT TIME ZONE 'UTC'`, `timezone('UTC', …)`, then date_trunc() or a cast to
 * plain timestamp), and then used where nothing converts it back. What it cannot read is a bare
 * clock (PR #906 r2 F2: nested casts, quoted or qualified types, coalesce()).
 */
function pinnedToUtc(tokens, first, last) {
  let [start, end, pinned, bound] = [first, last, false, true];
  if (isOp(tokens[start - 1], '.') && nameOf(tokens[start - 2]) === 'pg_catalog') start -= 2;
  for (;;) {
    let call;
    if (
      isOp(tokens[start - 1], '(') &&
      isOp(tokens[end + 1], ')') &&
      isGrouping(tokens[start - 2])
    ) {
      [start, end, bound] = [start - 1, end + 1, true];
    } else if (!pinned && isAtTimeZone(tokens, end + 1) && isUtcString(tokens[end + 4])) {
      [end, pinned, bound] = [end + 4, true, false];
    } else if (!pinned && (call = callAround(tokens, start, end, TIMEZONE, isUtcString))) {
      [start, end, pinned] = [call.start, call.end, true];
    } else if (
      pinned &&
      (call = callAround(tokens, start, end, DATE_TRUNC, (t) => t?.type === 'string'))
    ) {
      [start, end, bound] = [call.start, call.end, true];
    } else if (
      pinned &&
      bound &&
      isOp(tokens[end + 1], '::') &&
      typeAt(tokens, end + 2).kind === 'ts'
    ) {
      end = typeAt(tokens, end + 2).end;
    } else break;
  }
  if (!pinned) return false;
  const [before, after] = [tokens[start - 1], tokens[end + 1]];
  const fromOk =
    before === undefined ||
    (before.type === 'op' && (PIN_NEIGHBOURS.has(before.value) || isOp(before, '('))) ||
    PIN_BEFORE.has(before.lower);
  const toOk =
    after === undefined ||
    (after.type === 'op' && (PIN_NEIGHBOURS.has(after.value) || isOp(after, ')'))) ||
    PIN_AFTER.has(after.lower);
  return fromOk && toOk && enclosureKeepsPin(tokens, start);
}

/**
 * Token ranges of the clocks in `tokens`, each with whether it is pinned to UTC. In a text with
 * unbalanced parentheses (a piece of a larger statement) no pin is proven: its context is elsewhere.
 */
export function clocksIn(tokens) {
  const found = [];
  let depth = 0;
  for (const t of tokens) if (depth >= 0) depth += isOp(t, '(') ? 1 : isOp(t, ')') ? -1 : 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const name = nameOf(t);
    let end;
    if (t.type === 'string') {
      const values = stringValues(tokens, i);
      if (!values || values.some(isStringClock))
        found.push({ index: i, name: t.value, utc: false });
      continue;
    }
    if (name === null) continue;
    if (CALLS.has(name) && isOp(tokens[i + 1], '(') && isOp(tokens[i + 2], ')')) {
      end = i + 2;
    } else if (t.type === 'word' && t.lower === KEYWORD_CLOCK) {
      end = isOp(tokens[i + 1], '(') && isOp(tokens[i + 3], ')') ? i + 3 : i;
    } else if (t.type === 'word' && SESSION_WALL.has(t.lower)) {
      found.push({ index: i, name: t.lower, utc: false });
      continue;
    } else if (name === 'timeofday' && isOp(tokens[i + 1], '(')) {
      found.push({ index: i, name, utc: false });
      continue;
    } else {
      continue;
    }
    found.push({ index: i, name, utc: depth === 0 && pinnedToUtc(tokens, i, end) });
  }
  return found;
}

// A call in a `timestamp(3)` default other than these may read the clock: unproven, so refused.
const PROVEN_DEFAULT_CALLS = new Set([...CALLS, KEYWORD_CLOCK, 'timezone', 'date_trunc']);

/** A default expression's verdict: it depends, or may depend, on the session's zone. */
function defaultDependsOnSession(expression) {
  const tokens = typeof expression === 'string' ? lex(expression) : expression;
  return (
    clocksIn(tokens).some((clock) => !clock.utc) ||
    tokens.some(
      (t, i) => isOp(tokens[i + 1], '(') && nameOf(t) && !PROVEN_DEFAULT_CALLS.has(nameOf(t)),
    )
  );
}

const IDENT = String.raw`(?:"?public"?\.)?"?(\w+)"?`;
const NAME = String.raw`"?(\w+)"?`;
const statementRe = (pattern) => new RegExp(String.raw`^\s*${pattern}`, 'i');
const CREATE_TABLE = statementRe(
  String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s*\(`,
);
const PARTITION_OF = statementRe(
  String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s+PARTITION\s+OF\s+${IDENT}`,
);
const DROP_TABLE = statementRe(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`);
const DROP_ROUTINE = statementRe(
  String.raw`DROP\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:IF\s+EXISTS\s+)?${IDENT}\s*(\([^;]*\))?`,
);
const VIEW = statementRe(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|RECURSIVE|MATERIALIZED)\s+)*VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`,
);
const DROP_VIEW = statementRe(
  String.raw`DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?${IDENT}`,
);
const ALTER_TABLE = String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}\s+`;
const RENAME_TABLE = statementRe(String.raw`${ALTER_TABLE}RENAME\s+TO\s+${NAME}`);
const ALTER_ACTIONS = statementRe(String.raw`${ALTER_TABLE}([\s\S]+)$`);
const DROP_COLUMN = statementRe(String.raw`DROP\s+(?:COLUMN\s+)?(IF\s+EXISTS\s+)?${NAME}`);
const RENAME_COLUMN = statementRe(String.raw`RENAME\s+(?:COLUMN\s+)?${NAME}\s+TO\s+${NAME}`);
const ALTER_COLUMN = String.raw`ALTER\s+(?:COLUMN\s+)?${NAME}\s+`;
const SET_TYPE = statementRe(String.raw`${ALTER_COLUMN}(?:SET\s+DATA\s+)?TYPE\s+([\s\S]+)$`);
const SET_DEFAULT = statementRe(String.raw`${ALTER_COLUMN}SET\s+DEFAULT\s+([\s\S]+)$`);
const DROP_DEFAULT = statementRe(String.raw`${ALTER_COLUMN}DROP\s+DEFAULT`);
const NOT_A_COLUMN = ['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'];
// The words that open a column constraint: what may follow a column's type. Those main's
// migrations do not use (COLLATE, DEFERRABLE, INITIALLY, MATCH, NULLS …) are refused.
const COLUMN_CLAUSE = new Set(
  'constraint not null default check primary unique references generated collate deferrable initially'.split(
    ' ',
  ),
);

// ALTER TABLE actions that cannot change a column's type or default, and hold no expression.
const INERT_ALTER_ACTION =
  /^\s*(?:ADD\s+CONSTRAINT|ADD\s+(?:PRIMARY|UNIQUE|FOREIGN)|DROP\s+CONSTRAINT|RENAME\s+CONSTRAINT|ALTER\s+CONSTRAINT|VALIDATE\s+CONSTRAINT|(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY|(?:ENABLE|DISABLE)\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER|OWNER\s+TO|REPLICA\s+IDENTITY|ALTER\s+(?:COLUMN\s+)?"?\w+"?\s+(?:SET|DROP)\s+NOT\s+NULL)\b/i;
// Statement heads with no column type, default or routine body of their own. A clock in one of
// these is refused below, unless the head is one-shot: it ran once, when the migration applied.
const INERT_HEADS =
  /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|ALTER\s+INDEX|CREATE\s+TYPE|ALTER\s+TYPE|DROP\s+TYPE|CREATE\s+EXTENSION|CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER|DROP\s+TRIGGER|COMMENT|GRANT|REVOKE|SET|RESET|LOCK|BEGIN|COMMIT|ALTER\s+DEFAULT\s+PRIVILEGES|CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+POLICY|CREATE\s+SEQUENCE|ALTER\s+SEQUENCE|DROP\s+SEQUENCE|ANALYZE|TRUNCATE)\b/i;
const ONE_SHOT_HEADS = /^(?:INSERT|UPDATE|DELETE|SELECT|WITH)\b/i;
const CREATE_TRIGGER = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i;
const TRIGGER_BINDING =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b[\s\S]*?\bON\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*\(/i;
// Statement heads that change what is live: DDL the replay cannot follow from inside a body.
const LIVE_DDL = new Set(['create', 'alter', 'drop', 'import']);
/** DDL or dynamic SQL in a body, read from its tokens (words in strings are no statements). */
const ddlIn = (tokens) =>
  tokens.some((t) => isWord(t, 'execute', ...LIVE_DDL)) || sqlTextExecutor(tokens) !== null;

/** The index of the parenthesis closing tokens[open]. */
function closing(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isOp(tokens[i], '(')) depth += 1;
    if (isOp(tokens[i], ')') && (depth -= 1) === 0) return i;
  }
  return tokens.length;
}

/** Splits at the commas outside parentheses and strings. */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (const t of lex(text)) {
    if (isOp(t, '(')) depth += 1;
    if (isOp(t, ')')) depth -= 1;
    if (isOp(t, ',') && depth === 0) {
      parts.push(text.slice(from, t.start));
      from = t.start + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** The statements of a SQL text, at the semicolons outside parentheses, strings and comments. */
function statementsOf(raw) {
  const text = stripComments(raw.replace(/\r\n?/g, '\n'));
  const statements = [];
  let tokens = [];
  let depth = 0;
  let unreadable = false;
  const flush = (stop) => {
    if (tokens.length > 0) {
      const statement = { tokens, text: text.slice(tokens[0].start, stop) };
      statements.push(unreadable || depth !== 0 ? { ...statement, unreadable: true } : statement);
    }
    [tokens, depth, unreadable] = [[], 0, false];
  };
  for (const t of lex(text)) {
    if (isOp(t, ';') && depth === 0) {
      flush(t.start);
      continue;
    }
    if (isOp(t, '(')) depth += 1;
    if (isOp(t, ')') && (depth -= 1) < 0) unreadable = true;
    if (t.unterminated || t.unreadable) unreadable = true;
    tokens.push(t);
  }
  flush(text.length);
  return statements;
}

const columnType = (definition) => typeAt(lex(definition), 0).kind;

const hasBareClock = (text) => clocksIn(lex(text)).some((clock) => !clock.utc);

/** The end of the expression at tokens[k]: the next column clause at its depth (CASE … END and
 * parentheses nest; `IS [NOT] NULL` is part of it). */
function expressionEnd(tokens, k) {
  for (let i = k, depth = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (isOp(t, '(') || isWord(t, 'case')) depth += 1;
    else if (isOp(t, ')') || isWord(t, 'end')) depth -= 1;
    else if (
      i > k &&
      depth === 0 &&
      COLUMN_CLAUSE.has(t.type === 'word' && t.lower) &&
      !isWord(tokens[i - 1], 'is') &&
      !(isWord(tokens[i - 1], 'not') && isWord(tokens[i - 2], 'is'))
    )
      return i;
  }
  return tokens.length;
}

/** The index after `REFERENCES t [(c)] [ON DELETE|UPDATE action]…` at tokens[k], or -1. */
function referencesEnd(tokens, k) {
  let j = nameOf(tokens[k]) && isOp(tokens[k + 1], '.') ? k + 2 : k;
  if (!nameOf(tokens[j])) return -1;
  j = isOp(tokens[j + 1], '(') ? closing(tokens, j + 1) + 1 : j + 1;
  while (isWord(tokens[j], 'on') && isWord(tokens[j + 1], 'delete', 'update')) {
    const [a, b] = [tokens[j + 2], tokens[j + 3]];
    if (isWord(a, 'cascade', 'restrict')) j += 3;
    else if (
      (isWord(a, 'no') && isWord(b, 'action')) ||
      (isWord(a, 'set') && isWord(b, 'null', 'default'))
    )
      j += 4;
    else return -1;
  }
  return j;
}

/**
 * A column definition read from its tokens (PR #979 r1 F4): the name is token 0, the type what
 * stands before its first clause, each clause by its grammar, the DEFAULT up to the next clause.
 * What it does not read, and a bare clock outside the DEFAULT, is `{refused}`.
 */
function readColumn(tokens) {
  const refused = {
    refused: `a column definition not read: ${tokens.map((t) => t.value).join(' ')}`,
  };
  if (tokens[0]?.type !== 'word' && tokens[0]?.type !== 'quoted') return refused;
  let k = 1;
  while (k < tokens.length && !COLUMN_CLAUSE.has(tokens[k].type === 'word' && tokens[k].lower))
    k = isOp(tokens[k], '(') ? closing(tokens, k) + 1 : k + 1;
  const type = typeAt(tokens, 1);
  if (k === 1 || (type.kind !== 'other' && type.end !== k - 1)) return refused;
  let [sessionDefault, from, to] = [false, k, k];
  while (k < tokens.length) {
    const [t, next] = [tokens[k], tokens[k + 1]];
    if (isWord(t, 'constraint') && nameOf(next)) k += 2;
    else if (isWord(t, 'not') && isWord(next, 'null')) k += 2;
    else if (isWord(t, 'null', 'unique')) k += 1;
    else if (isWord(t, 'primary') && isWord(next, 'key')) k += 2;
    else if (isWord(t, 'check') && isOp(next, '(')) k = closing(tokens, k + 1) + 1;
    else if (isWord(t, 'references') && referencesEnd(tokens, k + 1) > 0)
      k = referencesEnd(tokens, k + 1);
    else if (isWord(t, 'default') && k + 1 < tokens.length) {
      [from, to] = [k + 1, expressionEnd(tokens, k + 1)];
      sessionDefault = defaultDependsOnSession(tokens.slice(from, to));
      k = to;
    } else if (isWord(t, 'generated')) {
      const as = isWord(next, 'always')
        ? k + 2
        : isWord(next, 'by') && isWord(tokens[k + 2], 'default')
          ? k + 3
          : -1;
      if (!isWord(tokens[as], 'as')) return refused;
      if (isWord(tokens[as + 1], 'identity'))
        k = isOp(tokens[as + 2], '(') ? closing(tokens, as + 2) + 1 : as + 2;
      else if (isOp(tokens[as + 1], '(') && isWord(tokens[closing(tokens, as + 1) + 1], 'stored'))
        k = closing(tokens, as + 1) + 2;
      else return refused;
    } else return refused;
  }
  if (clocksIn(tokens).some((clock) => !clock.utc && (clock.index < from || clock.index >= to))) {
    return { refused: `a clock outside a DEFAULT: ${tokens.map((t) => t.value).join(' ')}` };
  }
  return { name: tokens[0].value, facts: { type: type.kind, sessionDefault } };
}

/** Applies one action; answers what is not modelled, or undefined. */
function applyAlterAction(columns, action) {
  const missing = (column) => `ALTER on unknown column ${column}`;
  const tokens = lex(action);
  const add = isWord(tokens[0], 'add') && !INERT_ALTER_ACTION.test(action);
  // A clock outside a DEFAULT (a CHECK, a USING): a live expression nothing reads.
  if (!add && !SET_DEFAULT.test(action) && hasBareClock(action))
    return `a clock outside a DEFAULT: ${action.trim()}`;
  let a;
  if (INERT_ALTER_ACTION.test(action)) return undefined;
  if (add) {
    let k = isWord(tokens[1], 'column') ? 2 : 1;
    const ifNotExists = isWord(tokens[k], 'if') && isWord(tokens[k + 1], 'not');
    if (ifNotExists && isWord(tokens[k + 2], 'exists')) k += 3;
    if (isWord(tokens[k], ...NOT_A_COLUMN)) return `a constraint not modelled: ${action.trim()}`;
    const column = readColumn(tokens.slice(k));
    if (column.refused) return column.refused;
    // As PostgreSQL does: IF NOT EXISTS keeps a column there (and its default), a second ADD fails.
    if (columns.has(column.name))
      return ifNotExists ? undefined : `ADD of a column already there: ${column.name}`;
    columns.set(column.name, column.facts);
  } else if ((a = DROP_COLUMN.exec(action))) {
    if (!a[1] && !columns.has(a[2])) return missing(a[2]);
    columns.delete(a[2]);
  } else if ((a = RENAME_COLUMN.exec(action))) {
    if (!columns.has(a[1])) return missing(a[1]);
    columns.set(a[2], columns.get(a[1]));
    columns.delete(a[1]);
  } else if ((a = SET_TYPE.exec(action))) {
    if (!columns.has(a[1])) return missing(a[1]);
    columns.get(a[1]).type = columnType(a[2]);
  } else if ((a = SET_DEFAULT.exec(action))) {
    if (!columns.has(a[1])) return missing(a[1]);
    columns.get(a[1]).sessionDefault = defaultDependsOnSession(a[2]);
  } else if ((a = DROP_DEFAULT.exec(action))) {
    if (!columns.has(a[1])) return missing(a[1]);
    columns.get(a[1]).sessionDefault = false;
  } else {
    return `an ALTER TABLE action not modelled: ${action.trim()}`;
  }
  return undefined;
}

/** A routine's name, signature and body, or a refusal: `{refused}`. */
function readRoutine({ tokens, text }) {
  const header = /^CREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+/i.exec(text);
  let i = tokens.findIndex((t, at) => at > 0 && isWord(t, 'function', 'procedure')) + 1;
  if (!header || i === 0) return null;
  if (isOp(tokens[i + 1], '.')) {
    if (nameOf(tokens[i]) !== 'public')
      return { refused: `a routine outside public: ${tokens[i].value}` };
    i += 2;
  }
  const name = nameOf(tokens[i]);
  if (!name || !isOp(tokens[i + 1], '('))
    return { refused: `a routine not read: ${tokens[i]?.value}` };
  const close = closing(tokens, i + 1);
  const language = tokens.findIndex((t, at) => at > close && isWord(t, 'language'));
  const spoken = tokens[language + 1]?.value.replaceAll("'", '').toLowerCase();
  if (language < 0 || !['plpgsql', 'sql'].includes(spoken)) {
    return { refused: `routine ${name} in a language not read: ${spoken}` };
  }
  const as = tokens.findIndex((t, at) => at > close && isWord(t, 'as'));
  const literal = as < 0 ? null : tokens[as + 1];
  let body;
  if (literal?.type === 'string' && literal.value.startsWith('$')) {
    body = literal.value.replace(/^\$\w*\$/, '').replace(/\$\w*\$$/, '');
  } else if (literal?.type === 'string' && literal.value.startsWith("'")) {
    body = literal.value.slice(1, -1).replaceAll("''", "'");
  } else if (as < 0) {
    const standard = tokens.findIndex((t, at) => at > close && isWord(t, 'return', 'begin'));
    if (standard < 0) return { refused: `routine ${name} with no body read` };
    body = text.slice(tokens[standard].start - tokens[0].start);
  } else {
    return { refused: `routine ${name} with a body not read` };
  }
  const signature = tokens.slice(i + 2, close).map((t) => t.value.toLowerCase());
  const end = as < 0 ? tokens.findIndex((t, at) => at > close && isWord(t, 'return', 'begin')) : as;
  const headerTokens = as < 0 ? tokens.slice(0, end) : tokens;
  const moves = (t, at) =>
    isWord(t, 'set') && setMovesNames(headerTokens, at) && !pinsRoutinePath(headerTokens, at + 1);
  if (headerTokens.some(moves))
    return { refused: `a routine setting that may move names: ${name}` };
  return {
    key: `${name}(${signature.join(' ')})`,
    name,
    language: spoken,
    body,
    // Parameters and result: a `timestamp` among them converts a bare clock too.
    header: `${signature.join(' ')} ${tokens
      .slice(close + 1, end)
      .map((t) => t.value)
      .join(' ')}`,
  };
}

/** A statement's text with its strings and quoted names blanked: what is read as SQL words. */
function unquotedText({ tokens, text }) {
  let plain = text;
  for (const t of tokens) {
    if (t.type !== 'string' && (t.type !== 'quoted' || t.unicode)) continue;
    const length = t.type === 'string' ? t.value.length : t.value.replaceAll('"', '""').length + 2;
    const at = t.start - tokens[0].start;
    plain = plain.slice(0, at) + ' '.repeat(length) + plain.slice(at + length);
  }
  return plain;
}

// Validate the complete DDL object names before the replay's patterns can cut them. Read
// [schema.]name from tokens, including IF [NOT] EXISTS and a partition's parent. Unsupported
// schemas or a third component are refused; no regex backtracking can read IF as the name.
function replayNameProblem(tokens) {
  if (!isWord(tokens[0], 'create', 'alter', 'drop')) return null;
  const object = tokens.findIndex((t) =>
    isWord(t, 'table', 'view', 'function', 'procedure', 'routine'),
  );
  const positions = object < 0 ? [] : [object + 1];
  tokens.forEach((t, at) => {
    if (isWord(t, 'partition') && isWord(tokens[at + 1], 'of')) positions.push(at + 2);
  });
  for (let at of positions) {
    if (isWord(tokens[at], 'if')) at += isWord(tokens[at + 1], 'not') ? 3 : 2;
    if (isWord(tokens[at], 'only')) at += 1;
    const name = relationAt(tokens, at, false);
    if (
      !name ||
      name.unreadable ||
      name.dynamic ||
      isOp(tokens[name.end + 1], '.') ||
      (name.schema !== null && name.schema !== 'public')
    )
      return `a DDL name the replay cannot resolve: ${tokens[at]?.value}`;
  }
  return null;
}

/** A CREATE TABLE's columns into `columns`; answers what is not modelled, or undefined. */
function readCreateTable({ tokens, text }, columns) {
  const open = tokens.findIndex((t) => isOp(t, '('));
  const close = closing(tokens, open);
  const base = tokens[0].start;
  const after = tokens[close + 1];
  if (after && !isWord(after, 'partition', 'with')) {
    return `a CREATE TABLE form not modelled: ${text}`;
  }
  for (const part of topLevelParts(
    text.slice(tokens[open].start - base + 1, tokens[close].start - base),
  )) {
    const tokens = lex(part);
    if (isWord(tokens[0], 'like')) return `a CREATE TABLE form not modelled: ${part.trim()}`;
    if (isWord(tokens[0], ...NOT_A_COLUMN)) {
      if (hasBareClock(part)) return `a clock outside a DEFAULT: ${part.trim()}`;
      continue;
    }
    if (tokens.length === 0) continue;
    const column = readColumn(tokens);
    if (column.refused) return column.refused;
    columns.set(column.name, column.facts);
  }
  return undefined;
}

/**
 * Replays migration texts, in order: table -> column -> {type: 'ts'|'tz'|'other',
 * sessionDefault}, each routine's and view's last definition, the tables each trigger routine
 * fires on, and what it could not model.
 */
export function replayMigrations(texts) {
  const tables = new Map();
  const functions = new Map();
  const views = new Map();
  const unmodelled = [];
  const doBlocks = [];
  const triggers = new Map();
  const partitioned = new Set(); // partitions and their parents
  const firstLine = (text) => text.split('\n', 1)[0].slice(0, 100);
  const refuse = (what) => unmodelled.push(what);
  for (const [index, entry] of texts.entries()) {
    const { name: migration = String(index), text: raw } =
      typeof entry === 'string' ? { text: entry } : entry;
    for (const statement of statementsOf(raw)) {
      const { text } = statement;
      let m;
      if (statement.unreadable) {
        refuse(
          `a statement the guard cannot read (unterminated or unbalanced): ${firstLine(text)}`,
        );
        continue;
      }
      // Read as PostgreSQL reads it, or refused (PR #979 r1 F3, F4): a session setting (a
      // routine's body is read where it runs), a quoted name the patterns below would cut
      // (`"lease until"`) or fold (`"PUBLIC".task` is no public table). Their `\w+` reads a name
      // whole only if it is ASCII word characters (r2 F4): a word with `$` (`at$x`), a character
      // outside ASCII (`até`, which the lexer splits) or a U&"…" name is refused, whatever it is.
      const misread = statement.tokens.find(
        (t, i) =>
          (t.type === 'quoted' &&
            (t.unicode ||
              !/^\w+$/.test(t.value) ||
              (isOp(statement.tokens[i + 1], '.') && t.value !== t.value.toLowerCase()))) ||
          (t.type === 'word' && t.value.includes('$')),
      );
      if (sessionChange(statement.tokens)) {
        refuse(`a session setting that may move names: ${firstLine(text)}`);
        continue;
      }
      // One boundary for every statement, before any DDL/ALTER/inert branch can skip it.
      // Expression slots may execute now (TYPE USING) or later (CHECK, policy, trigger, DEFAULT).
      const executor = sqlTextExecutor(statement.tokens);
      if (executor !== null) {
        refuse(`a SQL-text executor in a migration statement: ${executor}: ${firstLine(text)}`);
        continue;
      }
      if (misread) {
        refuse(`a name the replay cannot read whole: ${misread.value}`);
        continue;
      }
      // Outside its strings and quoted names (blanked), PostgreSQL reads a non-ASCII character
      // (U+00A0 too, which the lexer and `\s` take for a space) as part of a name.
      if ([...unquotedText(statement)].some((c) => c.codePointAt(0) > 0x7f)) {
        refuse(`a name the replay cannot read whole (not ASCII): ${firstLine(text)}`);
        continue;
      }
      if (unmodelledExtension(statement.tokens)) {
        refuse(`an extension the guard cannot model: ${firstLine(text)}`);
        continue;
      }
      const creation = relationCreationProblem(statement.tokens);
      if (creation) {
        refuse(creation);
        continue;
      }
      const nameProblem = replayNameProblem(statement.tokens);
      if (nameProblem) {
        refuse(nameProblem);
        continue;
      }
      const routine = readRoutine(statement);
      if (routine?.refused) {
        refuse(routine.refused);
      } else if (routine) {
        // A second CREATE (no OR REPLACE) of a known name is another schema's: not modelled.
        if (functions.has(routine.key) && !/^CREATE\s+OR\s+REPLACE\b/i.test(text))
          refuse(`a second CREATE of routine ${routine.key}`);
        else functions.set(routine.key, routine);
      } else if ((m = VIEW.exec(text))) {
        if (views.has(m[1]) && !/^CREATE\s+OR\s+REPLACE\b/i.test(text))
          refuse(`a second CREATE of view ${m[1]}`);
        else views.set(m[1], { name: m[1], body: text, header: '' });
      } else if ((m = DROP_VIEW.exec(text))) {
        views.delete(m[1]);
      } else if ((m = PARTITION_OF.exec(text))) {
        if (/\bIF\s+NOT\s+EXISTS\b/i.test(m[0]) && tables.has(m[1])) continue;
        if (tables.has(m[1])) {
          refuse(`a second CREATE of table ${m[1]}`);
          continue;
        }
        if (!tables.has(m[2])) {
          refuse(`PARTITION OF unknown table ${m[2]}`);
          continue;
        }
        // A partition has its parent's columns, in a map of its own. Its own defaults, and an
        // ALTER of a column on either side, are not modelled: refused (PR #906 r2 F2).
        tables.set(m[1], new Map([...tables.get(m[2])].map(([c, facts]) => [c, { ...facts }])));
        partitioned.add(m[1]).add(m[2]);
        const rest = statement.tokens.find(
          (t) => t.start - statement.tokens[0].start >= m[0].length,
        );
        if (isOp(rest, '(')) refuse(`partition column options not modelled: ${firstLine(text)}`);
      } else if ((m = CREATE_TABLE.exec(text))) {
        if (/\bIF\s+NOT\s+EXISTS\b/i.test(text.slice(0, m[0].length)) && tables.has(m[1])) continue;
        // PostgreSQL refuses a second CREATE of a name in one schema: another schema's (F3).
        if (tables.has(m[1])) {
          refuse(`a second CREATE of table ${m[1]}`);
          continue;
        }
        const columns = new Map();
        tables.set(m[1], columns);
        const problem = readCreateTable(statement, columns);
        if (problem) refuse(problem);
      } else if ((m = DROP_TABLE.exec(text))) {
        const list = text.replace(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?/i, '');
        for (const item of list.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '').split(',')) {
          const name = /^\s*(?:"?public"?\.)?"?(\w+)"?\s*$/.exec(item)?.[1];
          if (name) tables.delete(name);
          else refuse(`a DROP TABLE not read: ${firstLine(text)}`);
        }
      } else if ((m = DROP_ROUTINE.exec(text))) {
        for (const [key, known] of functions) {
          const signature = m[2] && lex(m[2].slice(1, -1)).map((t) => t.value.toLowerCase());
          if (known.name === m[1] && (!signature || key === `${m[1]}(${signature.join(' ')})`)) {
            functions.delete(key);
          }
        }
      } else if ((m = RENAME_TABLE.exec(text))) {
        const [, , from, to] = m;
        if (!tables.has(from) || partitioned.has(from)) {
          refuse(`RENAME of a table not modelled: ${from}`);
          continue;
        }
        tables.set(to, tables.get(from));
        tables.delete(from);
        for (const [fn, on] of triggers)
          triggers.set(
            fn,
            on.map((t) => (t === from ? to : t)),
          );
      } else if ((m = ALTER_ACTIONS.exec(text))) {
        const [, , table, actions] = m;
        if (!tables.has(table)) {
          refuse(`ALTER of unknown table ${table}`);
          continue;
        }
        for (const action of topLevelParts(actions)) {
          const inert = INERT_ALTER_ACTION.test(action) && !hasBareClock(action);
          const problem =
            partitioned.has(table) && !inert
              ? `a column ALTER in a partition tree is not modelled: ${action.trim()}`
              : applyAlterAction(tables.get(table), action);
          if (problem) refuse(`${table}: ${problem}`);
        }
      } else if (isWord(statement.tokens[0], 'do')) {
        // Its body read from its tokens: DDL, EXECUTE (format() included) or SQL in one of its
        // strings (a job it schedules, PR #979 r2 F1) goes to review.
        const at = statement.tokens.findIndex((t) => t.type === 'string');
        const language = statement.tokens.findIndex((t) => isWord(t, 'language'));
        const bodies = at < 0 ? null : stringValues(statement.tokens, at)?.map((v) => lex(v));
        if (
          !bodies ||
          bodies.some((tokens) => tokens.some((t) => t.unterminated)) ||
          (language >= 0 && !isWord(statement.tokens[language + 1], 'plpgsql'))
        ) {
          refuse(`a DO block not read: ${firstLine(text)}`);
        } else if (bodies.some((tokens) => relationCreationProblem(tokens, true))) {
          refuse(`a temporary definition in a DO block: ${firstLine(text)}`);
        } else if (bodies.some(sessionChange)) {
          refuse(`a session setting that may move names: ${firstLine(text)}`);
        } else if (
          bodies.some(
            (tokens) =>
              ddlIn(tokens) || tokens.some((t, i) => t.type === 'string' && holdsSql(tokens, i)),
          )
        ) {
          doBlocks.push({ head: firstLine(text), body: statement.tokens[at].value, migration });
        }
      } else if (INERT_HEADS.test(text)) {
        if (CREATE_TRIGGER.test(text)) {
          m = TRIGGER_BINDING.exec(text);
          const [, schema, table, fnSchema, fn] = m ?? [];
          const inPublic = (name) => name === undefined || name.toLowerCase() === 'public';
          if (
            !m ||
            !inPublic(schema) ||
            !inPublic(fnSchema) ||
            !(tables.has(table) || views.has(table))
          ) {
            refuse(`a trigger binding not modelled: ${firstLine(text)}`);
          } else {
            const routine = fn.toLowerCase(); // as routine names are read: folded
            triggers.set(routine, [...new Set([...(triggers.get(routine) ?? []), table])]);
          }
        }
        if (hasBareClock(text)) refuse(`a clock in a definition not modelled: ${firstLine(text)}`);
        if (
          /^(?:CREATE|ALTER)\s+TYPE\b/i.test(text) &&
          statement.tokens.some((_, i) => typeAt(statement.tokens, i).kind === 'ts')
        ) {
          refuse(`a timestamp field in a type not modelled: ${firstLine(text)}`);
        }
      } else if (!ONE_SHOT_HEADS.test(text)) {
        refuse(`a migration statement not modelled: ${firstLine(text)}`);
      } else if (
        statement.tokens.some((t, i) => t.type === 'string' && holdsSql(statement.tokens, i))
      ) {
        // SQL text may run now through an executor or later as a scheduled job: not read.
        refuse(`SQL text in a one-shot statement: ${firstLine(text)}`);
      }
    }
  }
  return { tables, functions, views, unmodelled, doBlocks, triggers };
}

// Catalogue relations production SQL reads: none has a `timestamp` column. Any other name,
// `pg_` or not, must be a replayed table (PR #906 r2 F2: `pg_missing`).
const CATALOGUE = new Set(
  'pg_class pg_namespace pg_roles pg_database pg_db_role_setting pg_locks pg_stat_activity pg_trigger pg_tables pg_stats pg_inherits pg_depend pg_settings pg_attribute pg_proc pg_index pg_constraint pg_type pg_auth_members pg_stat_user_tables'.split(
    ' ',
  ),
);
// Where a FROM list ends; up to there each comma at its depth starts another relation.
const FROM_END = new Set(
  'where group having order limit offset fetch window union intersect except returning for loop then else end when into select values do conflict'.split(
    ' ',
  ),
);
const ALIAS_STOP = new Set([
  ...FROM_END,
  ...'set default overriding natural tablesample using join left right inner full cross outer lateral on as'.split(
    ' ',
  ),
]);
// `update` after these is no UPDATE statement: FOR [NO KEY] UPDATE, BEFORE/AFTER/OR UPDATE, ON
// UPDATE, GRANT UPDATE. And `UPDATE SET` is the action of ON CONFLICT or MERGE.
const NOT_AN_UPDATE = new Set(['for', 'key', 'before', 'after', 'or', 'on', 'grant']);

/**
 * The relation at tokens[j]: `[ONLY|LATERAL] [(] [schema.]name [)]` -> {schema, table, end},
 * {dynamic}, {unreadable} (refused by the caller), or null: a subquery or a call (`call`), whose
 * own relations are read where they stand.
 */
function relationAt(tokens, j, call = true) {
  const at = isWord(tokens[j], 'only', 'lateral') ? j + 1 : j;
  const t = tokens[at];
  if (isOp(t, '(')) {
    if (isWord(tokens[at + 1], 'select', 'with', 'values')) return null;
    const inner = relationAt(tokens, at + 1, call);
    return inner && isOp(tokens[inner.end + 1], ')') ? { ...inner, end: inner.end + 1 } : inner;
  }
  if (t?.type === 'placeholder' && !isOp(tokens[at + 1], '.')) return { dynamic: true, end: at };
  // A quoted name keeps its case (PR #979 r1 F3): `"PUBLIC".t`, `"Task"` are other relations.
  const relationName = (u) => (u?.type === 'quoted' ? u.value : nameOf(u));
  const first = t?.type === 'placeholder' ? null : relationName(t);
  if (first === null && t?.type !== 'placeholder') return { unreadable: true, end: at };
  let [schema, table, end] = [null, first, at];
  if (isOp(tokens[at + 1], '.')) {
    if (tokens[at + 2]?.type === 'placeholder') return { dynamic: true, end: at + 2 };
    // `${schema}.table`: only the schema is spliced.
    [schema, table, end] = [first, relationName(tokens[at + 2]), at + 2];
    if (table === null) return { unreadable: true, end };
  }
  // A set-returning call: its columns are not typed here, so it is unresolved, never skipped.
  if (call && isOp(tokens[end + 1], '(')) return { unreadable: true, table: `${table}()`, end };
  return { schema, table, end };
}

/** The index after a relation's `*` and alias. */
function afterAlias(tokens, k) {
  let at = isOp(tokens[k], '*') ? k + 1 : k;
  const t = tokens[at];
  if (isWord(t, 'as')) at += 2;
  else if (t?.type === 'quoted' || (t?.type === 'word' && !ALIAS_STOP.has(t.lower))) at += 1;
  return at;
}

/** The index ending the statement or subquery tokens[i] stands in: its `)` or `;`, or the end. */
function scopeEnd(tokens, i) {
  for (let k = i, depth = 0; k < tokens.length; k += 1) {
    if (isOp(tokens[k], '(')) depth += 1;
    else if (isOp(tokens[k], ')') && (depth -= 1) < 0) return k;
    else if (depth === 0 && isOp(tokens[k], ';')) return k;
  }
  return tokens.length;
}

/**
 * WITH names and where each is seen (PR #979 r1 F2), read by the grammar `WITH [RECURSIVE] name
 * [(columns)] AS [[NOT] MATERIALIZED] (…) [, …]` (a WINDOW definition is none): from the end of
 * its own body (from its body, if RECURSIVE) to the end of the statement or subquery it heads.
 */
function cteScopes(tokens) {
  const scopes = [];
  tokens.forEach((t, i) => {
    if (!isWord(t, 'with')) return;
    const recursive = isWord(tokens[i + 1], 'recursive');
    const to = scopeEnd(tokens, i);
    for (let k = recursive ? i + 2 : i + 1; nameOf(tokens[k]) !== null;) {
      let j = isOp(tokens[k + 1], '(') ? closing(tokens, k + 1) + 1 : k + 1;
      if (!isWord(tokens[j], 'as')) break;
      j += isWord(tokens[j + 1], 'not') ? 3 : isWord(tokens[j + 1], 'materialized') ? 2 : 1;
      if (!isOp(tokens[j], '(')) break;
      const body = closing(tokens, j);
      const name = tokens[k].type === 'quoted' ? tokens[k].value : nameOf(tokens[k]);
      scopes.push({ name, from: recursive ? j : body, to });
      if (!isOp(tokens[body + 1], ',')) break;
      k = body + 2;
    }
  });
  return scopes;
}

/**
 * Every relation a text reads or writes, by an explicit grammar: FROM lists (each comma), JOIN,
 * DELETE … USING, INSERT/MERGE INTO and UPDATE targets. A target it cannot read is `unreadable`,
 * never skipped (PR #906 r2 F2: `UPDATE ONLY (task)`, `FROM a, task`).
 */
export function relationsIn(tokens) {
  const scopes = cteScopes(tokens);
  const refs = [];
  const writes = [];
  const read = (j, keyword, call) => {
    const rel = relationAt(tokens, j, call);
    const cte =
      keyword !== 'update' &&
      keyword !== 'delete' &&
      rel?.schema === null &&
      scopes.some(({ name, from, to }) => name === rel.table && from < j && j <= to);
    if (rel) refs.push({ ...rel, keyword, cte });
    return rel;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (isWord(t, 'join')) read(i + 1, 'join');
    else if (isWord(t, 'from') && !isWord(tokens[i - 1], 'distinct') && !insideCall(tokens, i)) {
      read(i + 1, isWord(tokens[i - 1], 'delete') ? 'delete' : 'from');
      for (let k = i + 1, depth = 0; k < tokens.length; k += 1) {
        const u = tokens[k];
        if (isOp(u, '(')) depth += 1;
        else if (isOp(u, ')') && (depth -= 1) < 0) break;
        else if (depth > 0) continue;
        else if (isOp(u, ';') || (u.type === 'word' && FROM_END.has(u.lower))) break;
        else if (isOp(u, ',') || (isWord(u, 'using') && isWord(tokens[i - 1], 'delete'))) {
          read(k + 1, 'from');
        }
      }
    } else if (isWord(t, 'insert', 'merge') && isWord(tokens[i + 1], 'into')) {
      const rel = read(i + 2, t.lower, false) ?? { unreadable: true, end: i + 2 };
      const k = afterAlias(tokens, rel.end + 1);
      let listed = null;
      if (isOp(tokens[k], '(') && !isWord(tokens[k + 1], 'select', 'with', 'values')) {
        listed = new Set(
          tokens
            .slice(k + 1, closing(tokens, k))
            .map(nameOf)
            .filter(Boolean),
        );
      }
      writes.push({ kind: t.lower, ...rel, listed });
    } else if (
      isWord(t, 'update') &&
      !(tokens[i - 1]?.type === 'word' && NOT_AN_UPDATE.has(tokens[i - 1].lower)) &&
      !isWord(tokens[i + 1], 'set')
    ) {
      const rel = read(i + 1, 'update', true) ?? { unreadable: true, end: i + 1 };
      const set = isWord(tokens[afterAlias(tokens, rel.end + 1)], 'set');
      writes.push(set ? { kind: 'update', ...rel } : { kind: 'update', unreadable: true });
    }
  }
  return { refs, writes };
}

/** How a relation resolves: 'table', 'catalogue', 'cte', 'dynamic', or unresolved (refused). */
function resolution(ref, tables) {
  if (ref.dynamic) return 'dynamic';
  if (ref.unreadable) return 'unresolved';
  if (ref.cte) return 'cte';
  if ((ref.schema ?? 'pg_catalog') === 'pg_catalog' && CATALOGUE.has(ref.table)) return 'catalogue';
  if (ref.schema === 'information_schema') return 'catalogue';
  if ((ref.schema ?? 'public') === 'public' && tables.has(ref.table)) return 'table';
  return 'unresolved';
}

/**
 * The tokens of a text that may not lex (a literal of production source is often prose: "the
 * caller's roles"): a string that runs off the end is read both ways, as a string up to the end
 * (`'now` may close in the next literal) and as one character with the rest lexed again, so
 * nothing after it hides from the rules.
 */
function lexAll(text) {
  const tokens = [];
  for (let rest = stripComments(text); ;) {
    const part = lex(rest);
    const stray = part.findIndex((t) => t.unterminated);
    if (stray < 0) return [...tokens, ...part];
    const { start, type, value } = part[stray];
    const close = /^\$\w*\$/.exec(value)?.[0] ?? "'";
    const closed = `${rest.slice(start)}${close}`;
    tokens.push(...part.slice(0, stray));
    if (type === 'string') tokens.push({ type, value: closed, lower: closed.toLowerCase(), start });
    else tokens.push({ type: 'op', value: rest[start], lower: rest[start], start });
    rest = ' '.repeat(start + 1) + stripComments(rest.slice(start + 1));
  }
}

// Settings that move no name to another schema; any other may (search_path, SCHEMA, ROLE and
// SESSION AUTHORIZATION through "$user", RESET ALL). A custom `a.b` setting moves none.
const KEEPS_NAMES = new Set(
  'lock_timeout statement_timeout idle_in_transaction_session_timeout enable_sort constraints time timezone transaction names seed xml'.split(
    ' ',
  ),
);
const keepsNames = (tokens, k) => KEEPS_NAMES.has(nameOf(tokens[k])) || isOp(tokens[k + 1], '.');
const spliced = (t) => t?.type === 'placeholder' || t?.type === 'param';

/**
 * Whether the SET or RESET at tokens[i] may move names, read by PostgreSQL's grammar (PR #979 r2
 * F1): SET ROLE, SCHEMA, [LOCAL] SESSION AUTHORIZATION, RESET ALL, `name {TO|=|FROM}` / `RESET
 * name` of a setting not listed, or a spliced name. A text PostgreSQL would reject as a statement
 * (prose: `Set to 1 for each …`, `reset the database`) moves nothing.
 */
function setMovesNames(tokens, i) {
  const reset = isWord(tokens[i], 'reset');
  let k = i + 1;
  const scoped =
    isWord(tokens[k], 'local') ||
    (isWord(tokens[k], 'session') && !isWord(tokens[k + 1], 'authorization', 'characteristics'));
  if (scoped) k += 1;
  if (isWord(tokens[k], 'session') && isWord(tokens[k + 1], 'authorization')) return true;
  if (isWord(tokens[k], 'role', 'schema', 'catalog', ...(reset ? ['all'] : []))) return true;
  if (spliced(tokens[k]) || (isOp(tokens[k + 1], '.') && spliced(tokens[k + 2]))) return true;
  if (nameOf(tokens[k]) === null) return false; // `SET;`, `set-criteria`: no statement
  const after = tokens[isOp(tokens[k + 1], '.') ? k + 3 : k + 1];
  const statement = reset
    ? after === undefined || isOp(after, ';')
    : isWord(after, 'to', 'from') || isOp(after, '=') || spliced(after);
  return statement && !keepsNames(tokens, k);
}

/**
 * A session setting the guard cannot prove moves no name (PR #979 r1 F3): a SET or RESET at a
 * statement's head, a set_config() of a setting not named by a listed literal, search_path
 * named anywhere. Each may move every unqualified name to another schema. (SQL in a string is
 * refused as such; a DO body is read here too.)
 */
function sessionChange(tokens) {
  return tokens.some((t, i) => {
    const head = startsStatement(tokens, i);
    if (
      head &&
      isWord(t, 'discard') &&
      isWord(tokens[i + 1], 'all', 'plans', 'sequences', 'temp', 'temporary')
    )
      return true;
    if (head && isWord(t, 'set', 'reset')) return setMovesNames(tokens, i);
    const targetAt =
      isWord(t, 'update') && !NOT_AN_UPDATE.has(nameOf(tokens[i - 1]))
        ? i + 1
        : (isWord(t, 'insert', 'merge') && isWord(tokens[i + 1], 'into')) ||
            (isWord(t, 'delete') && isWord(tokens[i + 1], 'from'))
          ? i + 2
          : null;
    if (targetAt !== null) {
      const target = relationAt(tokens, targetAt, false);
      if (target?.table === 'pg_settings') return true;
    }
    if (nameOf(t) === 'set_config' && isOp(tokens[i + 1], '(')) {
      const setting =
        tokens[i + 2]?.type === 'string' && isOp(tokens[i + 3], ',') && stringValues(tokens, i + 2);
      return (
        !setting || !setting.every((v) => KEEPS_NAMES.has(v.toLowerCase()) || /^\w+\.\w+$/.test(v))
      );
    }
    // `ALTER … SET search_path`, a routine's SET clause (but the FU-266 pin)
    return nameOf(t) === 'search_path' && !pinsRoutinePath(tokens, i);
  });
}

/**
 * FU-266: a CREATE [OR REPLACE] FUNCTION/PROCEDURE's own `SET search_path {=|TO} pg_catalog,
 * pg_temp`, exactly, at tokens[i]. Its body then reads names from the catalogue and temporary
 * relations last, never from a schema a migration made, so it moves no name into one.
 */
function pinsRoutinePath(tokens, i) {
  const routine = isWord(tokens[1], 'or') && isWord(tokens[2], 'replace') ? 3 : 1;
  return (
    isWord(tokens[0], 'create') &&
    isWord(tokens[routine], 'function', 'procedure') &&
    isWord(tokens[i - 1], 'set') &&
    (isWord(tokens[i + 1], 'to') || isOp(tokens[i + 1], '=')) &&
    isWord(tokens[i + 2], 'pg_catalog') &&
    isOp(tokens[i + 3], ',') &&
    isWord(tokens[i + 4], 'pg_temp') &&
    !isOp(tokens[i + 5], ',') &&
    !isOp(tokens[i + 5], '.')
  );
}

// One reader for SQL and PL/pgSQL statement starts, shared by strings and session settings.
// The lexer reads a label's closing `>>` as two operators.
const startsStatement = (tokens, i) =>
  i === 0 ||
  isOp(tokens[i - 1], ';') ||
  isWord(tokens[i - 1], 'begin', 'then', 'else', 'loop', 'declare') ||
  (isOp(tokens[i - 2], '>') && isOp(tokens[i - 1], '>')) ||
  (isWord(tokens[i - 2], 'return') && isWord(tokens[i - 1], 'query'));

// A statement begins with one of these at a start the reader recognises.
const STATEMENT_HEADS = new Set(
  'select insert update delete merge with values table create alter drop truncate do execute call set reset copy prepare begin start explain declare perform discard import'.split(
    ' ',
  ),
);
/** Whether tokens[i] heads a statement, including labeled and DECLARE/BEGIN bodies. */
const headsStatement = (tokens, i) =>
  startsStatement(tokens, i) &&
  STATEMENT_HEADS.has(tokens[i]?.type === 'word' && tokens[i].lower) &&
  i + 1 < tokens.length;

/**
 * The values the string at tokens[i] may hold, joined with the literals it is concatenated with
 * (PR #979 r2 F1: `'INS' || 'ERT INTO …'`): each `||` chain read as one value. Null: unreadable.
 */
function chainValues(tokens, i) {
  let [from, to] = [i, i];
  while (isOp(tokens[from - 1], '||') && tokens[from - 2]?.type === 'string') from -= 2;
  while (isOp(tokens[to + 1], '||') && tokens[to + 2]?.type === 'string') to += 2;
  let joined = [''];
  for (let k = from; k <= to; k += 2) {
    const values = stringValues(tokens, k);
    if (!values) return null;
    joined = [...new Set(joined.flatMap((head) => values.map((value) => head + value)))];
  }
  return joined;
}

// Installing an executor invalidates literal analysis, even when its SQL has no clock words.
function unmodelledExtension(tokens, i = 0) {
  if (!isWord(tokens[i], 'create') || !isWord(tokens[i + 1], 'extension')) return false;
  let at = i + 2;
  if (isWord(tokens[at], 'if') && isWord(tokens[at + 1], 'not') && isWord(tokens[at + 2], 'exists'))
    at += 3;
  return (
    !['btree_gist', 'pg_trgm'].includes(tokens[at]?.value) ||
    (tokens[at + 1] !== undefined && !isOp(tokens[at + 1], ';'))
  );
}

// Calls proven to consume values, never execute them as SQL. An unlisted call receiving a
// string may execute an opaque expression built from it: do not try to evaluate fragments.
const VALUE_CALLS = new Set(
  'timezone date_trunc to_char lower upper coalesce nullif concat concat_ws format chr length octet_length convert_to encode decode substring replace hashtextextended pg_advisory_xact_lock set_config current_setting nextval has_table_privilege has_sequence_privilege extract date_bin min max sum bool_and strpos jsonb_build_object jsonb_populate_record hashtext translate string_agg int4send digest regexp_replace trim btrim count array_agg json_build_object json_agg pg_has_role has_database_privilege has_schema_privilege pg_try_advisory_xact_lock sha256 unnest tsrange greatest least'.split(
    ' ',
  ),
);

// These calls execute SQL text: its input may come from a parameter, a CTE, a subquery,
// VALUES, or a variable assigned elsewhere in the body. Lexical argument inspection cannot
// prove any of those safe. Refuse the call even without a string; quoted/qualified names too.
const SQL_TEXT_EXECUTORS = new Set([
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'ts_stat',
  'ts_rewrite', // both overloads refused; no argument-type inference
]);
function sqlTextExecutor(tokens) {
  const executor = tokens.find((t, i) => {
    const name = nameOf(t);
    return (
      name !== null &&
      isOp(tokens[i + 1], '(') &&
      (SQL_TEXT_EXECUTORS.has(name) ||
        /^(?:dblink|pg_background_)/.test(name) ||
        (isOp(tokens[i - 1], '.') && nameOf(tokens[i - 2]) === 'cron'))
    );
  });
  return executor?.value ?? null;
}

function opaqueStringCall(tokens, i) {
  for (let at = enclosing(tokens, i); at >= 0; at = enclosing(tokens, at)) {
    const before = tokens[at - 1];
    const qualified = isOp(tokens[at - 2], '.');
    if (
      nameOf(before) === null ||
      (!qualified &&
        before.type === 'word' &&
        (isGrouping(before) || isWord(before, 'as', 'materialized', 'lateral', 'array', 'filter')))
    )
      continue;
    if (
      !VALUE_CALLS.has(nameOf(before)) ||
      (before.type === 'quoted' && before.value !== before.lower) ||
      (qualified && (tokens[at - 3]?.value !== 'pg_catalog' || isOp(tokens[at - 4], '.')))
    )
      return before.value;
  }
  return null;
}

/**
 * Whether the string at tokens[i] holds SQL (PR #979 r2 F1): a statement starts anywhere in its
 * value (including PL/pgSQL labels and blocks), or it holds a clock/executor call.
 * Prose heads no statement. All string entry points use this reader.
 */
function holdsSql(tokens, i) {
  if (opaqueStringCall(tokens, i)) return true;
  const values = chainValues(tokens, i);
  if (values === null) return true;
  return values.some((value) => {
    const inner = lex(value); // prose is no SQL: `the signer's` lexes, but heads no statement
    return (
      inner.some((_, k) => headsStatement(inner, k)) ||
      sqlTextExecutor(inner) !== null ||
      clocksIn(inner).some((c) => inner[c.index].type !== 'string')
    );
  });
}

/** The start of the statement/query containing tokens[i], skipping completed parentheses. */
function statementStart(tokens, i) {
  let at = i;
  for (let k = i - 1, depth = 0; k >= 0; k -= 1) {
    if (isOp(tokens[k], ')')) depth += 1;
    else if (isOp(tokens[k], '(') && depth-- === 0) break;
    // BEGIN/LOOP can be SQL column names, so PL/pgSQL start heuristics are not proof here.
    if (depth === 0 && isOp(tokens[k], ';')) break;
    at = k;
  }
  return at;
}

/** Prove INSERT/MERGE heads this query; a label `AS insert INTO` is no exception. */
function writeInto(tokens, i) {
  if (!isWord(tokens[i - 1], 'insert', 'merge')) return false;
  let at = statementStart(tokens, i - 1);
  if (isWord(tokens[at], 'explain')) {
    at += 1;
    if (isOp(tokens[at], '(')) at = closing(tokens, at) + 1;
    else while (isWord(tokens[at], 'analyze', 'verbose')) at += 1;
  }
  if (isWord(tokens[at], 'with')) {
    at += isWord(tokens[at + 1], 'recursive') ? 2 : 1;
    for (;;) {
      if (nameOf(tokens[at]) === null) return false;
      at = isOp(tokens[at + 1], '(') ? closing(tokens, at + 1) + 1 : at + 1;
      if (!isWord(tokens[at], 'as')) return false;
      at += isWord(tokens[at + 1], 'not') ? 3 : isWord(tokens[at + 1], 'materialized') ? 2 : 1;
      if (!isOp(tokens[at], '(')) return false;
      at = closing(tokens, at) + 1;
      if (!isOp(tokens[at], ',')) break;
      at += 1;
    }
  }
  return at === i - 1;
}

/**
 * Session-local definitions are never replayed. Inspect tokens, not SQL-looking data, and
 * refuse the whole CREATE statement if any temporary schema occurs: its object grammar need
 * not be known. SELECT INTO has no replayed column facts, even when its target is permanent.
 * Only an explicit LANGUAGE plpgsql routine (or a PL/pgSQL DO) can assign INTO variables.
 */
function relationCreationProblem(tokens, plpgsql = false) {
  // Production inventory also includes prose ("signed into its token"). Every SQL creation
  // INTO has SELECT/IMPORT; other recognised SQL statements still default to refusal.
  const sql = tokens.some(
    (t, i) =>
      (headsStatement(tokens, i) && !isWord(t, 'with')) ||
      isWord(t, 'select', 'insert', 'merge', 'update', 'delete', 'import'),
  );
  for (const [i, t] of tokens.entries()) {
    if (isWord(t, 'create')) {
      // CREATE in a privilege list names no target. No other unrecognised prefix exempts it.
      const privilege = isWord(tokens[i + 1], 'on') || isOp(tokens[i + 1], ',');
      let at = i + 1;
      // Modifiers precede the object kind; never inspect column names as modifiers. Unknown
      // object kinds after TEMP are refused too, rather than enumerating table/view/sequence.
      while (
        isWord(
          tokens[at],
          'or',
          'replace',
          'global',
          'local',
          'unlogged',
          'recursive',
          'materialized',
          'unique',
          'constraint',
        )
      )
        at += 1;
      if (isWord(tokens[at], 'temp', 'temporary'))
        return 'a temporary object that may shadow a replayed relation';
      let header = true;
      for (let k = at; k < tokens.length && !isOp(tokens[k], ';'); k += 1) {
        if (isOp(tokens[k], '(') || isWord(tokens[k], 'as')) header = false;
        if (header && !privilege && spliced(tokens[k]))
          return 'a CREATE target the guard cannot classify';
        if (/^pg_temp(?:_[0-9]+)?$/.test(nameOf(tokens[k]) ?? '') && isOp(tokens[k + 1], '.'))
          return 'a CREATE using a temporary schema that may shadow a replayed relation';
      }
    }
    // INTO is reserved: outside proven writes or PL/pgSQL variables, unknown means refuse.
    if (sql && isWord(t, 'into') && !writeInto(tokens, i)) {
      if (
        !plpgsql ||
        isWord(tokens[i + 1], 'temp', 'temporary', 'unlogged', 'table') ||
        (/^pg_temp(?:_[0-9]+)?$/.test(nameOf(tokens[i + 1]) ?? '') && isOp(tokens[i + 2], '.'))
      )
        return 'an INTO whose created relation is not replayed';
    }
  }
  return null;
}

/**
 * What the guard cannot read in a text, or null (PR #979 r1 F1): it is refused, never read as
 * absent. A U& identifier with UESCAPE, a string it cannot decode, SQL inside a string (DO $$…$$,
 * EXECUTE '…', a scheduled job), a DO or EXECUTE statement, and a search_path change.
 */
function unreadableIn(tokens, plpgsql = false) {
  const creation = relationCreationProblem(tokens, plpgsql);
  if (creation) return creation;
  const executor = sqlTextExecutor(tokens);
  if (executor !== null) return `a SQL-text executor: ${executor}`;
  for (const [i, t] of tokens.entries()) {
    if (t.unreadable) return 'a U&"…" identifier with UESCAPE';
    if (unmodelledExtension(tokens, i)) return 'an extension the guard cannot model';
    const object = isWord(tokens[i + 1], 'or') && isWord(tokens[i + 2], 'replace') ? i + 3 : i + 1;
    if (isWord(t, 'create') && isWord(tokens[object], 'function', 'procedure', 'routine'))
      return 'routine-defining DDL in production SQL';
    if (headsStatement(tokens, i) && isWord(t, 'do', 'execute')) return `a ${t.lower} statement`;
    if (t.type !== 'string') continue;
    if (!stringValues(tokens, i)) return `a string: ${t.value}`;
    if (holdsSql(tokens, i)) return `SQL in a string: ${t.value.slice(0, 60)}`;
  }
  return sessionChange(tokens) ? 'a session setting that may move names' : null;
}

/**
 * Tables named anywhere, not only in FROM (PR #979 r1, r2 F2: `NULL::public.task`,
 * `NULL::"Task2"`): each `[schema.]name` read as relationAt reads it, folded and with a quoted
 * name's case, so both spellings count. A known table in another schema (`pg_temp.task`, or an
 * alias's column named like a table), or a type of another schema (`::`, CAST … AS), is `elsewhere`:
 * unresolved, so refused.
 */
function namesOutsideFrom(tokens, tables) {
  const [mentioned, elsewhere] = [[], []];
  const spellings = (t) => [...new Set([nameOf(t), t.type === 'quoted' ? t.value : null])];
  const known = (t) => (nameOf(t) === null ? [] : spellings(t).filter((n) => tables.has(n)));
  // A type position: after `::`, or after AS in CAST(… AS type).
  const typed = (i) =>
    isOp(tokens[i - 1], '::') ||
    (isWord(tokens[i - 1], 'as') && nameOf(tokens[enclosing(tokens, i) - 1]) === 'cast');
  tokens.forEach((t, i) => {
    if (isOp(tokens[i - 1], '.') || nameOf(t) === null) return;
    for (const table of known(t)) mentioned.push({ table });
    const name = isOp(tokens[i + 1], '.') ? tokens[i + 2] : null;
    if (!name || nameOf(name) === null) return;
    const schema = t.type === 'quoted' ? t.value : nameOf(t);
    if (schema === 'public') for (const table of known(name)) mentioned.push({ table });
    else if (known(name).length > 0 || (typed(i) && schema !== 'pg_catalog'))
      elsewhere.push({ schema, table: name.value });
  });
  return { mentioned, elsewhere };
}

/**
 * What is wrong with one SQL text, given table -> columns. `tables` is every table
 * this text may mean (one service's, or every service's for a shared package).
 */
export function problemsIn(text, tables, { plpgsql = false } = {}) {
  const tokens = lexAll(text);
  const unreadable = unreadableIn(tokens, plpgsql);
  if (unreadable) return [`R0 what the guard cannot read: ${unreadable}`];
  const problems = [];
  const clocks = clocksIn(tokens);
  const { refs, writes } = relationsIn(tokens);
  const kinds = refs.map((ref) => resolution(ref, tables));
  const named = refs.filter((_, i) => kinds[i] === 'table' || kinds[i] === 'catalogue');
  const unresolved = refs.filter((_, i) => kinds[i] === 'unresolved');
  const words = new Set(tokens.map(nameOf).filter(Boolean));
  const bare = clocks.filter((clock) => !clock.utc);
  // `$1::timestamp <= now()`, `AS r(at timestamp)`: the comparison goes through the session too.
  const typed = tokens.findIndex(
    (t, i) => !isOp(tokens[i - 1], '.') && typeAt(tokens, i).kind === 'ts',
  );
  if (bare.length > 0 && typed >= 0) {
    problems.push(`R4 a timestamp type beside a bare ${bare[0].name}: ${tokens[typed].value}`);
  }
  if (bare.length > 0) {
    const reading =
      tokens[0]?.lower === 'select' &&
      clocks.length === 1 &&
      refs.length === 0 &&
      CALLS.has(nameOf(tokens[1])) &&
      tokens.at(-2)?.lower === 'as' &&
      // Nothing between the clock and AS but a cast to timestamptz.
      /^(?:::timestamptz(?:\(\d\))?)?$/i.test(
        tokens
          .slice(4, -2)
          .map((t) => t.value)
          .join(''),
      );
    const positional = writes.some((write) => write.kind === 'insert' && !write.listed);
    const { mentioned, elsewhere } = namesOutsideFrom(tokens, tables);
    unresolved.push(...elsewhere);
    const columns = [...named, ...mentioned].flatMap((ref) =>
      (tables.get(ref.table) ?? []).flatMap((columnsOfTable) =>
        [...columnsOfTable]
          .filter(
            ([column, facts]) =>
              facts.type === 'ts' && (words.has(column.toLowerCase()) || positional),
          )
          .map(([column]) => `${ref.table}.${column}`),
      ),
    );
    if (columns.length > 0) {
      problems.push(
        `R1 bare ${bare[0].name} beside timestamp(3) ${[...new Set(columns)].join(', ')}`,
      );
    } else if (refs.some((ref) => ref.dynamic)) {
      problems.push(`R1 bare ${bare[0].name} on a spliced table`);
    } else if (unresolved.length > 0) {
      const what = unresolved[0].table
        ? [unresolved[0].schema, unresolved[0].table]
        : ['(unreadable)'];
      problems.push(
        `R1 bare ${bare[0].name} on unresolved table ${what.filter(Boolean).join('.')}`,
      );
    } else if (named.length === 0 && !reading) {
      problems.push(`R3 bare ${bare[0].name} in a fragment naming no table`);
    }
  }
  const explicitDefault = tokens.some(
    (t, i) => isWord(t, 'default') && !isWord(tokens[i + 1], 'values'),
  );
  for (const write of writes) {
    if (write.kind === 'merge') {
      problems.push(`R2 MERGE INTO ${write.table} is not modelled`);
      continue;
    }
    if (write.kind === 'update' && !explicitDefault) continue;
    if (resolution(write, tables) !== 'table') {
      problems.push(
        `R2 ${write.kind} on unresolved table ${write.table ?? '(spliced or unreadable)'}`,
      );
      continue;
    }
    for (const columnsOfTable of tables.get(write.table)) {
      const sessionColumns = [...columnsOfTable]
        .filter(([, facts]) => facts.type === 'ts' && facts.sessionDefault)
        .map(([column]) => column.toLowerCase());
      const left =
        write.kind === 'update'
          ? sessionColumns.filter((column) => words.has(column))
          : sessionColumns.filter((column) => !write.listed?.has(column) || explicitDefault);
      if (left.length > 0) {
        problems.push(
          `R2 ${write.kind} leaves ${write.table}.${left.join(', ')} to a session-dependent DEFAULT`,
        );
      }
    }
  }
  return problems;
}

/**
 * Reviewed sites whose bare clocks reach no `timestamp(3)` column. A literal is bound to its exact
 * text and to the column types its review assumed (`noTimestampIn`); a routine to its binding
 * (definitionBinding: signature, body, trigger bindings, column types); a DO block to its body and
 * migration. An entry that matches nothing fails the check, so it cannot outlive what was reviewed.
 */
export const REVIEWED_LITERALS = [
  {
    file: 'services/identity-service/src/keycloak/keycloak-write-fence.ts',
    text: '(EXTRACT(EPOCH FROM clock_timestamp() - transaction_timestamp()) * 1000)::float8',
    why: 'the difference of two instants: an interval, the same in any zone',
  },
  {
    file: 'packages/nest-common/src/outbox/outbox-sql.ts',
    text: `INSERT INTO "\uE0000\uE001" AS s ("topic", "partition_key", "next_seq")
     VALUES ($1, $2, 2)
     ON CONFLICT ("topic", "partition_key")
     DO UPDATE SET "next_seq" = s."next_seq" + 1
     RETURNING s."next_seq" - 1 AS allocated`,
    assumes: { outbox_stream_sequence: 'no ts' },
    why: 'outbox_stream_sequence (the constant spliced here) has no timestamp column at all',
  },
  // A CASE or COALESCE branch meets its siblings' type: these are timestamp(3) or NULL, so the
  // pinned clock stays plain timestamp. Until the guard types siblings itself (FU-226 part B).
  {
    file: 'services/marketplace-service/src/temporal/saga-start.store.ts',
    sha256: 'd9a74ce3446e744b0b68d3e82d73e31460f4712a93901f6cceee2c34c8f5af9d',
    assumes: { 'order.saga_start_attempted_at': 'ts', 'order.created_at': 'ts' },
    why: 'COALESCE(o.saga_start_attempted_at, CASE … THEN o.created_at ELSE <pinned> END): all timestamp(3)',
  },
  {
    file: 'services/marketplace-service/src/temporal/saga-start.store.ts',
    sha256: '57da77774cf80f26e250c6c3a4ee8f43389feb2d20290dbf577e9e559ded8817',
    assumes: { 'order.saga_start_delivered_at': 'ts' },
    why: 'CASE WHEN … THEN <pinned> ELSE NULL END into saga_start_delivered_at, timestamp(3)',
  },
  {
    file: 'services/construction-service/src/tender/tender-approval.errors.ts',
    text: 'execute (the tender changed, or the command is not the one approved); ask for approval again',
    why: 'a sentence of an error message that starts with "execute": no SQL is run from it',
  },
  {
    file: 'services/api-gateway/src/proxy/rate-limiter.ts',
    sha256: '77db5042c85ca53377753a751bc109e95837b778dabca7917c97c610f1512f4b',
    why: 'Lua sliding-window script: redis.call executes Redis sorted-set commands, never SQL',
  },
  {
    file: 'packages/contracts/src/common/__tests__/zod-stock-oracle.ts',
    sha256: '7933cf2a7e2a89de22b992f171c83f70c959e8d2434dc092c041ca18d62a1d6e',
    why: 'JavaScript child-process program: require loads modules, never SQL',
  },
];
export const REVIEWED_FUNCTIONS = [
  {
    service: 'construction-service',
    name: 'bid_guard',
    sha256: 'a6dcf942e2d423831d7ec99110948148b66e8a8c6596eb0eb1b9ddc611e03b0d',
    why: 'clocks are compared with its timestamptz locals; submitted_at, timestamp(3), is compared only with OLD.submitted_at',
  },
  {
    service: 'procurement-service',
    name: 'rfq_guard',
    sha256: '4e4e3f581516009dd6fa8be268cd5b17147b30666f5752a773bac20a6537e399',
    why: 'clocks are compared with quotation_closing_at and closed_at, both timestamptz',
  },
  {
    service: 'analytics-service',
    name: 'fact_recorded_at_now',
    sha256: '7638308e1a32a00b5197fa92599b703f6a593459b40f70e3a49ff9a80ec8a0ef',
    why: 'assigns clock_timestamp() to recorded_at, timestamptz on both tables it fires on (fact_maintenance, baseline_metric)',
  },
  {
    service: 'analytics-service',
    name: 'projection_coverage_started_now',
    sha256: '65c6dc42720abf826c2e37fe8aab1bdc932d1345e017320d80e524ced2942630',
    why: 'assigns clock_timestamp() to covered_from, which is timestamptz',
  },
  {
    service: 'construction-service',
    name: 'award_standing_check_guard',
    sha256: '5dda1c8af723c33d7723387713306a7406654963db1225d228b2444061b862fc',
    why: 'every clock is compared with tender_award_standing_check columns, all timestamptz; the tender.created_at it matched is another table',
  },
  {
    service: 'supplier-service',
    name: 'performance_formula_version_guard',
    sha256: '67a8e42e41b700e26a8771f83ca3203e5c83eb8ba46d7bf2b1d0826e24a37b79',
    why: 'the "SQL" is a RAISE message ("… never edited; create a new version"), never run; no clock, no EXECUTE',
  },
];

/** One-shot DO blocks with DDL or EXECUTE that define nothing live: bound to body and migration. */
export const REVIEWED_DO_BLOCKS = [
  {
    service: 'asset-service',
    migration: '20260925110000_asset_legacy_dossier_and_identifiers',
    sha256: 'f0b0ab23c9d9783817dac975febf7deeeac1ab4cb7e9966609c2fc3652d0ec14',
    why: '$canonicalise$: EXECUTE format() of one-shot INSERT/UPDATE of text identifiers; no clock, no DDL',
  },
  {
    service: 'asset-service',
    migration: '20260925110000_asset_legacy_dossier_and_identifiers',
    sha256: '49d622004a8fc93b91f81803a697473bca9929e191faff441563abd6e8019211',
    why: '$dossier$: EXECUTE format() of one-shot INSERT/UPDATE of organization_id; no clock, no DDL',
  },
  {
    service: 'economic-service',
    migration: '20261105120000_settlement_creation_proof',
    sha256: 'f0fd9ff137c71c1b103e3867b803cfa6b36e4cd79ea964b0e42a095c67c99cac',
    why: 'only ALTER TABLE … VALIDATE CONSTRAINT: no column, default or routine changes',
  },
  {
    service: 'identity-service',
    migration: '20261004100000_membership_live_duplicates_guard',
    sha256: 'cb7e36a67c4ba94658ab183c903c548164c6a78dfeb096df30c73446c46d8157',
    why: 'DROP INDEX of an invalid index: no column, default or routine changes',
  },
  // Preflight checks: SQL only in a RAISE hint (PR #979 r2 F1 sends SQL in a DO string to review).
  {
    service: 'asset-service',
    migration: '20261005120000_insurance_money_non_negative',
    sha256: 'a52525cb25e0d98fe0b735abf5e869a5e7a5cfde635cbdf81d8623f169b00583',
    why: "RAISE … USING HINT = 'SELECT …' is a message, never run; read-only counts, no clock",
  },
  {
    service: 'asset-service',
    migration: '20261005120100_insurance_money_non_negative_validate',
    sha256: '9f9b3aa304778f81b37a0076bd736f8ea1495dd74a442e0a08f7657704ae672c',
    why: "RAISE … USING HINT = 'SELECT …' is a message, never run; read-only counts, no clock",
  },
  {
    service: 'economic-service',
    migration: '20261106130000_transaction_funded_hold',
    sha256: '51ce92bdfadc99ff2a562164a50250a8a73287aea3f8960946148f83564d0111',
    why: "RAISE … USING HINT = 'SELECT …' is a message, never run; read-only counts, no clock",
  },
  {
    service: 'economic-service',
    migration: '20261107120000_hold_funded_at_commit',
    sha256: '2df231ec37010a450f039c188e8f90e1432ede1686bdbe9a1c51113b2e13978a',
    why: "RAISE … USING HINT = 'SELECT …' is a message, never run; read-only counts, no clock",
  },
  {
    service: 'fleet-service',
    migration: '20261005130000_availability_window_one_live',
    sha256: 'acadad481cb2a082072e9272253e6a5803d2918f6a225323ee93565cae480e28',
    why: "RAISE … USING HINT = 'SELECT …' is a message, never run; read-only counts, no clock",
  },
];

const canonical = (text) => lex(text.replace(/\r\n?/g, '\n')).map((t) => `${t.type}:${t.value}`);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A text's tokens, so not its whitespace or comments. */
export const contentHash = (text) => sha256(canonical(text).join('\n'));

/**
 * What a reviewed routine or view is bound to (PR #906 r2 F2): its signature and result, its
 * body's tokens, the tables its triggers fire on, and the type and default of every column of
 * those tables and of the tables its body names. Bind it to another table, or change a column
 * type it relied on, and the review no longer covers it.
 */
export function definitionBinding(definition, tables, firesOn = []) {
  const named = relationsIn(lex(definition.body)).refs.filter(
    (ref) => resolution(ref, tables) === 'table',
  );
  const bound = [...new Set([...firesOn, ...named.map((ref) => ref.table)])].sort();
  const columns = bound.map((table) => [
    table,
    (tables.get(table) ?? []).map((cols) =>
      [...cols].map(([column, f]) => `${column}:${f.type}:${f.sessionDefault}`).sort(),
    ),
  ]);
  return sha256(
    JSON.stringify({
      key: definition.key ?? definition.name,
      header: canonical(definition.header ?? ''),
      body: canonical(definition.body),
      firesOn: [...new Set(firesOn)].sort(),
      columns,
    }),
  );
}

/**
 * R4: a routine with a bare clock that names a `timestamp` type anywhere (a local, parameter,
 * result or cast; qualified or quoted), or a type it cannot read (`%TYPE`, `%ROWTYPE`).
 */
export function localVariableProblems(body, header = '') {
  if (!hasBareClock(body)) return [];
  for (const tokens of [lex(header), lex(body)]) {
    for (let i = 0; i < tokens.length; i += 1) {
      if (isOp(tokens[i], '%') && isWord(tokens[i + 1], 'type', 'rowtype')) {
        return [`R4 a type the guard cannot read beside a bare clock: %${tokens[i + 1].value}`];
      }
      if (!isOp(tokens[i - 1], '.') && typeAt(tokens, i).kind === 'ts') {
        return [
          `R4 a timestamp type beside a bare clock: ${tokens[i - 1]?.value ?? ''} ${tokens[i].value}`,
        ];
      }
    }
  }
  return [];
}

/** What is wrong with a live routine or view, whatever its clocks. */
export function definitionProblems({ body, header, language }, tables, firesOn = []) {
  const tokens = lex(body);
  const dynamic = tokens.some((t) => isWord(t, 'execute'));
  const ddl = tokens.some((t) => isWord(t, ...LIVE_DDL));
  const words = new Set(tokens.map(nameOf));
  // `NEW.col := now()` names the table it fires on nowhere in its body.
  const rowColumns = firesOn.flatMap((table) =>
    (tables.get(table) ?? []).flatMap((columns) =>
      [...columns]
        .filter(([column, facts]) => facts.type === 'ts' && words.has(column.toLowerCase()))
        .map(([column]) => `${table}.${column}`),
    ),
  );
  return [
    ...problemsIn(body, tables, { plpgsql: language === 'plpgsql' }),
    ...localVariableProblems(body, header),
    ...(rowColumns.length > 0 && hasBareClock(body)
      ? [`R1 a bare clock beside timestamp(3) ${rowColumns.join(', ')} of its trigger's table`]
      : []),
    ...(dynamic ? ['dynamic SQL (EXECUTE): the guard cannot read it'] : []),
    ...(ddl ? ['DDL in a routine body: the replay cannot follow it'] : []),
  ];
}

/** The text of `new SomethingError('...')`, never SQL. */
function isErrorMessage(node) {
  const parent = node.parent;
  return ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText());
}

/** Each service's migrations replayed, in the order Prisma applies them. */
function collectTables(repository) {
  const texts = new Map();
  for (const path of authoredFiles(join(repository, 'services')).sort()) {
    const [, service, name] =
      /\/services\/([^/]+)\/prisma\/migrations\/([^/]+)\/migration\.sql$/.exec(path) ?? [];
    const migration = { name, text: readFileSync(path, 'utf8') };
    if (service) texts.set(service, [...(texts.get(service) ?? []), migration]);
  }
  return new Map([...texts].map(([service, sql]) => [service, replayMigrations(sql)]));
}

/** schema.prisma and the replay must agree on every DateTime column's type, or this is blind. */
export function schemaDisagreements(repository, perService) {
  const disagreements = [];
  const schemas = readSchemas(repository);
  for (const [table, entries] of schemas.tables) {
    for (const entry of entries) {
      const replayed = perService.get(entry.service)?.tables.get(table);
      for (const [column, facts] of entry.columns) {
        if (facts.type !== 'DateTime') continue;
        const type = replayed?.get(column)?.type;
        if (type === 'other') continue; // @db.Date
        const expected = /@db\.Timestamptz/.test(facts.declaration ?? '') ? 'tz' : 'ts';
        if (type !== expected) {
          disagreements.push(
            `${entry.service} ${table}.${column}: schema ${expected}, migrations ${type ?? 'missing'}`,
          );
        }
      }
    }
  }
  return disagreements;
}

export function utcClockProblems(repository) {
  const perService = collectTables(repository);
  const problems = schemaDisagreements(repository, perService).map(
    (d) => `schema/migration disagreement: ${d}`,
  );
  const reviewedUsed = new Set();
  const allTables = new Map();
  for (const { tables } of perService.values()) {
    for (const [table, columns] of tables) {
      allTables.set(table, [...(allTables.get(table) ?? []), columns]);
    }
  }
  for (const path of productionFiles(repository)) {
    const local = relative(repository, path);
    const service = local.startsWith('services/') ? local.split('/')[1] : null;
    const scoped = new Map();
    if (service) {
      for (const [table, columns] of perService.get(service)?.tables ?? [])
        scoped.set(table, [columns]);
    }
    const tables = service ? scoped : allTables;
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(local, source, ts.ScriptTarget.Latest, true);
    for (const literal of sqlLiterals(ast)) {
      if (isErrorMessage(literal.node)) continue;
      const found = problemsIn(literal.text, tables);
      if (found.length === 0) continue;
      // The column types its review assumed hold in every service, or the review is void.
      const holds = ([what, expected]) => {
        const [table, column] = what.split('.');
        const maps = allTables.get(table) ?? [];
        const fact = (columns) =>
          column
            ? columns.get(column)?.type === expected
            : expected === 'no ts' && [...columns.values()].every((f) => f.type !== 'ts');
        return maps.length > 0 && maps.every(fact);
      };
      const hash = contentHash(literal.text);
      const reviewed = REVIEWED_LITERALS.find(
        (entry) =>
          entry.file === local &&
          (entry.text === literal.text || entry.sha256 === hash) &&
          Object.entries(entry.assumes ?? {}).every(holds),
      );
      if (reviewed) {
        reviewedUsed.add(reviewed);
        continue;
      }
      const line = ast.getLineAndCharacterOfPosition(literal.node.getStart(ast)).line + 1;
      for (const problem of found) problems.push(`${local}:${line}: ${problem} [sha256 ${hash}]`);
    }
  }
  for (const [
    service,
    { functions, views, tables, unmodelled, doBlocks, triggers },
  ] of perService) {
    for (const what of unmodelled) problems.push(`services/${service} migrations: ${what}`);
    for (const { head, body, migration } of doBlocks) {
      const reviewed = REVIEWED_DO_BLOCKS.find(
        (entry) =>
          entry.service === service &&
          entry.migration === migration &&
          entry.sha256 === contentHash(body),
      );
      if (reviewed) reviewedUsed.add(reviewed);
      else problems.push(`services/${service} migrations: DDL or SQL in a DO block: ${head}`);
    }
    const scoped = new Map([...tables].map(([table, columns]) => [table, [columns]]));
    for (const definition of [...functions.values(), ...views.values()]) {
      const firesOn = triggers.get(definition.name) ?? [];
      const binding = definitionBinding(definition, scoped, firesOn);
      const reviewed = REVIEWED_FUNCTIONS.find(
        (entry) =>
          entry.service === service && entry.name === definition.name && entry.sha256 === binding,
      );
      const found = definitionProblems(definition, scoped, firesOn);
      if (reviewed && found.length > 0) {
        reviewedUsed.add(reviewed);
        continue;
      }
      for (const problem of found)
        problems.push(
          `services/${service} function ${definition.name}: ${problem} [binding ${binding}]`,
        );
    }
  }
  for (const entry of [...REVIEWED_LITERALS, ...REVIEWED_FUNCTIONS, ...REVIEWED_DO_BLOCKS]) {
    if (!reviewedUsed.has(entry)) problems.push(`stale reviewed entry: ${JSON.stringify(entry)}`);
  }
  return problems;
}
