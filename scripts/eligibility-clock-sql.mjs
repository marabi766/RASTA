// SQL reading for the eligibility-clock guard (scripts/eligibility-clock-guard.mjs).
//
// A small PostgreSQL lexer and clause reader, string-aware, so that product
// predicates and test writes are read from tokens rather than from regular
// expressions over raw text. A JavaScript value spliced into the SQL (a
// template span, or a `$N` parameter) is a PLACEHOLDER token: the caller
// decides what it is. Nothing here guesses; an unrecognised shape is reported
// back to the caller, which refuses it.

// U+E000..U+E001 bracket a placeholder index in the text handed to `lex`.
export const PLACEHOLDER = (index) => `${index}`;

const CLOCK_FUNCTIONS = new Set([
  'now',
  'clock_timestamp',
  'statement_timestamp',
  'transaction_timestamp',
]);
const CLOCK_KEYWORDS = new Set([
  'current_timestamp',
  'localtimestamp',
  'current_date',
  'current_time',
  'localtime',
]);
const COMPARISON = new Set(['<', '<=', '>', '>=', '=', '<>', '!=']);
const ORDERING = new Set(['<', '<=', '>', '>=']);
// Tokens that end an operand at its own depth.
const OPERAND_BOUNDARY = new Set([
  'and',
  'or',
  'not',
  'where',
  'on',
  'when',
  'then',
  'else',
  'end',
  'case',
  'select',
  'from',
  'set',
  'having',
  'filter',
  'as',
  'by',
  'order',
  'group',
  'limit',
  'offset',
  'returning',
  'values',
  'using',
  'in',
  'is',
  'like',
  'ilike',
  'between',
  'exists',
  'union',
  'except',
  'intersect',
  'with',
  'for',
  'update',
  'delete',
  'insert',
  'into',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'do',
  'conflict',
  'nothing',
  'distinct',
  'all',
  'any',
  'some',
]);
const NOT_A_COLUMN = new Set([
  ...OPERAND_BOUNDARY,
  'null',
  'true',
  'false',
  'interval',
  'at',
  'time',
  'zone',
  'timestamp',
  'timestamptz',
  'date',
  'with',
  'without',
  'secs',
  'mins',
  'hours',
  'days',
  'precision',
  'double',
  'epoch',
  'excluded',
  'array',
  'row',
  'cast',
  'coalesce',
  'greatest',
  'least',
  'pg_catalog',
]);

/**
 * Remove comments outside string literals, quoted identifiers and dollar
 * quotes. A `--` inside `'...'` is text, not a comment, so it can never hide
 * the rest of its line.
 */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '$' && /^\$(?:[A-Za-z_]\w*)?\$/.test(sql.slice(i))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Tokens: {type: word|quoted|string|number|op|param|placeholder, value, lower}. */
export function lex(sql) {
  const tokens = [];
  const text = stripComments(sql);
  let i = 0;
  const push = (type, value, start) =>
    tokens.push({ type, value, lower: value.toLowerCase(), start });
  while (i < text.length) {
    const c = text[i];
    const rest = text.slice(i);
    let m;
    if (/\s/.test(c)) i += 1;
    else if (c === '') {
      const end = text.indexOf('', i);
      push('placeholder', text.slice(i + 1, end), i);
      i = end + 1;
    } else if (c === "'" || ((c === 'E' || c === 'e') && text[i + 1] === "'")) {
      let j = c === "'" ? i + 1 : i + 2;
      while (j < text.length) {
        if (text[j] === '\\' && c !== "'") j += 2;
        else if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j += 1;
      }
      push('string', text.slice(i, j + 1), i);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"'))
        j += text[j] === '"' ? 2 : 1;
      push('quoted', text.slice(i + 1, j).replaceAll('""', '"'), i);
      i = j + 1;
    } else if ((m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(rest))) {
      const end = text.indexOf(m[0], i + m[0].length);
      const stop = end < 0 ? text.length : end + m[0].length;
      push('string', text.slice(i, stop), i);
      i = stop;
    } else if ((m = /^\$(\d+)/.exec(rest))) {
      push('param', m[1], i);
      i += m[0].length;
    } else if ((m = /^(?:\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)/i.exec(rest))) {
      push('number', m[0], i);
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][\w$]*/.exec(rest))) {
      push('word', m[0], i);
      i += m[0].length;
    } else if ((m = /^(?:::|<=|>=|<>|!=|=>|<@|@>|\|\||->>|->|#>>|#>|&&|!~\*|!~|~\*)/.exec(rest))) {
      push('op', m[0], i);
      i += m[0].length;
    } else {
      push('op', c, i);
      i += 1;
    }
  }
  return tokens;
}

