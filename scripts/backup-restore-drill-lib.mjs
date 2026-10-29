import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// No broad comment/whitespace filtering: only these two generated version lines,
// at the fixed dump-header position, are removed. SQL comments and bodies retain every byte.
export const SCHEMA_DUMP_FLAGS = [
  '--schema-only',
  '--format=plain',
  '--encoding=UTF8',
  '--quote-all-identifiers',
];
export const DUMP_RESTRICT_KEY = 'RastaRestoreDrill';
export function normalizeSchemaDump(raw) {
  if (!Buffer.isBuffer(raw) || !raw.length) throw new Error('Missing schema dump');
  const header = raw
    .subarray(0, 1024)
    .toString('utf8')
    .match(
      /^((?:--\n-- PostgreSQL database dump\n--\n\n)(?:\\restrict RastaRestoreDrill\n\n)?)(-- Dumped from database version [^\r\n]+\n-- Dumped by pg_dump version [^\r\n]+\n)/,
    );
  const footer = Buffer.from('--\n-- PostgreSQL database dump complete\n--\n\n');
  const end = raw.subarray(-256).toString('utf8');
  if (
    !header ||
    !(
      raw.subarray(-footer.length).equals(footer) ||
      end.endsWith(footer.toString() + `\\unrestrict ${DUMP_RESTRICT_KEY}\n\n`)
    )
  ) {
    throw new Error('Incomplete schema dump');
  }
  const start = Buffer.byteLength(header[1]);
  const normalized = Buffer.concat([
    raw.subarray(0, start),
    raw.subarray(start + Buffer.byteLength(header[2])),
  ]);
  if (!normalized.includes(Buffer.from('SET ')) || !normalized.includes(Buffer.from('CREATE '))) {
    throw new Error('Empty schema dump');
  }
  return normalized;
}

// Bytes remain private and non-enumerable: JSON evidence never contains function bodies.
export function schemaDumpEvidence(raw, version, milliseconds = 0) {
  if (typeof version !== 'string' || !version.startsWith('pg_dump (PostgreSQL) '))
    throw new Error('Missing schema dump version');
  const bytes = normalizeSchemaDump(raw);
  const evidence = {
    version,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    milliseconds,
  };
  Object.defineProperty(evidence, 'content', { value: bytes });
  return evidence;
}

// Only this collection boundary can issue provenance; raw/evidence constructors cannot.
// The collector supports synchronous PG tests and asynchronous operator subprocesses.
// Limit: `database` is the caller's claim. It is tied to pg_dump's `-d` argument only by
// construction in the caller (scripts/backup-restore-drill.mjs passes one variable to both).
const dumpProvenance = new WeakMap();
const dumpInputs = new WeakMap();
const dumpPaths = new WeakMap();
const PROVENANCE_ERROR = 'Invalid schema dump provenance';
/**
 * `restoredFrom` is the evidence object whose bytes were restored into `database` before this
 * dump; the provenance keeps its dumpId and the object itself (never serialized).
 */
export function dumpSchema(database, label, collect, { restoredFrom } = {}) {
  const input = restoredFrom === undefined ? undefined : dumpProvenance.get(restoredFrom);
  if (restoredFrom !== undefined && !input) throw new Error(PROVENANCE_ERROR);
  const finish = ({ raw, version, milliseconds = 0, path }) => {
    const evidence = schemaDumpEvidence(raw, version, milliseconds);
    dumpProvenance.set(
      evidence,
      Object.freeze({
        database,
        label,
        dumpId: randomUUID(),
        ...(input ? { restoredFrom: input.dumpId } : {}),
      }),
    );
    if (input) dumpInputs.set(evidence, restoredFrom);
    if (path) dumpPaths.set(evidence, path);
    return { path, evidence };
  };
  const collected = collect(database, label);
  return collected instanceof Promise ? collected.then(finish) : finish(collected);
}

// A restore receives evidence, never a caller-chosen path: the private file comes from here.
export function dumpPath(evidence) {
  const path = dumpPaths.get(evidence);
  if (!path) throw new Error('Missing schema dump file');
  return path;
}

// Own the two round trips together so callers cannot accidentally reuse REF as fixed point.
// The lineage is derived here from the evidence handed to `restore`, then checked against what
// the following dump recorded; a dump callback that drops or changes it is refused.
export async function collectSchemaReference({
  database,
  suffix,
  sourceDump,
  dump,
  create,
  restore,
  drop,
  shouldDrop = () => true,
  scratchDropFailed = () => {},
}) {
  if (!/^[a-f0-9]{16}$/.test(suffix)) throw new Error('Invalid reference invocation suffix');
  const started = performance.now();
  const scratch = [`drill_ref_${suffix}`, `drill_fixed_${suffix}`];
  const separate = await dump(database, 'reference-input');
  if (!sourceDump.content.equals(separate.evidence.content))
    throw new Error('SOURCE schema changed during collection');
  let reference, fixedPoint, originalError, result;
  try {
    for (const [index, name] of scratch.entries()) {
      const input = index === 0 ? separate : reference;
      await create(name);
      await restore(name, input.evidence);
      const dumped = await dump(name, index === 0 ? 'reference' : 'fixed-point', {
        restoredFrom: input.evidence,
      });
      if (dumpInputs.get(dumped.evidence) !== input.evidence) throw new Error(PROVENANCE_ERROR);
      if (index === 0) reference = dumped;
      else fixedPoint = dumped;
    }
    const allowance = checkSourceReference(sourceDump, reference.evidence, database);
    result = schemaReferenceEvidence(
      sourceDump,
      reference.evidence,
      fixedPoint.evidence,
      allowance,
      Math.round(performance.now() - started),
    );
  } catch (error) {
    originalError = error;
  }
  let dropError;
  if (shouldDrop())
    for (const name of scratch) {
      try {
        await drop(name);
      } catch (error) {
        scratchDropFailed(name, error);
        dropError ??= error;
      }
    }
  // Teardown still removes the owned cluster; preserve the actual collection refusal.
  if (originalError) throw originalError;
  if (dropError) throw dropError;
  return result;
}

