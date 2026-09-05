// -----------------------------------------------------------------------------
// ADR-051 Phase B2 — the PostgreSQL test fixture.
//
// Builds the real outbox schema in a throwaway schema, from the real migration
// files. Nothing here restates the DDL: the outbox table comes out of a
// service's init migration, and the ADR-050 and ADR-051 B1 migrations are
// executed verbatim. A test that ran against a hand-written approximation of
// the schema would pass while the shipped one was wrong, which is exactly the
// failure `verify-outbox-b1-lib.mjs` exists to prevent at the catalog level.
//
// Test-only. Nothing in `scripts/outbox-b2-backfill.mjs` imports it, and it
// creates and drops only schemas whose name it was given.
// -----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * The outbox migrations, in order. The first entry is a *slice* of an init
 * migration (which also creates that service's domain tables); the rest are
 * outbox-only files taken whole.
 */
const OUTBOX_MIGRATIONS = [
  '20260902120000_outbox_durable_claim',
  '20260902130000_outbox_claim_stream_indexes',
  '20260905090000_outbox_stream_sequence',
  '20260905090100_outbox_stream_seq_columns',
  '20260905090200_outbox_stream_head_indexes',
];

const INIT_MIGRATION = {
  service: 'document',
  name: '20260830215511_init_document',
};

const migrationPath = (service, name) =>
  join(REPO_ROOT, 'services', `${service}-service`, 'prisma', 'migrations', name, 'migration.sql');

/**
 * Split a migration file into statements.
 *
 * Aware of single quotes and dollar quoting, because a naive split on `;`
 * would cut a `DO $$ ... $$` block in half. Prisma's `$executeRawUnsafe` sends
 * one prepared statement at a time, so the split is required rather than
 * cosmetic.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let inSingle = false;
  let inLineComment = false;
  let dollarTag = null;

  while (i < sql.length) {
    const rest = sql.slice(i);

    if (inLineComment) {
      if (sql[i] === '\n') inLineComment = false;
      current += sql[i];
      i += 1;
      continue;
    }
    if (dollarTag) {
      if (rest.startsWith(dollarTag)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += sql[i];
      i += 1;
      continue;
    }
    if (inSingle) {
      if (sql[i] === "'") inSingle = false;
      current += sql[i];
      i += 1;
      continue;
    }
    if (rest.startsWith('--')) {
      inLineComment = true;
      current += sql[i];
      i += 1;
      continue;
    }
    if (sql[i] === "'") {
      inSingle = true;
      current += sql[i];
      i += 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      dollarTag = dollar[0];
      current += dollarTag;
      i += dollarTag.length;
      continue;
    }
    if (sql[i] === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  statements.push(current);

  return statements
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !/^\s*--/.test(line))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * The outbox DDL, assembled from the real migrations.
 *
 * `SET LOCAL lock_timeout` is dropped: it belongs to a migration running inside
 * Prisma's transaction wrapper, and outside one it is a no-op that only emits a
 * warning. Every other statement is the shipped text.
 */
export function outboxSchemaStatements() {
  const init = readFileSync(migrationPath(INIT_MIGRATION.service, INIT_MIGRATION.name), 'utf8');

  const createTable = /CREATE TABLE "outbox_message" \([\s\S]*?\n\);/.exec(init);
  if (!createTable) {
    throw new Error(
      `Could not find CREATE TABLE "outbox_message" in ${INIT_MIGRATION.name}. ` +
        'The fixture reads the real migration; update it rather than restating the DDL.',
    );
  }
  const pendingIndex = /CREATE INDEX "ix_outbox_pending" ON "outbox_message"[^;]*;/.exec(init);
  if (!pendingIndex) throw new Error(`Could not find ix_outbox_pending in ${INIT_MIGRATION.name}.`);

  const statements = [createTable[0], pendingIndex[0]];
  for (const name of OUTBOX_MIGRATIONS) {
    statements.push(...splitStatements(readFileSync(migrationPath('document', name), 'utf8')));
  }
  return statements.filter((statement) => !/^SET\s+LOCAL/i.test(statement));
}

/**
 * Create a throwaway schema holding the real outbox schema.
 *
 * `admin` is a port on the service database (public schema) used only to
 * create and drop the schema itself; `db` is a port whose URL already carries
 * `?schema=<name>`, so everything the tool runs lands there and nowhere else.
 */
export async function createOutboxSchema(admin, schema) {
  assertSchemaName(schema);
  await admin.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.execute(`CREATE SCHEMA "${schema}"`);
}

export async function dropOutboxSchema(admin, schema) {
  assertSchemaName(schema);
  await admin.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/** Deploy the outbox DDL through a port already pointed at the scratch schema. */
export async function deployOutboxSchema(db) {
  for (const statement of outboxSchemaStatements()) {
    await db.execute(statement);
  }
}

function assertSchemaName(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Refusing to touch schema "${schema}": not a plain lowercase identifier.`);
  }
  if (schema === 'public') {
    throw new Error('Refusing to drop the public schema.');
  }
}

/** A URL for the same database with its schema replaced. Never logged. */
export function urlWithSchema(baseUrl, schema) {
  assertSchemaName(schema);
  const url = new URL(baseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

/**
 * Insert unpublished outbox rows.
 *
 * `created_at` is set from an explicit offset rather than `now()` so a test can
 * give several rows the identical timestamp and prove `id` is the tie-breaker.
 */
export function insertRowsSql({ prefix, topic, partitionKey, count, from = 1, msOffsets = null }) {
  const createdAt = msOffsets
    ? `(TIMESTAMP '2026-01-01 00:00:00' + ((ARRAY[${msOffsets.join(',')}])[g - ${from} + 1] || ' milliseconds')::interval)`
    : `(TIMESTAMP '2026-01-01 00:00:00' + (g || ' milliseconds')::interval)`;

  return `
INSERT INTO "outbox_message" (
  "id", "aggregate_type", "aggregate_id", "event_name", "event_version",
  "topic", "partition_key", "payload", "headers", "correlation_id",
  "created_at", "attempts"
)
SELECT '${prefix}-' || lpad(g::text, 8, '0'),
       'Probe', 'AGG-${prefix}', 'PROBE', 1,
       '${topic}', '${partitionKey}', '{}'::jsonb, '{}'::jsonb, 'COR-${prefix}',
       ${createdAt},
       0
  FROM generate_series(${from}, ${from + count - 1}) AS g`;
}

/**
 * Mark rows published, the way the relay's `markPublished` leaves them —
 * `published_at` set and every claim column cleared, which is what
 * `ck_outbox_published_is_clean` requires.
 *
 * Selection is a POSIX regular expression rather than `LIKE`: a test that means
 * "rows 1 and 2" writes `^Q-0000000[12]$`, and `LIKE` would match that
 * pattern literally and silently publish nothing.
 */
export function publishSql(idRegex) {
  return `
UPDATE "outbox_message"
   SET "published_at" = TIMESTAMP '2026-01-02 00:00:00',
       "claim_token" = NULL, "claim_owner" = NULL,
       "claim_expires_at" = NULL, "next_attempt_at" = NULL
 WHERE "id" ~ '${idRegex}'`;
}