const word = (t, ...values) => t?.type === 'word' && values.includes(t.lower);

/** Matching-parenthesis table for a token list (-1 when unbalanced). */
function pairs(tokens) {
  const match = new Array(tokens.length).fill(-1);
  const stack = [];
  tokens.forEach((t, i) => {
    if (t.value === '(' && t.type === 'op') stack.push(i);
    else if (t.value === ')' && t.type === 'op' && stack.length) {
      const open = stack.pop();
      match[open] = i;
      match[i] = open;
    }
  });
  return match;
}

/** Index of the CASE that an END (scanning left from `end`) closes, or -1. */
function caseOf(tokens, end) {
  let depth = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (word(tokens[i], 'end')) depth += 1;
    else if (word(tokens[i], 'case')) {
      if (!depth) return i;
      depth -= 1;
    }
  }
  return -1;
}

/** The CASE whose THEN/ELSE branch holds token `i` (scanning left), or -1. */
function caseOfBranch(tokens, i) {
  return caseOf(tokens, i);
}

/** `FROM` inside extract(field FROM x), substring(x FROM y), trim(... FROM x). */
function expressionFrom(tokens, match, i) {
  if (!word(tokens[i], 'from')) return false;
  let depth = 0;
  for (let k = i - 1; k >= 0; k -= 1) {
    const t = tokens[k];
    if (t.type === 'op' && t.value === ')') depth += 1;
    else if (t.type === 'op' && t.value === '(') {
      if (!depth) return word(tokens[k - 1], 'extract', 'substring', 'trim', 'overlay', 'position');
      depth -= 1;
    }
  }
  return false;
}

/** Is tokens[i] the start of a clock source? Returns its last index, or -1. */
function clockAt(tokens, i, aliases) {
  const t = tokens[i];
  if (t.type !== 'word') return -1;
  let j = i;
  if (t.lower === 'pg_catalog' && tokens[i + 1]?.value === '.') j = i + 2;
  const name = tokens[j];
  if (
    word(name, ...CLOCK_FUNCTIONS) &&
    tokens[j + 1]?.value === '(' &&
    tokens[j + 2]?.value === ')'
  )
    return j + 2;
  if (word(name, ...CLOCK_KEYWORDS)) return tokens[j + 1]?.value === '(' ? -1 : j;
  // A clock projected under an alias, e.g. `WITH t AS (SELECT clock_timestamp() AS now)`.
  if (aliases.has(t.lower) && tokens[i - 1]?.value !== '.') {
    if (tokens[i + 1]?.value === '.' || tokens[i + 1]?.value === '(') return -1;
    return i;
  }
  if (
    tokens[i + 1]?.value === '.' &&
    (tokens[i + 2]?.type === 'word' || tokens[i + 2]?.type === 'quoted') &&
    aliases.has(tokens[i + 2].lower)
  )
    return i + 2;
  return -1;
}

/**
 * Read one statement. `placeholderKind(index)` says what each placeholder is:
 * 'clock' (a DB-clock reading), 'value', or 'unknown'. Returns comparisons,
 * assignments, inserts and stray clock uses, all in terms of token ranges.
 */
