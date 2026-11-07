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
//   R4  a function with a `timestamp` local variable and a bare clock: comparing them goes
//       through the session's zone.
//
// LIMITS. This reads clocks, not types. It cannot see an instant reaching a `timestamp(3)`
// column with no clock in the statement (a timestamptz column copied across, a
// `$n::timestamptz` parameter), a column spliced with `${column}` on a named table, a clock
// in a string (`'now'::timestamptz`), `AT TIME ZONE 'UTC'` wrongly written into a timestamptz
// column, or SQL outside production source and migrations (seeds, runbooks). What it cannot
// see the runtime check refuses: no application session runs outside UTC
// (nest-common utc-session.ts).
//
// Allowed spellings: `<clock> AT TIME ZONE 'UTC'` and `timezone('UTC', <clock>)`.
// LOCALTIMESTAMP, LOCALTIME, CURRENT_TIME and CURRENT_DATE have no such spelling: they
// are the session's wall clock by definition.
//
// Column types and defaults come from replaying each service's migrations, because
// SQL-only tables exist; a type that disagrees with schema.prisma throws.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { authoredFiles } from './authored-source-inventory.cjs';
import { productionFiles, readSchemas, sqlLiterals } from './eligibility-clock-derive.mjs';
import { lex, tableRefs } from './eligibility-clock-sql.mjs';

const CALLS = new Set(['now', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp']);
const KEYWORD_CLOCK = 'current_timestamp';
const SESSION_WALL = new Set(['localtimestamp', 'localtime', 'current_time', 'current_date']);
const isUtcString = (t) => t?.type === 'string' && t.value.toUpperCase() === "'UTC'";

/** Token ranges of the clocks in `tokens`, each with whether it is pinned to UTC. */
export function clocksIn(tokens) {
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== 'word') continue;
    let end;
    if (CALLS.has(t.lower) && tokens[i + 1]?.value === '(' && tokens[i + 2]?.value === ')') {
      end = i + 2;
    } else if (t.lower === KEYWORD_CLOCK) {
      end = tokens[i + 1]?.value === '(' && tokens[i + 3]?.value === ')' ? i + 3 : i;
    } else if (SESSION_WALL.has(t.lower)) {
      found.push({ index: i, name: t.lower, utc: false });
      continue;
    } else {
      continue;
    }
    const atZone =
      tokens[end + 1]?.lower === 'at' &&
      tokens[end + 2]?.lower === 'time' &&
      tokens[end + 3]?.lower === 'zone' &&
      isUtcString(tokens[end + 4]);
    const inTimezone =
      tokens[i - 1]?.value === ',' &&
      isUtcString(tokens[i - 2]) &&
      tokens[i - 3]?.value === '(' &&
      tokens[i - 4]?.lower === 'timezone' &&
      tokens[end + 1]?.value === ')';
    found.push({ index: i, name: t.lower, utc: atZone || inTimezone });
  }
  return found;
}

/** A default expression's verdict: `clock` depends on the session's zone. */
function defaultDependsOnSession(expression) {
  const tokens = lex(expression);
  return clocksIn(tokens).some((clock) => !clock.utc);
}

const IDENT = String.raw`(?:"?public"?\.)?"?(\w+)"?`;
const NAME = String.raw`"?(\w+)"?`;
const statementRe = (pattern) => new RegExp(String.raw`^\s*${pattern}`, 'i');
const CREATE_TABLE = statementRe(
  String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}\s*\(([\s\S]*)\)`,
);
const DROP_TABLE = statementRe(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`);
const DROP_FUNCTION = statementRe(String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?${IDENT}`);
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
const FUNCTION_BODY = new RegExp(
  String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${IDENT}\s*\([^;]*?\bAS\s+(\$\w*\$)([\s\S]*?)\2`,
  'gi',
);
const NOT_A_COLUMN = /^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)$/i;
const COLUMN_DEFINITION = /^\s*"?(\w+)"?\s+([\s\S]+)$/;
const DEFAULT_CLAUSE =
  /\bDEFAULT\s+(.+?)(?:\s+(?:NOT\s+NULL|NULL|CHECK|REFERENCES|CONSTRAINT|UNIQUE|PRIMARY|GENERATED)\b.*)?\s*$/is;