// Shared SQL-aware scanner: quoted identifiers/strings, dollar bodies and nested comments
// are indivisible. Consumers never interpret CHECK-looking payload text as SQL syntax.
function* scanSql(text) {
  for (let i = 0; i < text.length;) {
    const start = i;
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      yield { kind: 'comment', value: text.slice(start, i), start, end: i };
      continue;
    }
    if (text.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error('Unclosed schema SQL comment');
      yield { kind: 'comment', value: text.slice(start, i), start, end: i };
      continue;
    }
    const dollar = ch === '$' && text.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/);
    if (dollar) {
      const end = text.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw new Error('Unclosed schema SQL body');
      i = end + dollar[0].length;
      yield { kind: 'string', value: '', start, end: i };
      continue;
    }
    if (ch === "'" || ch === '"') {
      const escape = ch === "'" && /[eE]/.test(text[i - 1] ?? '');
      i++;
      let closed = false;
      while (i < text.length) {
        if (escape && text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i++] === ch) {
          if (text[i] === ch) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) throw new Error('Unclosed schema SQL quote');
      yield {
        kind: ch === '"' ? 'identifier' : 'string',
        value: ch === '"' ? text.slice(start + 1, i - 1).replaceAll('""', '"') : '',
        start,
        end: i,
      };
      continue;
    }
    const word = text.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_$]*/);
    if (word) {
      i += word[0].length;
      yield { kind: 'word', value: word[0], start, end: i };
    } else {
      i++;
      yield { kind: 'symbol', value: ch, start, end: i };
    }
  }
}

// SQL-standard routine bodies are unquoted BEGIN ATOMIC blocks. Their inner
// semicolons/comments must not become top-level statements or dump identities.
function atomicDepthAfter(token, next, depth) {
  if (token.kind !== 'word') return depth;
  const word = token.value.toUpperCase();
  if (
    (word === 'BEGIN' && next?.kind === 'word' && next.value.toUpperCase() === 'ATOMIC') ||
    (depth && word === 'CASE')
  )
    return depth + 1;
  return depth && word === 'END' ? depth - 1 : depth;
}

// Only generated object identities, never differing SQL or function bodies, enter diagnostics.
export function schemaDiffSummary(source, restored) {
  const a = source.content,
    b = restored.content;
  let offset = 0;
  while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset++;
  const text = a.toString('utf8');
  const limit = a.subarray(0, offset).toString('utf8').length;
  let identity = 'database schema',
    atomicDepth = 0;
  const tokens = [...scanSql(text)].filter((t) => t.kind !== 'comment' || t.value.startsWith('--'));
  for (const [index, token] of tokens.entries()) {
    if (token.start > limit) break;
    atomicDepth = atomicDepthAfter(
      token,
      token.kind === 'word' && token.value.toUpperCase() === 'BEGIN'
        ? tokens.slice(index + 1).find((t) => t.kind !== 'comment')
        : undefined,
      atomicDepth,
    );
    const match =
      !atomicDepth &&
      token.kind === 'comment' &&
      (token.start === 0 || text[token.start - 1] === '\n') &&
      token.value.match(
        /^-- Name: ([a-zA-Z0-9_ .(),"-]+); Type: ([A-Z ]+); Schema: ([a-zA-Z0-9_"-]+); Owner: [^\n]*$/,
      );
    if (match) identity = `${match[3]}.${match[1]} (${match[2]})`.slice(0, 180);
  }
  return { identity, firstDifferentByte: offset, sourceBytes: a.length, restoredBytes: b.length };
}

function checkLines(evidence, database) {
  const text = evidence.content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(evidence.content)) throw new Error('Invalid schema UTF-8');
  const lines = text.split('\n');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineAt = new Map(starts.map((start, line) => [start, line]));
  const checks = new Map(),
    identities = [];
  const tokens = [...scanSql(text)].filter((t) => t.kind !== 'comment');
  let statement = [];
  const inspect = () => {
    let i = 0;
    const keyword = (index, value) =>
      statement[index]?.kind === 'word' && statement[index].value.toUpperCase() === value;
    if (!keyword(i++, 'CREATE')) return;
    if (keyword(i, 'UNLOGGED')) i++;
    if (!keyword(i++, 'TABLE')) return;
    const schema = statement[i++],
      dot = statement[i++],
      table = statement[i++];
    if (
      schema?.kind !== 'identifier' ||
      dot?.value !== '.' ||
      table?.kind !== 'identifier' ||
      statement[i++]?.value !== '('
    )
      return;
    let depth = 1;
    for (; i < statement.length; i++) {
      const token = statement[i];
      if (
        depth === 1 &&
        keyword(i, 'CONSTRAINT') &&
        statement[i + 1]?.kind === 'identifier' &&
        keyword(i + 2, 'CHECK') &&
        statement[i + 3]?.value === '('
      ) {
        let j = i + 4,
          expressionDepth = 1;
        for (; j < statement.length && expressionDepth; j++) {
          if (statement[j].value === '(' && statement[j].kind === 'symbol') expressionDepth++;
          if (statement[j].value === ')' && statement[j].kind === 'symbol') expressionDepth--;
        }
        if (expressionDepth) throw new Error('Malformed CHECK evidence');
        if (keyword(j, 'NO') && keyword(j + 1, 'INHERIT')) j += 2;
        const lineStart = text.lastIndexOf('\n', token.start - 1) + 1;
        const line = lineAt.get(lineStart);
        const end = statement[j - 1].end;
        const prefix = text.slice(lineStart, token.start);
        const suffix = text.slice(
          end,
          text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end),
        );
        // A whole physical line, not an arbitrary fragment of a statement, is permitted.
        if (
          /^[ \t]*$/.test(prefix) &&
          /^[ \t]*,?[ \t]*$/.test(suffix) &&
          !text.slice(token.start, end).includes('\n')
        ) {
          const identity = JSON.stringify([
            database,
            schema.value,
            table.value,
            statement[i + 1].value,
          ]);
          checks.set(line, identity);
          identities.push(identity);
        }
      }
      if (token.kind === 'symbol' && token.value === '(') depth++;
      if (token.kind === 'symbol' && token.value === ')') depth--;
    }
  };
  let atomicDepth = 0;
  for (const [index, token] of tokens.entries()) {
    atomicDepth = atomicDepthAfter(token, tokens[index + 1], atomicDepth);
    if (!atomicDepth && token.kind === 'symbol' && token.value === ';') {
      inspect();
      statement = [];
    } else statement.push(token);
  }
  return { lines, checks, identities: identities.sort() };
}

