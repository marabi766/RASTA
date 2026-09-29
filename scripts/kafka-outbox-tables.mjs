#!/usr/bin/env node
/**
 * Every service-owned transactional outbox table, read from the services'
 * Prisma schemas — for the rebuild gate in
 * docs/runbooks/kafka-credential-rotation.md § D: before a broker's data is
 * wiped, every one of these holds no unpublished row (RUN-006, review of
 * #131). Prints one line per table with the query to run in that service's
 * database:
 *
 *   node scripts/kafka-outbox-tables.mjs
 *
 * An outbox is a model whose table name contains `outbox` and that has a
 * `published_at` column. A `published_at` that is a domain fact rather than a
 * relay's bookkeeping is listed in DOMAIN_PUBLISHED_AT; the test fails on any
 * other, so a new outbox cannot be missed silently.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tables with a `published_at` that is not an outbox's: `service table`. */
export const DOMAIN_PUBLISHED_AT = [
  'marketplace-service offer',
  'notification-service notification_template_version',
];

/** Models in one Prisma schema with a `published_at`, as `{ model, table, schema }`. */
export function publishedAtTables(prisma) {
  const tables = [];
  for (const match of prisma.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const body = match[2];
    if (!/@map\("published_at"\)/.test(body)) continue;
    tables.push({
      model: match[1],
      table: /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? match[1],
      schema: /@@schema\("([^"]+)"\)/.exec(body)?.[1] ?? null,
    });
  }
  return tables;
}

/** Every service's outbox tables, and any `published_at` table that is neither. */
export function outboxTables(root) {
  const outboxes = [];
  const unclassified = [];
  const servicesDir = join(root, 'services');
  for (const service of readdirSync(servicesDir).sort()) {
    const file = join(servicesDir, service, 'prisma', 'schema.prisma');
    if (!existsSync(file)) continue;
    for (const entry of publishedAtTables(readFileSync(file, 'utf8'))) {
      const id = `${service} ${entry.table}`;
      if (entry.table.includes('outbox')) outboxes.push({ service, ...entry });
      else if (!DOMAIN_PUBLISHED_AT.includes(id)) unclassified.push(id);
    }
  }
  return { outboxes, unclassified };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { outboxes, unclassified } = outboxTables(root);
  if (unclassified.length > 0) {
    process.stderr.write(
      `kafka outbox tables: published_at on ${unclassified.join(', ')} — an outbox, or a domain fact? ` +
        'Classify it in scripts/kafka-outbox-tables.mjs.\n',
    );
    process.exit(1);
  }
  for (const { service, table, schema } of outboxes) {
    const qualified = schema ? `${schema}.${table}` : table;
    process.stdout.write(
      `${service}\tSELECT count(*) FROM ${qualified} WHERE published_at IS NULL;\n`,
    );
  }
}