/** Splits at the commas outside parentheses. */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let part = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(part);
      part = '';
    } else part += char;
  }
  parts.push(part);
  return parts;
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

function applyAlterAction(columns, action) {
  let a;
  if ((a = ADD_COLUMN.exec(action))) {
    if (!NOT_A_COLUMN.test(a[1])) columns.set(a[1], columnFacts(a[2].trim()));
  } else if ((a = DROP_COLUMN.exec(action))) {
    if (!/^CONSTRAINT$/i.test(a[1])) columns.delete(a[1]);
  } else if ((a = RENAME_COLUMN.exec(action))) {
    if (columns.has(a[1])) {
      columns.set(a[2], columns.get(a[1]));
      columns.delete(a[1]);
    }
  } else if ((a = SET_TYPE.exec(action))) {
    const column = columns.get(a[1]);
    if (column) column.type = columnType(a[2]);
  } else if ((a = SET_DEFAULT.exec(action))) {
    const column = columns.get(a[1]);
    if (column) column.sessionDefault = defaultDependsOnSession(a[2]);
  } else if ((a = DROP_DEFAULT.exec(action))) {
    const column = columns.get(a[1]);
    if (column) column.sessionDefault = false;
  }
}

/**
 * Replays migration texts, in order: table -> column -> {type: 'ts'|'tz'|'other',
 * sessionDefault}, and the last body of each function.
 */
export function replayMigrations(texts) {
  const tables = new Map();
  const functions = new Map();
  for (const raw of texts) {
    const sql = raw.replace(/--[^\n]*/g, (line) => ' '.repeat(line.length));
    const withoutBodies = sql.replace(FUNCTION_BODY, (_, name, __, body) => {
      functions.set(name, body);
      return ';';
    });
    for (const statement of withoutBodies.split(/;\s*(?:\n|$)/)) {
      let m;
      if ((m = CREATE_TABLE.exec(statement))) {
        const columns = new Map();
        tables.set(m[1], columns);
        for (const part of topLevelParts(m[2])) {
          const c = COLUMN_DEFINITION.exec(part);
          if (c && !NOT_A_COLUMN.test(c[1])) columns.set(c[1], columnFacts(c[2].trim()));
        }
      } else if ((m = DROP_TABLE.exec(statement))) {
        tables.delete(m[1]);
      } else if ((m = DROP_FUNCTION.exec(statement))) {
        functions.delete(m[1]);
      } else if ((m = RENAME_TABLE.exec(statement))) {
        tables.set(m[2], tables.get(m[1]) ?? new Map());
        tables.delete(m[1]);
      } else if ((m = ALTER_ACTIONS.exec(statement))) {
        const columns = tables.get(m[1]);
        if (columns) for (const action of topLevelParts(m[2])) applyAlterAction(columns, action);
      }
    }
  }
  return { tables, functions };
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
  const named = refs.filter((ref) => ref.table);
  const words = new Set(
    tokens
      .filter((t) => t.type === 'word' || t.type === 'quoted')
      .map((t) => (t.type === 'quoted' ? t.value.toLowerCase() : t.lower)),
  );
  const bare = clocks.filter((clock) => !clock.utc);
  if (bare.length > 0) {
    const reading =
      tokens[0]?.lower === 'select' &&
      clocks.length === 1 &&
      refs.length === 0 &&
      CALLS.has(tokens[1]?.lower) &&
      tokens.at(-2)?.lower === 'as' &&
      // Nothing between the clock and AS but a cast to timestamptz.
      /^(?:::timestamptz(?:\(\d\))?)?$/i.test(
        tokens
          .slice(4, -2)
          .map((t) => t.value)
          .join(''),
      );
    const columns = named.flatMap((ref) =>
      (tables.get(ref.table) ?? []).flatMap((columnsOfTable) =>
        [...columnsOfTable]
          .filter(([column, facts]) => facts.type === 'ts' && words.has(column))
          .map(([column]) => `${ref.table}.${column}`),
      ),
    );
    if (columns.length > 0) {
      problems.push(
        `R1 bare ${bare[0].name} beside timestamp(3) ${[...new Set(columns)].join(', ')}`,
      );
    } else if (refs.some((ref) => ref.dynamic)) {
      problems.push(`R1 bare ${bare[0].name} on a spliced table`);
    } else if (refs.length === 0 && !reading) {
      problems.push(`R3 bare ${bare[0].name} in a fragment naming no table`);
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].lower !== 'insert' || tokens[i + 1]?.lower !== 'into') continue;
    const nameAt =
      tokens[i + 2]?.value === 'public' && tokens[i + 3]?.value === '.' ? i + 4 : i + 2;
    const target = tokens[nameAt];
    if (!target || (target.type !== 'word' && target.type !== 'quoted')) continue;
    const table = target.type === 'quoted' ? target.value.toLowerCase() : target.lower;
    const listed = new Set();
    let hasList = false;
    if (tokens[nameAt + 1]?.value === '(') {
      hasList = true;
      for (let j = nameAt + 2; j < tokens.length && tokens[j].value !== ')'; j += 1) {
        const t = tokens[j];
        if (t.type === 'word' || t.type === 'quoted') {
          listed.add(t.type === 'quoted' ? t.value.toLowerCase() : t.lower);
        }
      }
    }
    for (const columnsOfTable of tables.get(table) ?? []) {
      const left = [...columnsOfTable]
        .filter(([, facts]) => facts.type === 'ts' && facts.sessionDefault)
        .map(([column]) => column)
        .filter((column) => !hasList || !listed.has(column));
      if (left.length > 0) {
        problems.push(
          `R2 INSERT leaves ${table}.${left.join(', ')} to a session-dependent DEFAULT`,
        );
      }
    }
  }
  return problems;
}