const allowances = new WeakMap();
const references = new WeakMap();
export function checkSourceReference(source, reference, database) {
  if (
    !database ||
    !Buffer.isBuffer(source?.content) ||
    !Buffer.isBuffer(reference?.content) ||
    source.version !== reference.version
  )
    throw new Error('Missing SOURCE/REF evidence');
  const a = checkLines(source, database),
    b = checkLines(reference, database);
  if (a.lines.length !== b.lines.length || !isDeepStrictEqual(a.identities, b.identities))
    throw new Error('SOURCE/REF CHECK identity or line count differs');
  let checkLinesDifferent = 0;
  const checkConstraints = [];
  for (let i = 0; i < a.lines.length; i++) {
    if (a.lines[i] === b.lines[i]) continue;
    if (!a.checks.has(i) || a.checks.get(i) !== b.checks.get(i))
      throw new Error('SOURCE/REF non-CHECK difference');
    checkLinesDifferent++;
    const [, schema, table, name] = JSON.parse(a.checks.get(i));
    checkConstraints.push({ schema, table, name });
  }
  // This structural allowance trusts PostgreSQL; it does NOT prove CHECK semantics.
  const proof = { database, checkLinesDifferent, checkConstraints };
  allowances.set(proof, { source, reference });
  return proof;
}
export function schemaReferenceEvidence(
  source,
  reference,
  fixedPoint,
  allowance,
  milliseconds = 0,
) {
  const provenance = [source, reference, fixedPoint].map((dump) => dumpProvenance.get(dump));
  const [sourceOrigin, refOrigin, fixedOrigin] = provenance;
  // The reference input is the separate SOURCE dump whose bytes were restored into REF (the
  // object recorded when REF was issued); the fixed point must name REF itself.
  const input = dumpInputs.get(reference);
  const inputOrigin = dumpProvenance.get(input);
  const refSuffix = refOrigin?.database?.match(/^drill_ref_([a-f0-9]{16})$/)?.[1];
  if (
    !sourceOrigin ||
    sourceOrigin.database !== allowance?.database ||
    sourceOrigin.label !== 'source' ||
    sourceOrigin.restoredFrom !== undefined ||
    !refSuffix ||
    refOrigin.label !== 'reference' ||
    !inputOrigin ||
    inputOrigin.database !== sourceOrigin.database ||
    inputOrigin.label !== 'reference-input' ||
    inputOrigin.restoredFrom !== undefined ||
    input.version !== source.version ||
    !Buffer.isBuffer(input.content) ||
    !input.content.equals(source.content) ||
    fixedOrigin?.database !== `drill_fixed_${refSuffix}` ||
    fixedOrigin?.label !== 'fixed-point' ||
    fixedOrigin.restoredFrom !== refOrigin.dumpId ||
    new Set([...provenance, inputOrigin].map((origin) => origin?.dumpId)).size !== 4
  )
    throw new Error(PROVENANCE_ERROR);
  const allowed = allowances.get(allowance);
  if (!allowed || allowed.source !== source || allowed.reference !== reference)
    throw new Error('Missing SOURCE/REF allowance guard');
  if (
    !Buffer.isBuffer(fixedPoint?.content) ||
    fixedPoint.version !== reference.version ||
    !reference.content.equals(fixedPoint.content)
  )
    throw new Error('Missing or unstable REF fixed-point evidence');
  const evidence = { ...allowance, milliseconds, reference, fixedPoint };
  references.set(evidence, { source, reference });
  return evidence;
}

export function discoverEnvServices(text) {
  const keys = [...text.matchAll(/^[ \t]*(?:export[ \t]+)?DATABASE_URL_([A-Z][A-Z0-9_]*)[ \t]*=/gm)]
    .map((m) => m[1])
    .filter((name) => !name.endsWith('_MIGRATOR'));
  const services = keys.map((key) => key.toLowerCase()).sort();
  if (!services.length || new Set(services).size !== services.length)
    throw new Error('Invalid .env.example database coverage');
  return services;
}
export function checkEnvServiceCoverage(discovered, configured) {
  if (!isDeepStrictEqual([...discovered].sort(), configured))
    throw new Error('Service coverage mismatch: .env.example and Prisma schemas differ');
}

