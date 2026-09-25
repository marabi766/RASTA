import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPTIONS,
  SERVICES,
  checkTenantIndexOrder,
  readMigrationTexts,
  replayMigrations,
  stripNonDdl,
} from './check-tenant-index-order-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsOf = (service) =>
  readMigrationTexts(join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations'));

const TENANT_TABLE = `CREATE TABLE "t" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "parent_id" TEXT,
  CONSTRAINT "t_pkey" PRIMARY KEY ("id")
);`;

const check = (sql, exemptions = {}) => checkTenantIndexOrder(replayMigrations([sql]), exemptions);

for (const service of SERVICES) {
  test(`${service}-service: every composite tenant index leads with organization_id or is exempted`, () => {
    const { errors, checked } = checkTenantIndexOrder(
      replayMigrations(migrationsOf(service)),
      EXEMPTIONS[service] ?? {},
    );
    assert.deepEqual(errors, []);
    assert.ok(checked > 0, 'an empty check proves nothing');
  });
}

// The four keys L7-44 found, each as it stood before its fix migration. If the
// fix migration is removed, reverted or reordered, these come back.
test('the pre-fix notification and document keys are refused', () => {
  const withoutFix = (service, fix) =>
    replayMigrations(
      readMigrationTexts(
        join(ROOT, 'services', `${service}-service`, 'prisma', 'migrations'),
      ).filter((text) => !text.includes(fix)),
    );
  const notification = checkTenantIndexOrder(
    withoutFix('notification', 'L7-44'),
    EXEMPTIONS.notification,
  );
  assert.deepEqual(notification.errors.map((error) => error.split(':')[0]).sort(), [
    'notification_quiet_hours_pkey',
    'ux_preference_global_channel',
    'ux_preference_owner_scope_channel',
  ]);
  const document = checkTenantIndexOrder(withoutFix('document', 'L7-44'), EXEMPTIONS.document);
  assert.deepEqual(
    document.errors.map((error) => error.split(':')[0]),
    ['ix_document_owner_resource'],
  );
});

test('the fixes keep what each key refuses, and drop only exact prefixes', () => {
  const { indexes } = replayMigrations(migrationsOf('notification'));
  assert.deepEqual(indexes.get('ux_preference_owner_scope_channel').columns, [
    'organization_id',
    'user_id',
    'scope',
    'scope_key',
    'channel',
  ]);
  assert.deepEqual(indexes.get('ux_preference_global_channel').columns, [
    'organization_id',
    'user_id',
    'channel',
  ]);
  assert.deepEqual(indexes.get('notification_quiet_hours_pkey').columns, [
    'organization_id',
    'user_id',
  ]);
  assert.equal(indexes.has('ix_preference_owner'), false);
  assert.equal(indexes.has('ix_quiet_hours_org'), false);

  const document = replayMigrations(migrationsOf('document')).indexes;
  assert.equal(document.has('ix_document_owner_resource'), false);
  assert.deepEqual(document.get('ix_document_org_owner_resource').columns, [
    'organization_id',
    'owner_resource_type',
    'owner_resource_id',
  ]);
});

test('refuses a composite index, unique index, primary key and unique constraint that lead elsewhere', () => {
  const { errors, checked } = check(`${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("user_id", "organization_id");
    CREATE UNIQUE INDEX "ux_b" ON "t" ("parent_id", "user_id") WHERE "parent_id" IS NOT NULL;
    ALTER TABLE "t" ADD CONSTRAINT "uq_c" UNIQUE ("user_id", "parent_id");
    CREATE TABLE "u" ("organization_id" TEXT, "k" TEXT, PRIMARY KEY ("k", "organization_id"));`);
  assert.equal(checked, 4);
  assert.deepEqual(
    errors.map((error) => error.split(':')[0]),
    ['ix_a', 'u_pkey', 'uq_c', 'ux_b'],
  );
});

test('accepts organization-leading and single-column indexes, and ignores non-tenant tables', () => {
  const { errors, checked } = check(`${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("organization_id", "user_id" DESC);
    CREATE INDEX "ix_b" ON "t"("parent_id");
    CREATE TABLE "plain" ("a" TEXT, "b" TEXT);
    CREATE INDEX "ix_plain" ON "plain"("a", "b");`);
  assert.deepEqual(errors, []);
  assert.equal(checked, 1);
});

test('a column added later makes a table tenant-owned', () => {
  const { errors } = check(`CREATE TABLE "t" ("id" TEXT, "user_id" TEXT);
    CREATE INDEX "ix_a" ON "t"("user_id", "id");
    ALTER TABLE "t" ADD COLUMN "organization_id" TEXT;`);
  assert.equal(errors.length, 1);
});

test('follows DROP INDEX, DROP CONSTRAINT, ALTER INDEX RENAME and DROP TABLE', () => {
  const { errors } = check(`${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("user_id", "id");
    DROP INDEX "ix_a";
    CREATE INDEX "ix_b" ON "t"("user_id", "id");
    ALTER INDEX "ix_b" RENAME TO "ix_c";
    ALTER TABLE "t" ADD CONSTRAINT "uq_d" UNIQUE ("user_id", "id");
    ALTER TABLE "t" DROP CONSTRAINT "uq_d";
    CREATE TABLE "gone" ("organization_id" TEXT, "k" TEXT);
    CREATE INDEX "ix_gone" ON "gone"("k", "organization_id");
    DROP TABLE "gone";`);
  assert.deepEqual(
    errors.map((error) => error.split(':')[0]),
    ['ix_c'],
  );
});

test('an exemption silences exactly its index; a stale or needless one is an error', () => {
  const sql = `${TENANT_TABLE}
    CREATE INDEX "ix_a" ON "t"("user_id", "id");
    CREATE INDEX "ix_ok" ON "t"("organization_id", "id");
    CREATE INDEX "ix_single" ON "t"("user_id");`;
  assert.deepEqual(check(sql, { ix_a: 'reason' }).errors, []);
  const stale = check(sql, { ix_a: 'r', ix_missing: 'r', ix_ok: 'r', ix_single: 'r' }).errors;
  assert.equal(stale.length, 3);
  assert.match(
    stale.find((e) => e.startsWith('ix_missing')),
    /no such index/,
  );
  assert.match(
    stale.find((e) => e.startsWith('ix_ok')),
    /already leads/,
  );
  assert.match(
    stale.find((e) => e.startsWith('ix_single')),
    /not composite/,
  );
});

test('the outbox is plumbing and is not judged', () => {
  const { errors, checked } =
    check(`CREATE TABLE "outbox_message" ("id" TEXT, "organization_id" TEXT, "created_at" TIMESTAMP);
    CREATE INDEX "ix_outbox_claimable" ON "outbox_message"("created_at", "id");`);
  assert.deepEqual(errors, []);
  assert.equal(checked, 0);
});

test('DDL inside comments, strings and function bodies is not DDL', () => {
  const sql = `${TENANT_TABLE}
    -- CREATE INDEX "ix_comment" ON "t"("user_id", "id");
    /* CREATE INDEX "ix_block" ON "t"("user_id", "id"); */
    DO $body$ BEGIN EXECUTE 'CREATE INDEX "ix_dyn" ON "t"("user_id", "id")'; END $body$;
    SELECT 'CREATE INDEX "ix_str" ON "t"(''user_id'', "id")';`;
  assert.deepEqual(check(sql).errors, []);
  assert.doesNotMatch(stripNonDdl(sql), /ix_comment|ix_block|ix_dyn|ix_str/);
});

test('reads unquoted identifiers, schema-qualified names and expression keys', () => {
  const { indexes } = replayMigrations([
    `CREATE TABLE public.audit_x (organization_id varchar, occurred_at timestamptz, id text,
       PRIMARY KEY (occurred_at, id)) PARTITION BY RANGE (occurred_at);
     CREATE INDEX audit_x_org_idx ON public.audit_x (organization_id, occurred_at DESC);
     CREATE INDEX ix_expr ON audit_x ((lower(id)), organization_id);`,
  ]);
  assert.deepEqual(indexes.get('audit_x_pkey').columns, ['occurred_at', 'id']);
  assert.deepEqual(indexes.get('audit_x_org_idx').columns, ['organization_id', 'occurred_at']);
  assert.equal(indexes.get('ix_expr').columns[0], '((lower(id)))');
});
