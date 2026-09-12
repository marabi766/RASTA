// -----------------------------------------------------------------------------
// What `20260912120000_audit_correction_command` must leave behind, and the SQL
// that checks it.
//
// Extracted from `verify-audit-correction-command-migration.mjs` for the same
// reason `verify-migration-reversible-lib.mjs` exists: the verifier is a CLI
// that does its work at import time, so nothing inside it can be unit-tested in
// place. Everything here is a pure function of constants, the CLI imports it,
// and `verify-audit-correction-command-lib.test.mjs` exercises the same code
// the verifier runs rather than a copy of it.
//
// The split is along one line: this file is *what is expected*, the CLI is
// *how it is executed against a real database*. The unit tests do not replace
// the up -> down -> up proof and cannot: a generated string is not a rollback.
// -----------------------------------------------------------------------------

/** The one migration this verifier reverses. */
export const MIGRATION = '20260912120000_audit_correction_command';

/** The one table it creates. */
export const TABLE = 'audit_correction_command';

/**
 * The composite primary key, by its exact definition rather than by name.
 *
 * The order of the two columns is the design, not a detail: an
 * `Idempotency-Key` is caller-chosen, so keying by the key alone would let one
 * administrator's key replay — or block — another's command. A key that
 * happened to be declared `(idempotency_key, actor_id)` would enforce the same
 * uniqueness and index the wrong prefix, and only `pg_get_constraintdef` tells
 * the two apart.
 */
export const PRIMARY_KEY = {
  name: 'audit_correction_command_pkey',
  definition: 'PRIMARY KEY (actor_id, idempotency_key)',
};

/**
 * Every column, with the shape the forward migration declares.
 *
 * `signature` is `data_type|character_maximum_length|datetime_precision|is_nullable|column_default`,
 * with `-` for a NULL catalog value. Compared as one string so a widened
 * `VARCHAR`, a lost `NOT NULL`, a dropped default or a `TIMESTAMP` that quietly
 * became `TIMESTAMPTZ` all fail the same way and name the column that changed.
 *
 * Why the lengths are asserted at all: `request_hash` is `CHAR(64)` because a
 * SHA-256 hex digest is exactly 64 characters, and `event_id` is `VARCHAR(26)`
 * because a ULID is exactly 26. A migration that widened either would still
 * store every value the service writes today and would stop the database from
 * being the thing that says the value is the right shape.
 */
export const COLUMNS = [
  { name: 'actor_id', signature: 'character varying|256|-|NO|-' },
  { name: 'idempotency_key', signature: 'character varying|255|-|NO|-' },
  { name: 'request_hash', signature: 'character|64|-|NO|-' },
  { name: 'target_id', signature: 'character varying|64|-|NO|-' },
  { name: 'event_id', signature: 'character varying|26|-|NO|-' },
  { name: 'response_body', signature: 'jsonb|-|-|NO|-' },
  { name: 'created_at', signature: 'timestamp without time zone|-|3|NO|CURRENT_TIMESTAMP' },
];

/**
 * Objects that predate this migration and must be standing both before and
 * after it is reversed.
 *
 * This is the other half of "reversible": a down script that removes more than
 * it added is not a rollback, it is an outage. The table this migration adds is
 * unrelated to identity's own schema and to both outboxes, so every one of
 * these has to survive a run of `down.sql` untouched — the domain tables the
 * service is built on, the tenant-scoped `idempotency_key` table this command
 * deliberately does *not* use, ADR-050's claim rules on the domain outbox, and
 * the AUD-004 refusal outbox with its evidence trigger and that trigger's
 * function.
 */
export const SURVIVORS = {
  tables: [
    'user',
    'membership',
    'role',
    'registration_request',
    'organization_ref',
    'outbox_message',
    'outbox_stream_sequence',
    'processed_event',
    'idempotency_key',
    'security_event_outbox',
  ],
  indexes: ['ix_outbox_claimable', 'ix_security_event_outbox_claimable'],
  constraints: ['ck_outbox_claim_triple', 'ck_outbox_published_is_clean'],
  triggers: ['tg_security_event_outbox_guard'],
  functions: ['security_event_outbox_guard'],
};