// Row counts and money stay decimal strings: PostgreSQL count/SUM can exceed JS's safe integer.
function count(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid count');
  return BigInt(value);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.tables !== 'object' || Array.isArray(snapshot.tables)) {
    throw new Error('Missing table inventory');
  }
  if (
    !Buffer.isBuffer(snapshot.schemaDump?.content) ||
    !snapshot.schemaDump.content.length ||
    !snapshot.schemaDump.version
  )
    throw new Error('Missing schema dump evidence');
  const tables = Object.entries(snapshot.tables);
  if (!tables.length) throw new Error('Empty table inventory');
  for (const [, table] of tables) {
    count(table.rows);
    if (
      !['application', 'migration', 'extension'].includes(table.kind) ||
      !/^[a-f0-9]{32}$/.test(table.digest)
    )
      throw new Error('Invalid table evidence');
  }
  const state = snapshot.databaseState;
  if (!state?.owner || !Object.hasOwn(state, 'acl') || !Array.isArray(state.settings)) {
    throw new Error('Missing database state');
  }
  const objects = snapshot.objectState;
  if (
    !objects ||
    !Array.isArray(objects.schemas) ||
    !objects.schemas.length ||
    !Array.isArray(objects.relations) ||
    !objects.relations.length ||
    !Array.isArray(objects.defaultPrivileges) ||
    !Array.isArray(objects.sequences)
  ) {
    throw new Error('Missing object state');
  }
  if (!Array.isArray(snapshot.migrations) || !snapshot.migrations.length) {
    throw new Error('Missing migration ledger');
  }
  for (const row of snapshot.migrations) {
    if (!row.migration_name || !row.checksum || !row.finished_at || row.rolled_back_at !== null) {
      throw new Error('Incomplete migration');
    }
  }
}

/** A missing table or ledger, changed row count, or any changed migration field is a failure. */
export function compareSnapshots(source, restored) {
  validateSnapshot(source);
  validateSnapshot(restored);
  // SOURCE is bound by object identity, RESTORED by its own provenance: the same database, a
  // distinct dump issued with the `restored` label (compareSnapshots(before, before) refuses).
  const proof = references.get(source.reference);
  if (!proof || proof.source !== source.schemaDump)
    throw new Error('Missing schema reference evidence');
  const sourceOrigin = dumpProvenance.get(source.schemaDump);
  const restoredOrigin = dumpProvenance.get(restored.schemaDump);
  if (
    sourceOrigin?.label !== 'source' ||
    restoredOrigin?.label !== 'restored' ||
    restoredOrigin.database !== sourceOrigin.database ||
    restoredOrigin.restoredFrom !== undefined
  )
    throw new Error('Invalid restored schema dump provenance');
  return {
    referenceChecked: true,
    fixedPointEqual: true,
    allowanceChecked: true,
    schemaDumpEqual:
      proof.reference.version === restored.schemaDump.version &&
      proof.reference.content.equals(restored.schemaDump.content),
    tablesEqual: isDeepStrictEqual(source.tables, restored.tables),
    migrationsEqual: isDeepStrictEqual(source.migrations, restored.migrations),
    databaseStateEqual: isDeepStrictEqual(source.databaseState, restored.databaseState),
    objectStateEqual: isDeepStrictEqual(source.objectState, restored.objectState),
  };
}

/** Missing coverage is a failure: the drill always installs its synthetic postings fixture. */
export function ledgerPassed(ledger) {
  if (
    !ledger ||
    !Array.isArray(ledger.amountsByCurrency) ||
    !ledger.amountsByCurrency.length ||
    ledger.fixtureAmount !== '9007199254740993'
  )
    throw new Error('Missing ledger amounts');
  for (const row of ledger.amountsByCurrency) {
    if (!row.currency) throw new Error('Missing currency');
    count(row.total);
  }
  return (
    count(ledger.journalsChecked) > 0n &&
    count(ledger.walletsChecked) > 0n &&
    count(ledger.entriesChecked) > 0n &&
    count(ledger.journalMismatches) === 0n &&
    count(ledger.walletMismatches) === 0n
  );
}

// The same evidence object on both sides is a database compared with itself, not a restore.
export function compareLedgers(source, restored) {
  return (
    source !== restored &&
    ledgerPassed(source) &&
    ledgerPassed(restored) &&
    isDeepStrictEqual(source, restored)
  );
}

/** The same acceptance gate is exercised by the SQL drift tests and the operator command. */
export function drillPassed(databases, expectedCount, sourceLedger, restoredLedger) {
  return (
    expectedCount > 0 &&
    databases.length === expectedCount &&
    databases.every(
      (db) =>
        db.schemaDumpEqual === true &&
        db.referenceChecked === true &&
        db.fixedPointEqual === true &&
        db.allowanceChecked === true &&
        db.tablesEqual &&
        db.migrationsEqual &&
        db.databaseStateEqual &&
        db.objectStateEqual,
    ) &&
    compareLedgers(sourceLedger, restoredLedger)
  );
}

// Explicit exclusions are bootstrap infrastructure, never service databases.
export const EXCLUDED_DATABASES = {
  keycloak: 'identity-provider storage; outside logical service drill',
  temporal: 'workflow engine storage; outside logical service drill',
  temporal_visibility: 'workflow visibility storage; outside logical service drill',
};
export const DATABASES_SQL = `SELECT coalesce(json_agg(datname ORDER BY datname), '[]'::json)
FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres';`;

export function checkDatabaseCoverage(actual, expected) {
  if (
    !Array.isArray(actual) ||
    !actual.length ||
    !expected.length ||
    new Set(actual).size !== actual.length ||
    !isDeepStrictEqual(
      actual.filter((db) => !Object.hasOwn(EXCLUDED_DATABASES, db)).sort(),
      [...expected].sort(),
    )
  )
    throw new Error('Database coverage mismatch');
}