export function analyse(sql, placeholderKind = () => 'unknown') {
  const tokens = lex(sql);
  const match = pairs(tokens);
  const aliases = new Set();
  // Pass 1: aliases of clock expressions (`<clock> AS name`, `<clock>::type AS name`).
  for (let i = 0; i < tokens.length; i += 1) {
    const end = clockAt(tokens, i, new Set());
    if (end < 0) continue;
    let j = end + 1;
    while (tokens[j]?.value === '::' || word(tokens[j], 'at')) {
      if (tokens[j].value === '::') {
        j += 2;
        if (tokens[j]?.value === '(') j = match[j] + 1;
      } else j += 4; // AT TIME ZONE '<zone>'
    }
    if (tokens[j]?.value === ')' && tokens[j + 1] && word(tokens[j + 1], 'as')) j += 1;
    if (
      word(tokens[j], 'as') &&
      (tokens[j + 1]?.type === 'word' || tokens[j + 1]?.type === 'quoted')
    )
      aliases.add(tokens[j + 1].lower);
  }
  const isClock = (i) => {
    if (tokens[i].type === 'placeholder')
      return placeholderKind(Number(tokens[i].value)) === 'clock';
    return clockAt(tokens, i, aliases) >= 0;
  };
  const clockTokens = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type === 'placeholder') {
      if (isClock(i)) clockTokens.add(i);
      continue;
    }
    const end = clockAt(tokens, i, aliases);
    if (end >= 0) {
      for (let k = i; k <= end; k += 1) clockTokens.add(k);
      i = end;
    }
  }

  // Operand extents around an operator token at index `op`.
  const leftOf = (op) => {
    let i = op - 1;
    while (i >= 0) {
      const t = tokens[i];
      if (t.type === 'op' && t.value === ')' && match[i] >= 0) {
        i = match[i] - 1;
        continue;
      }
      if (
        t.type === 'op' &&
        (t.value === '(' || t.value === ',' || t.value === ';' || t.value === '=>')
      )
        break;
      if (t.type === 'op' && COMPARISON.has(t.value)) break;
      if (word(t, 'end') && caseOf(tokens, i) >= 0) {
        i = caseOf(tokens, i) - 1;
        continue;
      }
      if (expressionFrom(tokens, match, i)) {
        i -= 1;
        continue;
      }
      if (t.type === 'word' && OPERAND_BOUNDARY.has(t.lower)) break;
      i -= 1;
    }
    return [i + 1, op - 1];
  };
  const rightOf = (op, between = false) => {
    let i = op + 1;
    let seenAnd = false;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'op' && t.value === '(' && match[i] >= 0) {
        i = match[i] + 1;
        continue;
      }
      if (
        t.type === 'op' &&
        (t.value === ')' || t.value === ',' || t.value === ';' || t.value === '=>')
      )
        break;
      if (t.type === 'op' && COMPARISON.has(t.value)) break;
      if (word(t, 'case')) {
        let depth = 0;
        let k = i + 1;
        for (; k < tokens.length; k += 1) {
          if (word(tokens[k], 'case')) depth += 1;
          else if (word(tokens[k], 'end')) {
            if (!depth) break;
            depth -= 1;
          }
        }
        i = k + 1;
        continue;
      }
      if (expressionFrom(tokens, match, i)) {
        i += 1;
        continue;
      }
      if (between && !seenAnd && word(t, 'and')) {
        seenAnd = true;
        i += 1;
        continue;
      }
      if (t.type === 'word' && OPERAND_BOUNDARY.has(t.lower) && !word(t, 'at')) break;
      if (t.type === 'op' && t.value === '::') {
        i += 2;
        if (tokens[i]?.value === '(') i = match[i] + 1;
        continue;
      }
      i += 1;
    }
    return [op + 1, i - 1];
  };

  // Clause of a token: the nearest governing keyword at its depth or above.
  const clauseOf = (index) => {
    let depth = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      const t = tokens[i];
      if (t.type === 'op' && t.value === ')') depth += 1;
      else if (t.type === 'op' && t.value === '(') {
        if (depth) depth -= 1;
        else if (word(tokens[i - 1], 'values') || (tokens[i - 1]?.value === ',' && valuesList(i)))
          return 'values';
      } else if (!depth && word(t, 'end') && caseOf(tokens, i) >= 0) {
        i = caseOf(tokens, i);
      } else if (!depth && word(t, 'then', 'else') && caseOfBranch(tokens, i) >= 0) {
        i = caseOfBranch(tokens, i);
      } else if (!depth && expressionFrom(tokens, match, i)) {
        continue;
      } else if (!depth && t.type === 'word') {
        if (t.lower === 'set') return 'set';
        if (t.lower === 'select' || t.lower === 'returning') return 'projection';
        if (t.lower === 'values') return 'values';
        if (['where', 'on', 'having', 'when', 'and', 'or', 'not'].includes(t.lower))
          return 'predicate';
        if (['from', 'by', 'limit', 'offset', 'using', 'join'].includes(t.lower)) return t.lower;
      }
    }
    return 'none';
  };
  const valuesList = (open) => {
    // `VALUES (...), (...)`: walk back over earlier tuples.
    let i = open - 1;
    while (tokens[i]?.value === ',' && tokens[i - 1]?.value === ')' && match[i - 1] >= 0)
      i = match[i - 1] - 1;
    return word(tokens[i], 'values');
  };

  // A `=` after SET (at its own depth) is an assignment, not a comparison.
  const isAssignment = (op) => {
    let depth = 0;
    for (let i = op - 1; i >= 0; i -= 1) {
      const t = tokens[i];
      if (t.type === 'op' && t.value === ')') depth += 1;
      else if (t.type === 'op' && t.value === '(') {
        if (!depth) return false;
        depth -= 1;
      } else if (!depth && word(t, 'end') && caseOf(tokens, i) >= 0) {
        i = caseOf(tokens, i);
      } else if (!depth && t.type === 'word') {
        if (t.lower === 'set') return true;
        if (OPERAND_BOUNDARY.has(t.lower) && t.lower !== 'and') return false;
        if (t.lower === 'and') return false;
      }
    }
    return false;
  };

  const comparisons = [];
  const assignments = [];
  const covered = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const between = word(t, 'between');
    if (!(t.type === 'op' && COMPARISON.has(t.value)) && !between) continue;
    if (t.value === '=' && isAssignment(i)) {
      const [ls, le] = leftOf(i);
      const [rs, re] = rightOf(i);
      assignments.push({ op: i, left: [ls, le], right: [rs, re] });
      continue;
    }
    let [ls, le] = leftOf(i);
    if (between && word(tokens[le], 'not')) le -= 1;
    const [rs, re] = rightOf(i, between);
    const left = [ls, le];
    const right = [rs, re];
    const clockSide = (range) => {
      for (let k = range[0]; k <= range[1]; k += 1) if (clockTokens.has(k)) return true;
      return false;
    };
    const entry = {
      op: i,
      operator: between ? 'between' : t.value,
      ordering: between || ORDERING.has(t.value),
      left,
      right,
      clock: clockSide(left) || clockSide(right),
      clause: clauseOf(i),
    };
    comparisons.push(entry);
    for (const [s, e] of [left, right]) for (let k = s; k <= e; k += 1) covered.add(k);
  }

  // Assignments and inserts: written columns.
  const writes = [];
  for (const a of assignments) {
    const cols = columnsIn(tokens, a.left, aliases);
    writes.push({
      kind: 'set',
      columns: cols,
      op: a.op,
      dynamic: hasPlaceholder(tokens, a.left),
      range: a.left,
    });
  }
  // SET lists: anything between SET and its terminator that is not an assignment.
  for (let i = 0; i < tokens.length; i += 1) {
    if (!word(tokens[i], 'set')) continue;
    const depthEnd = setEnd(tokens, match, i);
    for (let k = i + 1; k < depthEnd; k += 1) {
      if (tokens[k].type === 'op' && tokens[k].value === '(' && match[k] >= 0) {
        // skip nested groups that are part of an assignment RHS
      }
      if (
        tokens[k].type === 'placeholder' &&
        placeholderKind(Number(tokens[k].value)) !== 'value'
      ) {
        // a spliced fragment in a SET list could be any assignment
        if (!insideAssignmentValue(tokens, match, i, k))
          writes.push({ kind: 'set-fragment', columns: [], op: k, dynamic: true, range: [k, k] });
      }
    }
  }
  const tables = tableRefs(tokens, match);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!word(tokens[i], 'insert') || !word(tokens[i + 1], 'into')) continue;
    let j = i + 2;
    while (
      j < tokens.length &&
      !(tokens[j].value === '(' && tokens[j].type === 'op') &&
      !word(tokens[j], 'select', 'values', 'default')
    )
      j += 1;
    if (tokens[j]?.value !== '(') {
      writes.push({ kind: 'insert', columns: [], op: i, dynamic: true, range: [i, j] });
      continue;
    }
    const close = match[j];
    const cols = [];
    let dynamic = false;
    for (let k = j + 1; k < close; k += 1) {
      const tk = tokens[k];
      if (tk.type === 'word' || tk.type === 'quoted')
        cols.push(tk.type === 'quoted' ? tk.value.toLowerCase() : tk.lower);
      else if (tk.type === 'placeholder') dynamic = true;
      else if (tk.value !== ',') dynamic = true;
    }
    writes.push({ kind: 'insert', columns: cols, op: i, dynamic, range: [j, close] });
  }

  // Clock uses not inside any comparison operand.
  const stray = [];
  for (const k of clockTokens) {
    if (covered.has(k)) continue;
    const clause = clauseOf(k);
    if (['set', 'values', 'projection'].includes(clause)) continue;
    stray.push({ index: k, clause });
  }
  return { tokens, match, aliases, comparisons, writes, tables, stray, clockTokens };
}

