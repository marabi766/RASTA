import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outboxTables, publishedAtTables } from './kafka-outbox-tables.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('every service outbox is found, identity’s security-event outbox included', () => {
  const { outboxes, unclassified } = outboxTables(ROOT);
  assert.deepEqual(unclassified, []);
  const ids = outboxes.map(({ service, table }) => `${service} ${table}`);
  assert.ok(ids.includes('identity-service security_event_outbox'));
  for (const service of [
    'asset',
    'construction',
    'document',
    'economic',
    'fleet',
    'identity',
    'maintenance',
    'marketplace',
    'notification',
    'organization',
    'supplier',
  ]) {
    assert.ok(ids.includes(`${service}-service outbox_message`), service);
  }
});

test('a published_at table that is neither an outbox nor a known domain field is not missed', () => {
  const prisma = [
    'model Foo {\n  publishedAt DateTime? @map("published_at")\n  @@map("foo_relay")\n}',
    'model Bar {\n  publishedAt DateTime? @map("published_at")\n  @@map("bar_outbox")\n  @@schema("bar")\n}',
    'model Baz {\n  name String\n}',
  ].join('\n');
  assert.deepEqual(publishedAtTables(prisma), [
    { model: 'Foo', table: 'foo_relay', schema: null },
    { model: 'Bar', table: 'bar_outbox', schema: 'bar' },
  ]);
});

test('the command prints one query per outbox and nothing unclassified', () => {
  const result = spawnSync('node', [resolve(ROOT, 'scripts/kafka-outbox-tables.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, outboxTables(ROOT).outboxes.length);
  assert.ok(
    lines.some((line) =>
      /^identity-service\tSELECT count\(\*\) FROM security_event_outbox WHERE published_at IS NULL;$/.test(
        line,
      ),
    ),
  );
});