/** Schema files are independent of bootstrap's RASTA_SERVICES; discovery fails closed. */
export function discoverSchemaServices(root) {
  const services = readdirSync(join(root, 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('-service'))
    .filter((entry) => readdirSync(join(root, 'services', entry.name)).includes('prisma'))
    .map((entry) => {
      const schema = readFileSync(
        join(root, 'services', entry.name, 'prisma/schema.prisma'),
        'utf8',
      );
      if (!schema.trim()) throw new Error(`Empty schema: ${entry.name}`);
      return entry.name.slice(0, -'-service'.length).replaceAll('-', '_');
    })
    .sort();
  if (!services.length) throw new Error('Empty schema discovery');
  return services;
}

export function checkServiceCoverage(discovered, configured) {
  const missing = discovered.filter((name) => !configured.includes(name));
  const extra = configured.filter((name) => !discovered.includes(name));
  if (
    !discovered.length ||
    !configured.length ||
    missing.length ||
    extra.length ||
    new Set(configured).size !== configured.length
  ) {
    throw new Error(
      `Service coverage mismatch: missing from RASTA_SERVICES [${missing}]; absent schemas [${extra}]`,
    );
  }
}

// Use role names, never cluster-local OIDs. ACL text and all arrays use C ordering.
// pg_dump omits redundant explicit owner-only ACLs: NULL means acldefault, not no grants.
// acldefault uses lower-case 's' for SEQUENCE; upper-case 'S' is FOREIGN SERVER.
export const OBJECT_STATE_SQL = `
WITH namespaces AS (
  SELECT * FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema')
  AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'
), relations AS (
  SELECT c.*, n.nspname FROM pg_class c JOIN namespaces n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
)
SELECT json_build_object(
  'schemas', (SELECT coalesce(json_agg(json_build_object('name', nspname,
    'owner', pg_get_userbyid(nspowner)) ORDER BY nspname COLLATE "C"), '[]'::json) FROM namespaces),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', nspname || '.' || relname,
    'kind', relkind, 'owner', pg_get_userbyid(relowner),
    'acl', (SELECT json_agg(a::text ORDER BY a::text COLLATE "C") FROM unnest(coalesce(relacl, acldefault(
      CASE WHEN relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, relowner))) a))
    ORDER BY nspname COLLATE "C", relname COLLATE "C"), '[]'::json) FROM relations),
  'defaultPrivileges', (SELECT coalesce(json_agg(json_build_object(
    'role', pg_get_userbyid(d.defaclrole), 'schema', coalesce(n.nspname, '*'),
    'kind', d.defaclobjtype,
    'acl', (SELECT json_agg(a::text ORDER BY a::text COLLATE "C") FROM unnest(d.defaclacl) a))
    ORDER BY pg_get_userbyid(d.defaclrole) COLLATE "C", coalesce(n.nspname, '*') COLLATE "C", d.defaclobjtype),
    '[]'::json) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace));
`;

// Read every sequence directly; pg_sequences alone does not expose is_called.
export const SEQUENCES_SQL = `
SELECT format('SELECT json_build_object(''name'', %L, ''last_value'', last_value::text,
  ''is_called'', is_called) FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
\\gexec
`;

export const DATABASE_STATE_SQL = `
SELECT json_build_object('owner', pg_get_userbyid(d.datdba),
  'acl', (SELECT json_agg(a::text ORDER BY a::text COLLATE "C") FROM unnest(coalesce(d.datacl, acldefault('d'::"char", d.datdba))) a),
  'settings', coalesce((SELECT json_agg(json_build_object(
    'role', CASE WHEN s.setrole = 0 THEN '*' ELSE pg_get_userbyid(s.setrole) END,
    'config', (SELECT json_agg(v ORDER BY v COLLATE "C") FROM unnest(s.setconfig) v))
    ORDER BY s.setrole = 0 DESC, pg_get_userbyid(s.setrole) COLLATE "C")
    FROM pg_db_role_setting s WHERE s.setdatabase = d.oid), '[]'::json))
FROM pg_database d WHERE d.datname = current_database();
`;

export function summarizeTables(tables) {
  const summary = {};
  for (const kind of ['application', 'migration', 'extension']) {
    const selected = Object.values(tables).filter((table) => table.kind === kind);
    summary[kind] = {
      tables: selected.length,
      nonEmptyTables: selected.filter((table) => count(table.rows) > 0n).length,
      rows: selected.reduce((total, table) => total + count(table.rows), 0n).toString(),
    };
  }
  return summary;
}

// All non-system tables, across schemas (including extension tables, audit and _prisma_migrations).
// format(%I) quotes catalog identifiers; no operator-supplied SQL is interpolated.
export const INVENTORY_SQL = `
SELECT format('SELECT json_build_object(''name'', %L, ''rows'', count(*)::text,
  ''kind'', %L, ''digest'', md5(coalesce(string_agg(row_to_json(t)::text, E''\\n''
  ORDER BY row_to_json(t)::text COLLATE "C"), ''''))) FROM %I.%I t',
  n.nspname || '.' || c.relname,
  CASE WHEN EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
    AND d.objid = c.oid AND d.deptype = 'e') THEN 'extension'
    WHEN c.relname = '_prisma_migrations' THEN 'migration' ELSE 'application' END,
  n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY n.nspname, c.relname
\\gexec
`;

export const MIGRATIONS_SQL = (schema) => `
SELECT coalesce(json_agg(row_to_json(m) ORDER BY migration_name, id), '[]'::json)
FROM "${schema}"._prisma_migrations m;
`;

// Reuses the invariant, without importing service code:
// services/economic-service/src/wallet/wallet.repository.ts:115-139 (credits minus debits,
// WALLET = available, ESCROW = pending, sum = ledger), and balance-audit.ts:235-273.
// Journal sums follow services/economic-service/prisma/migrations/
// 20260828202043_init_economic/migration.sql:596-627 (per journal AND currency).
// numeric SUM avoids bigint overflow; counts and amounts leave PostgreSQL as text.
export const LEDGER_SQL = `
WITH bad_journals AS (
  SELECT j.id FROM public.journal j LEFT JOIN public.ledger_entry e ON e.journal_id = j.id
  GROUP BY j.id
  HAVING count(e.id) < 2 OR EXISTS (
    SELECT 1 FROM public.ledger_entry entry WHERE entry.journal_id = j.id
    GROUP BY entry.currency
    HAVING sum(CASE WHEN entry.direction = 'DEBIT' THEN entry.amount_minor::numeric
                    ELSE -entry.amount_minor::numeric END) <> 0
  )
), balances AS (
  SELECT a.id, a.organization_id, a.currency, a.purpose, a.account_type,
    coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor::numeric
                      ELSE -e.amount_minor::numeric END), 0) AS balance
  FROM public.ledger_account a LEFT JOIN public.ledger_entry e ON e.account_id = a.id
  GROUP BY a.id
), bad_wallets AS (
  SELECT w.id FROM public.wallet w
  LEFT JOIN balances a ON a.id = w.ledger_account_id
  LEFT JOIN balances escrow ON escrow.organization_id = w.organization_id
    AND escrow.currency = w.currency AND escrow.purpose = 'ESCROW'
  WHERE a.id IS NULL OR a.purpose <> 'WALLET' OR a.account_type <> 'LIABILITY'
    OR a.organization_id <> w.organization_id OR a.currency <> w.currency
    OR w.available_balance_minor <> a.balance
    OR w.pending_balance_minor <> coalesce(escrow.balance, 0)
    OR w.ledger_balance_minor::numeric <> a.balance + coalesce(escrow.balance, 0)
    OR w.available_balance_minor < 0 OR w.pending_balance_minor < 0 OR w.ledger_balance_minor < 0
    OR w.pending_balance_minor <> (SELECT coalesce(sum(h.amount_minor::numeric), 0)
        FROM public.wallet_hold h WHERE h.wallet_id = w.id AND h.status = 'ACTIVE')
)
SELECT json_build_object(
  'journalsChecked', (SELECT count(*)::text FROM public.journal),
  'entriesChecked', (SELECT count(*)::text FROM public.ledger_entry),
  'walletsChecked', (SELECT count(*)::text FROM public.wallet),
  'journalMismatches', (SELECT count(*)::text FROM bad_journals),
  'walletMismatches', (SELECT count(*)::text FROM bad_wallets),
  'amountsByCurrency', (SELECT json_agg(t ORDER BY currency) FROM
    (SELECT currency, sum(amount_minor::numeric)::text AS total FROM public.ledger_entry
     GROUP BY currency) t),
  'fixtureAmount', (SELECT amount_minor::text FROM public.ledger_entry WHERE id = 'LGE_DRILL_CREDIT'));
`;

// The dev seed intentionally has no wallets/postings (economic prisma/seed.ts:30).
// Synthetic backup-test data ONLY, in a fresh owned cluster: no provider, rate, event or API.
// Like test/helpers.ts:324-350, a wallet balance must be justified by postings.
// The fixture amount is compared as text, alongside table digests and per-currency sums.
export const FIXTURE_SQL = `
BEGIN;
INSERT INTO public.ledger_account
 (id, organization_id, account_type, account_code, purpose, currency, created_by)
VALUES ('ACC_DRILL_WALLET', 'ORG-RESTORE-DRILL', 'LIABILITY', 'DRILL-WALLET', 'WALLET', 'IRR', 'restore-drill'),
 ('ACC_DRILL_ESCROW', 'ORG-RESTORE-DRILL', 'LIABILITY', 'DRILL-ESCROW', 'ESCROW', 'IRR', 'restore-drill');
INSERT INTO public.journal
 (id, organization_id, journal_type, description, posted_at, posted_by, correlation_id)
VALUES ('JRN_DRILL_TOPUP', 'ORG-RESTORE-DRILL', 'WALLET_TOP_UP', 'Synthetic restore fixture', now(), 'restore-drill', 'restore-drill'),
 ('JRN_DRILL_HOLD', 'ORG-RESTORE-DRILL', 'FUNDS_HELD', 'Synthetic restore hold', now(), 'restore-drill', 'restore-drill');
INSERT INTO public.ledger_entry
 (id, journal_id, account_id, organization_id, direction, amount_minor, currency, posted_at)
VALUES
 ('LGE_DRILL_DEBIT', 'JRN_DRILL_TOPUP', 'ACC_SEED_PAYMENT_CLEARING', 'ORG-PLATFORM', 'DEBIT', 9007199254740993, 'IRR', now()),
 ('LGE_DRILL_CREDIT', 'JRN_DRILL_TOPUP', 'ACC_DRILL_WALLET', 'ORG-RESTORE-DRILL', 'CREDIT', 9007199254740993, 'IRR', now()),
 ('LGE_DRILL_HOLD_DEBIT', 'JRN_DRILL_HOLD', 'ACC_DRILL_WALLET', 'ORG-RESTORE-DRILL', 'DEBIT', 2500, 'IRR', now()),
 ('LGE_DRILL_HOLD_CREDIT', 'JRN_DRILL_HOLD', 'ACC_DRILL_ESCROW', 'ORG-RESTORE-DRILL', 'CREDIT', 2500, 'IRR', now());
INSERT INTO public.wallet
 (id, organization_id, currency, ledger_account_id, ledger_balance_minor, available_balance_minor, pending_balance_minor, updated_at)
VALUES ('WLT_DRILL', 'ORG-RESTORE-DRILL', 'IRR', 'ACC_DRILL_WALLET', 9007199254740993, 9007199254738493, 2500, now());
INSERT INTO public.wallet_hold
 (id, organization_id, wallet_id, amount_minor, currency, reference, reference_type, placed_journal_id, placed_at, placed_by)
VALUES ('HLD_DRILL', 'ORG-RESTORE-DRILL', 'WLT_DRILL', 2500, 'IRR', 'DRILL', 'RESTORE_TEST', 'JRN_DRILL_HOLD', now(), 'restore-drill');
COMMIT;
`;

const reportFs = { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync };

/**
 * Replace the report in one step: a random sibling is created exclusively (never through a
 * symlink) with mode 0600, written, fsynced and renamed over the destination, so a kill at any
 * point leaves the previous complete report or the new one. A failure removes the sibling and
 * keeps the previous report. `durable` additionally fsyncs the parent directory. The result is
 * true only when that fsync succeeded: only then may a caller claim the rename survives power
 * loss. A failed directory fsync leaves the complete new report in place and returns false.
 * Errors never quote the path.
 */
export function writeReportAtomically(path, report, { durable = false, fs = reportFs } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const sibling = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(sibling, 'wx', 0o600);
    for (let offset = 0; offset < bytes.length;) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error('Could not write report');
      offset += written;
    }
    fs.fsyncSync(fd);
    const closing = fd;
    fd = undefined;
    fs.closeSync(closing);
    fs.renameSync(sibling, path);
  } catch (error) {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        /* the write error is the one to report */
      }
    try {
      fs.unlinkSync(sibling);
    } catch {
      /* never created, or already renamed */
    }
    throw new Error(`Could not write report (${error?.code ?? 'failed'})`);
  }
  if (!durable) return false;
  let directory;
  try {
    directory = fs.openSync(dirname(path), 'r');
    fs.fsyncSync(directory);
    return true;
  } catch {
    // The renamed report is complete; only its power-loss durability is unproven.
    return false;
  } finally {
    if (directory !== undefined)
      try {
        fs.closeSync(directory);
      } catch {
        /* nothing more to report */
      }
  }
}