function hasPlaceholder(tokens, [s, e]) {
  for (let k = s; k <= e; k += 1) if (tokens[k].type === 'placeholder') return true;
  return false;
}

function setEnd(tokens, match, set) {
  let depth = 0;
  for (let k = set + 1; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type === 'op' && t.value === '(') depth += 1;
    else if (t.type === 'op' && t.value === ')') {
      if (!depth) return k;
      depth -= 1;
    } else if (!depth && word(t, 'where', 'from', 'returning', 'on', 'select')) return k;
    else if (!depth && t.value === ';') return k;
  }
  return tokens.length;
}

// Is placeholder k (inside a SET list starting at `set`) the right-hand side
// of an `=` assignment, i.e. a value rather than a spliced assignment?
function insideAssignmentValue(tokens, match, set, k) {
  let depth = 0;
  for (let i = k - 1; i > set; i -= 1) {
    const t = tokens[i];
    if (t.type === 'op' && t.value === ')') depth += 1;
    else if (t.type === 'op' && t.value === '(') {
      if (depth) depth -= 1;
    } else if (!depth && t.type === 'op' && t.value === ',') return false;
    else if (!depth && t.type === 'op' && t.value === '=') return true;
  }
  return false;
}

/** Column references in a token range: [{qualifier, name}]. */
export function columnsIn(tokens, [s, e], aliases = new Set()) {
  const out = [];
  for (let k = s; k <= e; k += 1) {
    const t = tokens[k];
    if (t.type !== 'word' && t.type !== 'quoted') continue;
    const name = t.type === 'quoted' ? t.value.toLowerCase() : t.lower;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (prev?.value === '::') continue; // a cast's type name
    if (next?.value === '(' && t.type === 'word') continue; // a function name
    if (t.type === 'word' && NOT_A_COLUMN.has(name)) continue;
    if (t.type === 'word' && CLOCK_KEYWORDS.has(name)) continue;
    if (next?.value === '.') continue; // qualifier, read with the next name
    if (
      prev?.value === '.' &&
      (tokens[k - 2]?.type === 'word' || tokens[k - 2]?.type === 'quoted')
    ) {
      const q = tokens[k - 2];
      const qualifier = q.type === 'quoted' ? q.value.toLowerCase() : q.lower;
      if (qualifier === 'pg_catalog') continue;
      if (aliases.has(name)) continue;
      out.push({ qualifier, name, index: k });
      continue;
    }
    if (aliases.has(name)) continue;
    if (prev?.value === '=>' || next?.value === '=>') continue; // named function argument
    out.push({ qualifier: null, name, index: k });
  }
  return out;
}

