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
//   R4  a routine with a `timestamp` local variable, parameter or result and a bare clock:
//       the conversion between them goes through the session's zone.
//
// WHAT IT CANNOT PROVE, IT REFUSES (PR #906 r1 F2): a table it cannot resolve beside a bare
// clock, an INSERT or a DEFAULT; a migration statement or ALTER TABLE action it does not
// model; a live definition holding a clock outside a column DEFAULT; dynamic SQL in a routine
// or DDL in a DO block. Reviewed exemptions are bound to the reviewed content.
//
// LIMITS. This reads clocks, not types. It cannot see an instant reaching a `timestamp(3)`
// column with no clock in the statement (a timestamptz column copied across, a
// `$n::timestamptz` parameter), a column spliced with `${column}` on a named table,
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
import { lex, stripComments, tableRefs } from './eligibility-clock-sql.mjs';

const CALLS = new Set(['now', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp']);
const KEYWORD_CLOCK = 'current_timestamp';
const SESSION_WALL = new Set(['localtimestamp', 'localtime', 'current_time', 'current_date']);
const STRING_CLOCK = /^[eE]?'\s*(?:now|today|tomorrow|yesterday)\s*'$/i;
const isUtcString = (t) => t?.type === 'string' && t.value.toUpperCase() === "'UTC'";
/** An identifier's name: folded, because the spellings a guard must catch differ only in case. */
const nameOf = (t) =>
  t?.type === 'quoted' ? t.value.toLowerCase() : t?.type === 'word' ? t.lower : null;
const isOp = (t, value) => t?.type === 'op' && t.value === value;
const isWord = (t, ...values) => t?.type === 'word' && values.includes(t.lower);
const isAtTimeZone = (tokens, i) =>
  isWord(tokens[i], 'at') && isWord(tokens[i + 1], 'time') && isWord(tokens[i + 2], 'zone');
const isZonedType = (tokens, i) => {
  if (isWord(tokens[i], 'timestamptz')) return true;
  const zone = isOp(tokens[i + 1], '(') ? i + 4 : i + 1;
  return isWord(tokens[i], 'timestamp') && isWord(tokens[zone], 'with');
};
// A parenthesis after these groups an expression; after any other name it is a call.
const BEFORE_GROUPING = new Set(
  'select when then else and or not where on by having returning values in between return if'.split(
    ' ',
  ),
);
const isGrouping = (before) => nameOf(before) === null || BEFORE_GROUPING.has(before.lower);

/** Whether a pinned value at tokens[start..end] is turned back into a session-zone value. */
function zonedAgain(tokens, start, end) {
  let after = end + 1;
  while (isOp(tokens[after], ')')) after += 1;
  if (isAtTimeZone(tokens, after)) return true;
  if (isOp(tokens[after], '::') && isZonedType(tokens, after + 1)) return true;
  if (isWord(tokens[after], 'as') && isZonedType(tokens, after + 1)) return true;
  let before = start - 1;
  while (isOp(tokens[before], '(') && isGrouping(tokens[before - 1])) before -= 1;
  return (
    isOp(tokens[before], ',') &&
    tokens[before - 1]?.type === 'string' &&
    nameOf(tokens[before - 3]) === 'timezone'
  );
}

/** Whether the clock at tokens[first..last] is written `AT TIME ZONE 'UTC'` or `timezone('UTC', …)`. */
function pinnedToUtc(tokens, first, last) {
  let start = first;
  let end = last;
  while (
    isOp(tokens[start - 1], '(') &&
    isOp(tokens[end + 1], ')') &&
    isGrouping(tokens[start - 2])
  ) {
    start -= 1;
    end += 1;
  }
  if (isAtTimeZone(tokens, end + 1) && isUtcString(tokens[end + 4])) {
    return !zonedAgain(tokens, start, end + 4);
  }
  if (!isOp(tokens[start - 1], ',') || !isOp(tokens[end + 1], ')')) return false;
  // `'UTC'` or `'UTC'::text`, the form pg_get_expr prints.
  const text = isOp(tokens[start - 3], '::') && isWord(tokens[start - 2], 'text');
  const zone = start - (text ? 4 : 2);
  return (
    isUtcString(tokens[zone]) &&
    isOp(tokens[zone - 1], '(') &&
    nameOf(tokens[zone - 2]) === 'timezone' &&
    !zonedAgain(tokens, zone - 2, end + 1)
  );
}

/** Token ranges of the clocks in `tokens`, each with whether it is pinned to UTC. */
export function clocksIn(tokens) {
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const name = nameOf(t);
    let end;
    if (t.type === 'string' && STRING_CLOCK.test(t.value)) {
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
    found.push({ index: i, name, utc: pinnedToUtc(tokens, i, end) });
  }
  return found;
}

// A call in a `timestamp(3)` default other than these may read the clock: unproven, so refused.
const PROVEN_DEFAULT_CALLS = new Set([...CALLS, KEYWORD_CLOCK, 'timezone', 'date_trunc']);

/** A default expression's verdict: it depends, or may depend, on the session's zone. */
function defaultDependsOnSession(expression) {
  const tokens = lex(expression);
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
const ALTER_TABLE = String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${IDENT}\s+`;
const RENAME_TABLE = statementRe(String.raw`${ALTER_TABLE}RENAME\s+TO\s+${NAME}`);
const ALTER_ACTIONS = statementRe(String.raw`${ALTER_TABLE}([\s\S]+)$`);
const ADD_COLUMN = statementRe(
  String.raw`ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${NAME}\s+([\s\S]+)$`,
);
const DROP_COLUMN = statementRe(String.raw`DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?${NAME}`);
const RENAME_COLUMN = statementRe(String.raw`RENAME\s+(?:COLUMN\s+)?${NAME}\s+TO\s+${NAME}`);
const ALTER_COLUMN = String.raw`ALTER\s+(?:COLUMN\s+)?${NAME}\s+`;
const SET_TYPE = statementRe(String.raw`${ALTER_COLUMN}(?:SET\s+DATA\s+)?TYPE\s+([\s\S]+)$`);
const SET_DEFAULT = statementRe(String.raw`${ALTER_COLUMN}SET\s+DEFAULT\s+([\s\S]+)$`);
const DROP_DEFAULT = statementRe(String.raw`${ALTER_COLUMN}DROP\s+DEFAULT`);
const NOT_A_COLUMN = /^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)$/i;
const COLUMN_DEFINITION = /^\s*"?(\w+)"?\s+([\s\S]+)$/;
const DEFAULT_CLAUSE =
  /\bDEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|NULL|CHECK|REFERENCES|CONSTRAINT|UNIQUE|PRIMARY|GENERATED)\b.*)?\s*$/is;

// ALTER TABLE actions that cannot change a column's type or default, and hold no expression.
const INERT_ALTER_ACTION =
  /^\s*(?:ADD\s+CONSTRAINT|ADD\s+(?:PRIMARY|UNIQUE|FOREIGN)|DROP\s+CONSTRAINT|RENAME\s+CONSTRAINT|ALTER\s+CONSTRAINT|VALIDATE\s+CONSTRAINT|(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY|(?:ENABLE|DISABLE)\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER|OWNER\s+TO|REPLICA\s+IDENTITY|ALTER\s+(?:COLUMN\s+)?"?\w+"?\s+(?:SET|DROP)\s+NOT\s+NULL)\b/i;
// Statement heads with no column type, default or routine body of their own. A clock in one of
// these is refused below, unless the head is one-shot: it ran once, when the migration applied.
const INERT_HEADS =
  /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|ALTER\s+INDEX|CREATE\s+TYPE|ALTER\s+TYPE|DROP\s+TYPE|CREATE\s+EXTENSION|CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER|DROP\s+TRIGGER|COMMENT|GRANT|REVOKE|SET|RESET|LOCK|BEGIN|COMMIT|ALTER\s+DEFAULT\s+PRIVILEGES|CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+POLICY|CREATE\s+SEQUENCE|ALTER\s+SEQUENCE|DROP\s+SEQUENCE|CREATE\s+SCHEMA|ANALYZE|TRUNCATE)\b/i;
const ONE_SHOT_HEADS = /^(?:INSERT|UPDATE|DELETE|SELECT|WITH)\b/i;
const TRIGGER_BINDING =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b[\s\S]*?\bON\s+(?:"?public"?\.)?"?(\w+)"?[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:"?public"?\.)?"?(\w+)"?/i;
const LIVE_DDL =
  /\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|ROUTINE|VIEW|MATERIALIZED|TABLE|TRIGGER)\b/i;

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
  const flush = (stop) => {
    if (tokens.length > 0) statements.push({ tokens, text: text.slice(tokens[0].start, stop) });
    tokens = [];
  };
  for (const t of lex(text)) {
    if (isOp(t, ';') && depth === 0) {
      flush(t.start);
      continue;
    }
    if (isOp(t, '(')) depth += 1;
    if (isOp(t, ')')) depth -= 1;
    tokens.push(t);
  }
  flush(text.length);
  return statements;
}

function columnType(definition) {
  if (/^TIMESTAMPTZ|^TIMESTAMP(?:\(\d\))?\s+WITH\s+TIME\s+ZONE/i.test(definition)) return 'tz';
  return /^TIMESTAMP/i.test(definition) ? 'ts' : 'other';
}

function columnFacts(definition) {
  const expression = DEFAULT_CLAUSE.exec(definition)?.[1];
  return {
    type: columnType(definition),
    sessionDefault: expression !== undefined && defaultDependsOnSession(expression),
  };
}

const hasBareClock = (text) => clocksIn(lex(text)).some((clock) => !clock.utc);

/** A CHECK, generated column or the like holding a bare clock: a live expression nothing reads. */
function clockOutsideDefault(definition) {
  const expression = DEFAULT_CLAUSE.exec(definition)?.[1] ?? '';
  return hasBareClock(definition.replace(expression, ' '));
}

/** Applies one action; answers what is not modelled, or undefined. */
function applyAlterAction(columns, action) {
  const missing = (column) => `ALTER on unknown column ${column}`;
  if (clockOutsideDefault(action)) return `a clock outside a DEFAULT: ${action.trim()}`;
  let a;
  if (INERT_ALTER_ACTION.test(action)) return undefined;
  if ((a = ADD_COLUMN.exec(action))) {
    if (NOT_A_COLUMN.test(a[1])) return `a constraint not modelled: ${action.trim()}`;
    columns.set(a[1], columnFacts(a[2].trim()));
  } else if ((a = DROP_COLUMN.exec(action))) {
    columns.delete(a[1]);
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
  const end = as < 0 ? tokens.length : as;
  return {
    key: `${name}(${signature.join(' ')})`,
    name,
    body,
    // Parameters and result: a `timestamp` among them converts a bare clock too.
    header: `${signature.join(' ')} ${tokens
      .slice(close + 1, end)
      .map((t) => t.value)
      .join(' ')}`,
  };
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
    if (clockOutsideDefault(part)) return `a clock outside a DEFAULT: ${part.trim()}`;
    const c = COLUMN_DEFINITION.exec(part);
    if (/^\s*LIKE\b/i.test(part)) return `a CREATE TABLE form not modelled: ${part.trim()}`;
    if (c && !NOT_A_COLUMN.test(c[1])) columns.set(c[1], columnFacts(c[2].trim()));
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
  const firstLine = (text) => text.split('\n', 1)[0].slice(0, 100);
  const refuse = (what) => unmodelled.push(what);
  for (const raw of texts) {
    for (const statement of statementsOf(raw)) {
      const { text } = statement;
      let m;
      const routine = readRoutine(statement);
      if (routine?.refused) {
        refuse(routine.refused);
      } else if (routine) {
        functions.set(routine.key, routine);
      } else if ((m = VIEW.exec(text))) {
        views.set(m[1], { name: m[1], body: text, header: '' });
      } else if ((m = DROP_VIEW.exec(text))) {
        views.delete(m[1]);
      } else if ((m = PARTITION_OF.exec(text))) {
        // A partition has its parent's columns, types and defaults.
        if (tables.has(m[2])) tables.set(m[1], tables.get(m[2]));
        else refuse(`PARTITION OF unknown table ${m[2]}`);
      } else if ((m = CREATE_TABLE.exec(text))) {
        if (/\bIF\s+NOT\s+EXISTS\b/i.test(text.slice(0, m[0].length)) && tables.has(m[1])) continue;
        const columns = new Map();
        tables.set(m[1], columns);
        const problem = readCreateTable(statement, columns);
        if (problem) refuse(problem);
      } else if ((m = DROP_TABLE.exec(text))) {
        tables.delete(m[1]);
      } else if ((m = DROP_ROUTINE.exec(text))) {
        for (const [key, known] of functions) {
          const signature = m[2] && lex(m[2].slice(1, -1)).map((t) => t.value.toLowerCase());
          if (known.name === m[1] && (!signature || key === `${m[1]}(${signature.join(' ')})`)) {
            functions.delete(key);
          }
        }
      } else if ((m = RENAME_TABLE.exec(text))) {
        if (tables.has(m[1])) tables.set(m[2], tables.get(m[1]));
        else refuse(`RENAME of unknown table ${m[1]}`);
        tables.delete(m[1]);
      } else if ((m = ALTER_ACTIONS.exec(text))) {
        const columns = tables.get(m[1]);
        if (!columns) {
          refuse(`ALTER of unknown table ${m[1]}`);
          continue;
        }
        for (const action of topLevelParts(m[2])) {
          const problem = applyAlterAction(columns, action);
          if (problem) refuse(`${m[1]}: ${problem}`);
        }
      } else if (isWord(statement.tokens[0], 'do')) {
        const body = statement.tokens.find((t) => t.type === 'string');
        if (body && LIVE_DDL.test(body.value))
          doBlocks.push({ head: firstLine(text), body: body.value });
      } else if (INERT_HEADS.test(text)) {
        if ((m = TRIGGER_BINDING.exec(text))) {
          triggers.set(m[2], [...(triggers.get(m[2]) ?? []), m[1]]);
        }
        if (hasBareClock(text)) refuse(`a clock in a definition not modelled: ${firstLine(text)}`);
      } else if (!ONE_SHOT_HEADS.test(text)) {
        refuse(`a migration statement not modelled: ${firstLine(text)}`);
      }
    }
  }
  return { tables, functions, views, unmodelled, doBlocks, triggers };
}

/** The tables a text writes: INSERT INTO, MERGE INTO, UPDATE … SET. */
function writesIn(tokens) {
  const writes = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let kind = null;
    let at = i + 1;
    if (isWord(tokens[i], 'insert', 'merge') && isWord(tokens[i + 1], 'into')) {
      kind = tokens[i].lower;
      at = i + 2;
    } else if (
      isWord(tokens[i], 'update') &&
      !isWord(tokens[i - 1], 'for', 'do', 'key', 'before', 'after', 'of', 'or')
    ) {
      kind = 'update';
      if (isWord(tokens[at], 'only')) at += 1;
    }
    if (!kind) continue;
    if (tokens[at]?.type === 'placeholder' && !isOp(tokens[at + 1], '.')) {
      if (kind !== 'update' || isWord(tokens[at + 1], 'set')) writes.push({ kind, table: null });
      continue;
    }
    let table = nameOf(tokens[at]);
    if (!table && tokens[at]?.type !== 'placeholder') continue;
    if (isOp(tokens[at + 1], '.')) {
      const inPublic = table === 'public' || tokens[at].type === 'placeholder';
      at += 2;
      table = inPublic ? nameOf(tokens[at]) : `${table}.${nameOf(tokens[at])}`;
    }
    let next = at + 1;
    if (isWord(tokens[next], 'as')) next += 2;
    else if (
      nameOf(tokens[next]) &&
      !isWord(tokens[next], 'set', 'values', 'select', 'default', 'using', 'overriding')
    )
      next += 1;
    // `update the record`: a word, not a statement.
    if (kind === 'update' && !isWord(tokens[next], 'set')) continue;
    const listed = isOp(tokens[next], '(') ? new Set() : null;
    if (listed) {
      for (let j = next + 1; j < tokens.length && !isOp(tokens[j], ')'); j += 1) {
        if (nameOf(tokens[j])) listed.add(nameOf(tokens[j]));
      }
    }
    writes.push({ kind, table, listed });
  }
  return writes;
}

/**
 * What is wrong with one SQL text, given table -> columns. `tables` is every table
 * this text may mean (one service's, or every service's for a shared package).
 */
export function problemsIn(text, tables) {
  const tokens = lex(text);
  const problems = [];
  const clocks = clocksIn(tokens);
  const refs = tableRefs(tokens);
  const writes = writesIn(tokens);
  const named = refs.filter(
    (ref) =>
      ref.table &&
      !ref.cte &&
      // `SELECT … INTO variable` and `RAISE … USING errcode = …` of a routine are no tables.
      (ref.keyword !== 'into' || writes.some((write) => write.table === ref.table)) &&
      !(ref.keyword === 'using' && isOp(tokens[ref.index + 1], '=')),
  );
  const unresolved = named.filter((ref) => !tables.has(ref.table) && !/^pg_/.test(ref.table));
  const words = new Set(tokens.map(nameOf).filter(Boolean));
  const bare = clocks.filter((clock) => !clock.utc);
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
    const columns = named.flatMap((ref) =>
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
      problems.push(`R1 bare ${bare[0].name} on unresolved table ${unresolved[0].table}`);
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
    if (write.table === null || !tables.has(write.table)) {
      problems.push(`R2 ${write.kind} on unresolved table ${write.table ?? '(spliced)'}`);
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
 * Reviewed sites whose bare clocks reach no `timestamp(3)` column. Bound to the exact text or
 * the content hash, and an entry that matches nothing fails the check, so it cannot outlive the
 * SQL that was reviewed.
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
    why: 'outbox_stream_sequence (the constant spliced here) has no timestamp column at all',
  },
];
export const REVIEWED_FUNCTIONS = [
  {
    service: 'construction-service',
    name: 'bid_guard',
    sha256: 'b7715c3d036b764b0a3899c898959c990afb47c368e50b00bdb0e18f5d789f0a',
    why: 'clocks are compared with its timestamptz locals; submitted_at, timestamp(3), is compared only with OLD.submitted_at',
  },
  {
    service: 'procurement-service',
    name: 'rfq_guard',
    sha256: 'ba81705db9f9fe929cef54a6656da14aafad9e8d57be4f5fbc7fe3964e205301',
    why: 'clocks are compared with quotation_closing_at and closed_at, both timestamptz',
  },
  {
    service: 'analytics-service',
    name: 'fact_recorded_at_now',
    sha256: '54a5f821b7503ba5df69419c498d7742e77ed1514dfb1329e4a36e321292e3cb',
    why: 'assigns clock_timestamp() to recorded_at, which is timestamptz on every fact table',
  },
  {
    service: 'analytics-service',
    name: 'projection_coverage_started_now',
    sha256: '556318a18fa8d879b8c713b78ce22e8b6ed1223ee1d895744c2b21a90a2eb04d',
    why: 'assigns clock_timestamp() to covered_from, which is timestamptz',
  },
  {
    service: 'construction-service',
    name: 'award_standing_check_guard',
    sha256: 'c69b7451751f292df1f2f6ce01013c348e3a96cd899c044c63d3584a27e388f3',
    why: 'every clock is compared with tender_award_standing_check columns, all timestamptz; the tender.created_at it matched is another table',
  },
];

/** One-shot DO blocks whose text names DDL that defines nothing live. */
export const REVIEWED_DO_BLOCKS = [
  {
    service: 'asset-service',
    sha256: 'd933168bd92fb472eb347ca3e46ea00110cf68f33db2dba8c08014d9f6ff0f13',
    why: 'a preflight: `CREATE FUNCTION` is only words in its error hints',
  },
  {
    service: 'economic-service',
    sha256: 'f0fd9ff137c71c1b103e3867b803cfa6b36e4cd79ea964b0e42a095c67c99cac',
    why: 'only ALTER TABLE … VALIDATE CONSTRAINT: no column, default or routine changes',
  },
];

/** What a reviewed definition is bound to: its tokens, so not its whitespace or comments. */
export function contentHash(text) {
  const tokens = lex(text.replace(/\r\n?/g, '\n')).map((t) => `${t.type}:${t.value}`);
  return createHash('sha256').update(tokens.join('\n')).digest('hex');
}

/** R4: a `timestamp` local variable, parameter or result of a routine, beside a bare clock. */
export function localVariableProblems(body, header = '') {
  const local = /\b\w+\s+timestamp(?:\(\d\))?(?:\s+without\s+time\s+zone)?\s*(?::=[^;]*)?;/i.exec(
    body,
  );
  const signature = /\btimestamp\b(?!\s*(?:\(\s*\d\s*\)\s*)?with\s+time\s+zone)/i.exec(header);
  const bare = hasBareClock(body);
  if (!bare) return [];
  return local || signature
    ? [`R4 a timestamp variable beside a bare clock: ${(local ?? signature)[0]}`]
    : [];
}

/** What is wrong with a live routine or view, whatever its clocks. */
export function definitionProblems({ body, header }, tables, firesOn = []) {
  const tokens = lex(body);
  const dynamic = tokens.some((t) => isWord(t, 'execute'));
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
    ...problemsIn(body, tables),
    ...localVariableProblems(body, header),
    ...(rowColumns.length > 0 && hasBareClock(body)
      ? [`R1 a bare clock beside timestamp(3) ${rowColumns.join(', ')} of its trigger's table`]
      : []),
    ...(dynamic ? ['dynamic SQL (EXECUTE): the guard cannot read it'] : []),
  ];
}