/** A process group is a Linux/macOS pgid; `kill(-pgid, 0)` reports whether any member remains. */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
export function killGroup(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* already stopped */
  }
}

/**
 * The group leader has exited; anything still in its group is an orphan of this invocation.
 * Returns 'gone' (nothing left), 'reaped' (members killed and confirmed gone within the
 * bounded wait) or 'orphan' (still present: cleanup cannot be reported as passed).
 */
export async function reapProcessGroup(
  pgid,
  {
    alive = groupAlive,
    kill = killGroup,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 100,
  } = {},
) {
  if (!alive(pgid)) return 'gone';
  kill(pgid);
  for (let attempt = 0; attempt < attempts && alive(pgid); attempt++) await wait(50);
  return alive(pgid) ? 'orphan' : 'reaped';
}

/**
 * How long a stopped command may stay unconfirmed before the runner gives up waiting for the
 * child's own `exit`/`close`/`error`. It applies to EVERY stop reason (timeout, output overflow,
 * unrecorded group, signal) and does not depend on the child: a leader stuck in uninterruptible
 * I/O survives SIGKILL and may never emit anything.
 */
export const KILL_CONFIRMATION_DEADLINE_MS = 10_000;

/**
 * The one lifecycle boundary for every child of the drill. Each child leads its own process
 * group, and a group stays OWNED until its disappearance is confirmed:
 *  - handlers are installed before anything that can throw (the report write), so a failed
 *    persist still ends in reaping;
 *  - the leader's `exit` (not only `close`, which waits for inherited pipes) starts a bounded
 *    drain, after which the group is reaped, so a descendant holding stdout/stderr cannot
 *    outlive the command;
 *  - a timeout is a failure whatever the exit code that follows the kill;
 *  - every stop (timeout, output overflow, unrecorded group, `stopActive()`) goes through ONE
 *    function that kills the group and starts the kill-confirmation deadline; if the child has
 *    not exited when it expires the command rejects with code `KILL_UNCONFIRMED`, the group
 *    stays owned as an orphan (recorded in `report.unconfirmedProcessGroups`) for the retry and
 *    the report, and the command counts as settled for `settleAll()`;
 *  - a group that survives the reap (an orphan) stays in `groups`/`report.processGroups`,
 *    in `report.orphanProcessGroups` and in the signal/retry set until a later retry sees it
 *    gone;
 *  - `settleAll()` is the shutdown barrier: it resolves only when EVERY command started
 *    through `run` has settled and been reaped, siblings of a rejected one included, so nothing
 *    is still running (or still unrecorded) when the cleanup verdict and final report are made.
 * `persist()` writes the report and may throw; `persistFailed(stage)` records that, stickily.
 */