/**
 * Reviewed sites whose bare clocks reach no `timestamp(3)` column. File-bound, and an entry
 * that matches nothing fails the check, so it cannot outlive its site.
 */
export const REVIEWED_LITERALS = [
  {
    file: 'services/identity-service/src/keycloak/keycloak-write-fence.ts',
    text: '(EXTRACT(EPOCH FROM clock_timestamp() - transaction_timestamp()) * 1000)::float8',
    why: 'the difference of two instants: an interval, the same in any zone',
  },
];
export const REVIEWED_FUNCTIONS = [
  {
    service: 'analytics-service',
    name: 'fact_recorded_at_now',
    why: 'assigns clock_timestamp() to recorded_at, which is timestamptz on every fact table',
  },
  {
    service: 'analytics-service',
    name: 'projection_coverage_started_now',
    why: 'assigns clock_timestamp() to covered_from, which is timestamptz',
  },
  {
    service: 'construction-service',
    name: 'award_standing_check_guard',
    why: 'every clock is compared with tender_award_standing_check columns, all timestamptz; the tender.created_at it matched is another table',
  },
];

/** R4: a `timestamp` local variable of a function, beside a bare clock. */
export function localVariableProblems(body) {
  const local = /\b\w+\s+timestamp(?:\(\d\))?(?:\s+without\s+time\s+zone)?\s*(?::=[^;]*)?;/i.exec(
    body,
  );
  const bare = clocksIn(lex(body)).some((clock) => !clock.utc);
  return local && bare ? [`R4 a timestamp variable beside a bare clock: ${local[0]}`] : [];
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
      if (!clocksIn(lex(literal.text)).length && !/\binsert\s+into\b/i.test(literal.text)) continue;
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
  for (const [service, { functions, tables }] of perService) {
    const scoped = new Map([...tables].map(([table, columns]) => [table, [columns]]));
    for (const [name, body] of functions) {
      const reviewed = REVIEWED_FUNCTIONS.find(
        (entry) => entry.service === service && entry.name === name,
      );
      const found = [...problemsIn(body, scoped), ...localVariableProblems(body)];
      if (reviewed && found.length > 0) {
        reviewedUsed.add(reviewed);
        continue;
      }
      for (const problem of found)
        problems.push(`services/${service} function ${name}: ${problem}`);
    }
  }
  for (const entry of [...REVIEWED_LITERALS, ...REVIEWED_FUNCTIONS]) {
    if (!reviewedUsed.has(entry)) problems.push(`stale reviewed entry: ${JSON.stringify(entry)}`);
  }
  return problems;
}