/**
 * Table references and their aliases: FROM/JOIN/UPDATE/INTO/USING <table> [AS] [alias].
 * A placeholder in table position is a dynamic table.
 */
export function tableRefs(tokens) {
  const refs = [];
  const ctes = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (
      (t.type === 'word' || t.type === 'quoted') &&
      word(tokens[i + 1], 'as') &&
      tokens[i + 2]?.value === '('
    ) {
      if (
        word(tokens[i - 1], 'with', 'recursive') ||
        tokens[i - 1]?.value === ',' ||
        tokens[i - 1]?.value === ')'
      )
        ctes.add(t.type === 'quoted' ? t.value.toLowerCase() : t.lower);
    }
    if (word(t, 'materialized') && word(tokens[i - 1], 'as')) {
      const n = tokens[i - 2];
      if (n) ctes.add(n.type === 'quoted' ? n.value.toLowerCase() : n.lower);
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!word(t, 'from', 'join', 'update', 'into', 'using')) continue;
    if (word(t, 'update') && (word(tokens[i - 1], 'for', 'do', 'key') || word(tokens[i - 1], 'no')))
      continue;
    if (word(t, 'from') && tokens[i - 1]?.value === '(' && word(tokens[i - 2], 'extract')) continue;
    if (word(t, 'from') && word(tokens[i - 1], 'epoch', 'distinct')) continue;
    let j = i + 1;
    if (word(tokens[j], 'only')) j += 1;
    const n = tokens[j];
    if (!n) continue;
    if (n.type === 'placeholder') {
      // `${schema}.table`: only the schema is spliced.
      const q = tokens[j + 2];
      if (tokens[j + 1]?.value === '.' && (q?.type === 'word' || q?.type === 'quoted')) {
        refs.push({
          table: q.type === 'quoted' ? q.value.toLowerCase() : q.lower,
          alias: null,
          keyword: t.lower,
          index: j + 2,
        });
        continue;
      }
      refs.push({
        table: null,
        dynamic: true,
        placeholder: Number(n.value),
        keyword: t.lower,
        index: j,
      });
      continue;
    }
    if (n.type !== 'word' && n.type !== 'quoted') continue;
    let name = n.type === 'quoted' ? n.value.toLowerCase() : n.lower;
    if (
      tokens[j + 1]?.value === '.' &&
      (tokens[j + 2]?.type === 'word' || tokens[j + 2]?.type === 'quoted')
    ) {
      j += 2;
      name = tokens[j].type === 'quoted' ? tokens[j].value.toLowerCase() : tokens[j].lower;
    } else if (tokens[j + 1]?.value === '.' && tokens[j + 2]?.type === 'placeholder') {
      refs.push({
        table: null,
        dynamic: true,
        placeholder: Number(tokens[j + 2].value),
        keyword: t.lower,
        index: j + 2,
      });
      continue;
    }
    if (tokens[j + 1]?.value === '(' && t.lower !== 'into') continue; // a set-returning function
    if (word(n, 'lateral', 'select')) continue;
    let alias = null;
    let k = j + 1;
    if (word(tokens[k], 'as')) k += 1;
    if (
      (tokens[k]?.type === 'word' &&
        !OPERAND_BOUNDARY.has(tokens[k].lower) &&
        !word(tokens[k], 'set', 'natural', 'tablesample')) ||
      tokens[k]?.type === 'quoted'
    )
      alias = tokens[k].type === 'quoted' ? tokens[k].value.toLowerCase() : tokens[k].lower;
    refs.push({ table: name, alias, cte: ctes.has(name), keyword: t.lower, index: j });
  }
  return refs;
}

/** Projection aliases `<column> AS <alias>` (for CTE outputs), alias -> column ref. */
export function projectionAliases(tokens) {
  const out = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!word(tokens[i], 'as')) continue;
    const a = tokens[i + 1];
    const c = tokens[i - 1];
    if (
      !a ||
      !c ||
      (a.type !== 'word' && a.type !== 'quoted') ||
      (c.type !== 'word' && c.type !== 'quoted')
    )
      continue;
    const alias = a.type === 'quoted' ? a.value.toLowerCase() : a.lower;
    const column = c.type === 'quoted' ? c.value.toLowerCase() : c.lower;
    const qualifier =
      tokens[i - 2]?.value === '.'
        ? tokens[i - 3].type === 'quoted'
          ? tokens[i - 3].value.toLowerCase()
          : tokens[i - 3].lower
        : null;
    if (alias !== column) out.set(alias, { qualifier, name: column });
  }
  return out;
}

/** Does the text look like SQL that reads or writes a table? */
export function looksLikeSql(text) {
  return /\b(?:select|update|insert|delete|with|merge)\b[\s\S]*\b(?:from|set|into|where|values|returning|as)\b|\b(?:where|set)\b/i.test(
    text,
  );
}