/** A code-authored string as the body of a SQL literal. */
const literal = (value) => String(value).replaceAll("'", "''");

/**
 * A row the running command would write, with any field overridden.
 *
 * Every column is populated, because a row that only satisfied the constraint
 * under test would not prove anything about a real database. Values are SQL
 * fragments so a probe can pass `NULL` or `DEFAULT` where a literal would not
 * do.
 */
export const COMMAND_ROW = {
  actor_id: `'USR_ACCCHK_ADMIN'`,
  idempotency_key: `'KEY_ACCCHK_0001'`,
  request_hash: `repeat('a', 64)`,
  target_id: `'AUD_ACCCHK_TARGET'`,
  event_id: `'ACCCHK00000000000000000001'`,
  response_body: `'{"status":"ACCEPTED"}'::jsonb`,
  created_at: `'2099-01-01 00:00:00'`,
};

/** `INSERT` for one command row. Columns whose override is `undefined` are omitted. */
export function insertCommand(overrides = {}) {
  const values = Object.fromEntries(
    Object.entries({ ...COMMAND_ROW, ...overrides }).filter(([, value]) => value !== undefined),
  );
  return `INSERT INTO "${TABLE}" (${Object.keys(values).join(', ')})
          VALUES (${Object.values(values).join(', ')});`;
}

/** Removes only this verifier's own probe rows. Never a bare `DELETE`. */
export const CLEAR_PROBES = `DELETE FROM "${TABLE}" WHERE actor_id LIKE 'USR_ACCCHK%';`;

/**
 * A unique violation on the composite key, as `prisma db execute` reports one:
 * by constraint name, or as Prisma's P2002 naming exactly the key's columns.
 */
export const PRIMARY_KEY_VIOLATION = [
  PRIMARY_KEY.name,
  'Unique constraint failed on the fields: (`actor_id`,`idempotency_key`)',
];

const count = (variable, from, where) => `
  SELECT count(*) INTO ${variable} FROM ${from}
   WHERE ${where};`;

/**
 * A DO block that raises unless the migration is in exactly the state claimed.
 *
 * `prisma db execute` reports no rows, only an exit status, so every assertion
 * has to be an error the database raises. That is a feature here: the failure
 * message names the object and the value found, not "expected 7, got 6".
 *
 * `present: false` is not the negation of the wording — it inverts what is
 * asserted. The table must be gone, its ledger row must be gone, and *every*
 * survivor and every other ledger row must still be there. A down script that
 * dropped the table and took `idempotency_key` or the refusal outbox with it
 * would pass a table-only absence check and fail here.
 *
 * `otherMigrations` is supplied by the caller from the migrations directory
 * rather than hard-coded, so a later identity migration does not have to be
 * remembered here to be protected: whatever the chain contains, everything in
 * it except this migration must keep its ledger row across the rollback.
 */