/** Everything `problemsIn` can answer on has one of these; the rest skips the lexer. */
const RELEVANT_TEXT =
  /now|clock_timestamp|statement_timestamp|transaction_timestamp|current_timestamp|localtime|current_time|current_date|timeofday|today|tomorrow|yesterday|insert|merge|default/i;

/** The text of `new SomethingError('...')`, never SQL. */
function isErrorMessage(node) {
  const parent = node.parent;
  return ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText());
}

/** Each service's migrations replayed, in the order Prisma applies them. */
function collectTables(repository) {
  const texts = new Map();
  for (const path of authoredFiles(join(repository, 'services')).sort()) {
    const service = /\/services\/([^/]+)\/prisma\/migrations\/[^/]+\/migration\.sql$/.exec(
      path,
    )?.[1];
    if (service) texts.set(service, [...(texts.get(service) ?? []), readFileSync(path, 'utf8')]);
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
      if (!RELEVANT_TEXT.test(literal.text)) continue;
      if (isErrorMessage(literal.node)) continue;
      const found = problemsIn(literal.text, tables);
      if (found.length === 0) continue;
      const reviewed = REVIEWED_LITERALS.find(
        (entry) => entry.file === local && entry.text === literal.text,
      );
      if (reviewed) {
        reviewedUsed.add(reviewed);
        continue;
      }
      const line = ast.getLineAndCharacterOfPosition(literal.node.getStart(ast)).line + 1;
      for (const problem of found) problems.push(`${local}:${line}: ${problem}`);
    }
  }
  for (const [
    service,
    { functions, views, tables, unmodelled, doBlocks, triggers },
  ] of perService) {
    for (const what of unmodelled) problems.push(`services/${service} migrations: ${what}`);
    for (const { head, body } of doBlocks) {
      const reviewed = REVIEWED_DO_BLOCKS.find(
        (entry) => entry.service === service && entry.sha256 === contentHash(body),
      );
      if (reviewed) reviewedUsed.add(reviewed);
      else problems.push(`services/${service} migrations: DDL in a DO block: ${head}`);
    }
    const scoped = new Map([...tables].map(([table, columns]) => [table, [columns]]));
    for (const definition of [...functions.values(), ...views.values()]) {
      const reviewed = REVIEWED_FUNCTIONS.find(
        (entry) =>
          entry.service === service &&
          entry.name === definition.name &&
          entry.sha256 === contentHash(definition.body),
      );
      const found = definitionProblems(definition, scoped, triggers.get(definition.name));
      if (reviewed && found.length > 0) {
        reviewedUsed.add(reviewed);
        continue;
      }
      for (const problem of found)
        problems.push(`services/${service} function ${definition.name}: ${problem}`);
    }
  }
  for (const entry of [...REVIEWED_LITERALS, ...REVIEWED_FUNCTIONS, ...REVIEWED_DO_BLOCKS]) {
    if (!reviewedUsed.has(entry)) problems.push(`stale reviewed entry: ${JSON.stringify(entry)}`);
  }
  return problems;
}