export function createProcessRunner({
  report,
  persist,
  persistFailed = () => {},
  isInterrupted = () => false,
  currentStage = () => undefined,
  cwd,
  env,
  spawn = nodeSpawn,
  reap = reapProcessGroup,
  kill = killGroup,
  drainMilliseconds = 2000,
  killDeadlineMilliseconds = KILL_CONFIRMATION_DEADLINE_MS,
  maxOutputBytes = 64 * 1024 * 1024,
}) {
  const groups = new Set();
  const orphans = new Set();
  const outstanding = new Set();
  const active = new Map();
  const publish = () => {
    report.processGroups = [...groups];
    if (orphans.size || report.orphanProcessGroups) report.orphanProcessGroups = [...orphans];
  };
  async function settle(pgid, stageName, retry = false) {
    const outcome = await reap(pgid);
    if (outcome !== 'gone' && !retry)
      (report.reapedProcessGroups ??= []).push({ pgid, stage: stageName });
    if (outcome === 'orphan') orphans.add(pgid);
    else {
      orphans.delete(pgid);
      groups.delete(pgid);
    }
    publish();
    return outcome;
  }
  const failure = (options, exitCode, message, extra) => {
    const error = new Error(options.privateOutput ? 'Private schema command failed' : message);
    if (options.privateOutput)
      error.privateFailure = {
        stage: options.stage ?? currentStage(),
        database: options.database ?? null,
        exitCode,
        ...extra,
      };
    return error;
  };

  // Every command is tracked until it has settled (its group reaped), whoever awaits it.
  function run(command, argv, options = {}) {
    const command_ = launch(command, argv, options);
    const done = command_
      .then(
        () => {},
        () => {},
      )
      .then(() => outstanding.delete(done));
    outstanding.add(done);
    return command_;
  }

  async function launch(command, argv, options) {
    if (isInterrupted() && !options.cleanup) throw new Error('Interrupted');
    return new Promise((accept, reject) => {
      const child = spawn(command, argv, {
        cwd: options.cwd ?? cwd,
        env: options.env ?? env,
        detached: true,
        stdio: [options.inputFd ?? 'pipe', options.outputFd ?? 'pipe', 'pipe'],
      });
      const pgid = child.pid;
      const stageName = currentStage();
      const output = [];
      let diagnostic = '';
      let bytes = 0;
      let overflow = false;
      let timedOut = false;
      let unrecorded = false;
      let startFailed = false;
      let finished = false;
      let exited = false;
      let exitCode;
      let drainTimer;
      let deadlineTimer;
      // The one stop: kill the group and (once) start the deadline that does not wait for the child.
      const stop = (reason) => {
        kill(pgid);
        deadlineTimer ??= setTimeout(() => unconfirmed(reason), killDeadlineMilliseconds);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop('timeout');
      }, options.timeout ?? 600_000);
      const unconfirmed = (reason) => {
        if (finished) return;
        // The leader did exit: the bounded drain and reap decide, not this deadline.
        if (exited) {
          finish(exitCode);
          return;
        }
        finished = true;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        active.delete(pgid);
        orphans.add(pgid);
        (report.unconfirmedProcessGroups ??= []).push({ pgid, stage: stageName, reason });
        publish();
        try {
          persist();
        } catch {
          persistFailed(stageName);
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        const error = failure(options, null, `Command could not be confirmed stopped (${reason})`, {
          killUnconfirmed: true,
          reason,
        });
        error.code = 'KILL_UNCONFIRMED';
        reject(error);
      };
      const finish = async (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        clearTimeout(deadlineTimer);
        active.delete(pgid);
        try {
          if (pgid) await settle(pgid, stageName);
        } catch (error) {
          reject(error);
          return;
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (startFailed) reject(failure(options, null, 'Could not start command'));
        else if (unrecorded) reject(new Error('Could not record process group'));
        else if (code !== 0 || overflow || timedOut) {
          const detail =
            `${Buffer.concat(output).toString('utf8').slice(-4000)}\n${diagnostic}`.replace(
              /postgres(?:ql)?:\/\/[^\s"']+/gi,
              '[database URL redacted]',
            );
          reject(
            failure(
              options,
              code,
              `Command ${timedOut ? 'timed out' : 'failed'} (exit ${code}): ${detail}`,
              timedOut ? { timedOut: true } : undefined,
            ),
          );
        } else
          accept(
            options.raw ? Buffer.concat(output) : Buffer.concat(output).toString('utf8').trim(),
          );
      };
      child.stdout?.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          overflow = true;
          stop('output');
        } else output.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4000);
      });
      child.stdin?.on('error', () => {});
      child.on('error', () => {
        startFailed = true;
        if (pgid) finish(null);
        else {
          finished = true;
          clearTimeout(timer);
          clearTimeout(deadlineTimer);
          reject(failure(options, null, 'Could not start command'));
        }
      });
      // `exit` is the leader; `close` additionally waits for every inherited pipe end.
      child.on('exit', (code) => {
        exited = true;
        exitCode = code;
        if (!finished) drainTimer = setTimeout(() => finish(code), drainMilliseconds);
      });
      child.on('close', (code) => finish(code));
      if (child.stdin) child.stdin.end(options.input);
      if (pgid) {
        groups.add(pgid);
        active.set(pgid, stop);
        publish();
        try {
          persist();
        } catch {
          persistFailed(stageName);
          // An unrecorded group cannot be handed over: stop it and let `finish` confirm it is
          // gone. Cleanup commands still have to run, so they are only reported.
          if (!options.cleanup) {
            unrecorded = true;
            stop('unrecorded');
          }
        }
      }
    });
  }

  return {
    run,
    groups,
    orphans,
    stopActive: () => {
      for (const pgid of groups) {
        const stopCommand = active.get(pgid);
        if (stopCommand) stopCommand('signal');
        else kill(pgid);
      }
    },
    killOrphans: () => {
      for (const pgid of orphans) kill(pgid);
    },
    settleAll: async () => {
      // Commands started while waiting are awaited too.
      while (outstanding.size) await Promise.allSettled([...outstanding]);
    },
    // Returns what the retry did, for the report: nothing is silently dropped.
    retryOrphans: async () => {
      const retried = [...orphans];
      for (const pgid of retried) await settle(pgid, undefined, true);
      return { retried, remaining: retried.filter((pgid) => orphans.has(pgid)) };
    },
  };
}