export function assertState({ present, otherMigrations = [] }) {
  const has = (yes) => (yes ? 'must exist' : 'must be gone');
  const table = (name) => `
${count('n', 'information_schema.tables', `table_schema = current_schema() AND table_name = '${literal(name)}'`)}
  IF n <> 1 THEN
    RAISE EXCEPTION 'table % must be unaffected by this rollback', '${literal(name)}';
  END IF;`;

  const shape = present
    ? `
${count('n', `information_schema.columns`, `table_schema = current_schema() AND table_name = '${TABLE}'`)}
  IF n <> ${COLUMNS.length} THEN
    RAISE EXCEPTION '${TABLE} must have exactly ${COLUMNS.length} columns, found %', n;
  END IF;
${COLUMNS.map(
  ({ name, signature }) => `
  SELECT format('%s|%s|%s|%s|%s', data_type,
                coalesce(character_maximum_length::text, '-'),
                coalesce(datetime_precision::text, '-'),
                is_nullable,
                coalesce(column_default, '-'))
    INTO txt FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = '${TABLE}'
     AND column_name = '${literal(name)}';
  IF txt IS DISTINCT FROM '${literal(signature)}' THEN
    RAISE EXCEPTION 'column ${literal(name)} must be ${literal(signature)}, found %',
      coalesce(txt, '<no such column>');
  END IF;`,
).join('')}

  SELECT pg_get_constraintdef(c.oid) INTO txt FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace s ON s.oid = r.relnamespace
   WHERE s.nspname = current_schema() AND r.relname = '${TABLE}'
     AND c.contype = 'p' AND c.conname = '${PRIMARY_KEY.name}';
  IF txt IS DISTINCT FROM '${literal(PRIMARY_KEY.definition)}' THEN
    RAISE EXCEPTION '${PRIMARY_KEY.name} must be ${literal(PRIMARY_KEY.definition)}, found %',
      coalesce(txt, '<no such constraint>');
  END IF;`
    : '';

  return `
DO $$
DECLARE n INT; txt TEXT;
BEGIN
${count('n', 'information_schema.tables', `table_schema = current_schema() AND table_name = '${TABLE}'`)}
  IF n <> ${present ? 1 : 0} THEN
    RAISE EXCEPTION 'table ${TABLE} ${has(present)}';
  END IF;
${shape}

${count('n', '_prisma_migrations', `migration_name = '${MIGRATION}'`)}
  IF n <> ${present ? 1 : 0} THEN
    RAISE EXCEPTION '_prisma_migrations row for ${MIGRATION} ${has(present)}';
  END IF;
${otherMigrations
  .map(
    (name) => `
${count('n', '_prisma_migrations', `migration_name = '${literal(name)}'`)}
  IF n <> 1 THEN
    RAISE EXCEPTION 'the ledger row for % must be untouched by this rollback', '${literal(name)}';
  END IF;`,
  )
  .join('')}
${count('n', '_prisma_migrations', 'TRUE')}
  IF n <> ${otherMigrations.length + (present ? 1 : 0)} THEN
    RAISE EXCEPTION 'the ledger must hold exactly % rows, found %',
      ${otherMigrations.length + (present ? 1 : 0)}, n;
  END IF;
${SURVIVORS.tables.map(table).join('')}
${SURVIVORS.indexes
  .map(
    (name) => `
${count('n', 'pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace', `s.nspname = current_schema() AND c.relname = '${literal(name)}' AND c.relkind IN ('i', 'I')`)}
  IF n <> 1 THEN
    RAISE EXCEPTION 'index % must be unaffected by this rollback', '${literal(name)}';
  END IF;`,
  )
  .join('')}
${SURVIVORS.constraints
  .map(
    (name) => `
${count('n', 'pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace', `s.nspname = current_schema() AND c.conname = '${literal(name)}'`)}
  IF n <> 1 THEN
    RAISE EXCEPTION 'constraint % must be unaffected by this rollback', '${literal(name)}';
  END IF;`,
  )
  .join('')}
${SURVIVORS.triggers
  .map(
    (name) => `
${count('n', 'pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace s ON s.oid = r.relnamespace', `s.nspname = current_schema() AND t.tgname = '${literal(name)}' AND NOT t.tgisinternal`)}
  IF n <> 1 THEN
    RAISE EXCEPTION 'trigger % must be unaffected by this rollback', '${literal(name)}';
  END IF;`,
  )
  .join('')}
${SURVIVORS.functions
  .map(
    (name) => `
${count('n', 'pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace', `s.nspname = current_schema() AND p.proname = '${literal(name)}'`)}
  IF n <> 1 THEN
    RAISE EXCEPTION 'function % must be unaffected by this rollback', '${literal(name)}';
  END IF;`,
  )
  .join('')}
END
$$;`;
}