/**
 * Check every resource kind and keep EVERY outcome (no short-circuit on the first rejection):
 * `leftovers` are kinds with something still listed, `unverified` are kinds whose check failed.
 */
export async function verifyResourceKinds(kinds, list) {
  const outcomes = await Promise.allSettled(kinds.map((kind) => list(kind)));
  return {
    leftovers: kinds.filter(
      (_, index) => outcomes[index].status === 'fulfilled' && outcomes[index].value,
    ),
    unverified: kinds.filter((_, index) => outcomes[index].status === 'rejected'),
  };
}

/**
 * The one cleanup finalization. The order is fixed and unconditional:
 *  1. barrier: every outstanding command has settled before anything is torn down;
 *  2. `teardown()` (compose down, resource listing); a rejection fails the cleanup but never
 *     skips what follows;
 *  3. barrier again, so siblings of a failed step are settled and their groups reaped;
 *  4. the retry of every group whose disappearance was unconfirmed (success path or not),
 *     including a sibling's group that only became an orphan when the barrier let it settle;
 *  5. the verdict, with the retry outcome, ready for the final report.
 */
export async function finalizeCleanup({ runner, report, teardown }) {
  let torn = { leftovers: [], unverified: [] };
  let failed = false;
  await runner.settleAll();
  try {
    torn = { ...torn, ...(await teardown()) };
  } catch {
    failed = true;
  }
  await runner.settleAll();
  let orphanRetry = { retried: [], remaining: [] };
  try {
    orphanRetry = await runner.retryOrphans();
  } catch {
    failed = true;
  }
  const passed =
    !failed &&
    !torn.leftovers.length &&
    !torn.unverified.length &&
    !report.orphanProcessGroups?.length;
  return { passed, leftovers: torn.leftovers, unverified: torn.unverified, orphanRetry };
}
