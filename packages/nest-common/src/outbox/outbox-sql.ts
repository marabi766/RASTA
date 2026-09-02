import type { OutboxRow } from './outbox';

/**
 * The SQL behind every service's outbox store.
 *
 * All eight implemented services had a byte-identical `outbox.store.ts`, so a
 * correctness fix had to be applied — correctly — eight times. This module
 * holds the statements once.
 *
 * It stays inside A-03: there is no business rule here and no service reaches
 * another service's database (A-01). The caller supplies its **own** client,
 * and the statements name only `outbox_message`, a table every service owns a
 * private copy of. What lives here is the wire format of the claim protocol —
 * a contract, in the same sense as an event schema.
 *
 * Every value is bound as a parameter. Nothing is interpolated into SQL (S-05).
 */

/**
 * The subset of a Prisma client these statements need.
 *
 * Deliberately structural rather than an import of `PrismaClient`: this package
 * must not depend on any one service's generated client, and eight different
 * generated clients have to satisfy it.
 */
export interface OutboxSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** The columns the relay needs, in the order every statement returns them. */
const ROW_COLUMNS = `id, aggregate_type, aggregate_id, event_name, event_version,
       topic, partition_key, payload, headers, organization_id,
       correlation_id, created_at, published_at, attempts, last_error`;

export interface RawOutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_name: string;
  event_version: number;
  topic: string;
  partition_key: string;
  payload: unknown;
  headers: unknown;
  organization_id: string | null;
  correlation_id: string;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

export function toOutboxRow(row: RawOutboxRow): OutboxRow {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventName: row.event_name,
    eventVersion: row.event_version,
    topic: row.topic,
    partitionKey: row.partition_key,
    payload: row.payload,
    headers: (row.headers ?? {}) as Record<string, string>,
    organizationId: row.organization_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/**
 * Selects up to `limit` unpublished rows.
 *
 * `FOR UPDATE SKIP LOCKED` keeps two concurrent claimers off the same row
 * *for the duration of this statement*. It does not reserve anything beyond
 * it: the row lock dies with the transaction, which ends when this query
 * returns (D-026).
 */
export async function claimPendingSql(
  client: OutboxSqlClient,
  limit: number,
): Promise<OutboxRow[]> {
  const rows = await client.$queryRawUnsafe<RawOutboxRow[]>(
    `SELECT ${ROW_COLUMNS}
       FROM outbox_message
      WHERE published_at IS NULL
      ORDER BY created_at
      LIMIT $1
        FOR UPDATE SKIP LOCKED`,
    limit,
  );
  return rows.map(toOutboxRow);
}

export async function markPublishedSql(
  client: OutboxSqlClient,
  ids: readonly string[],
  publishedAt: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  return client.$executeRawUnsafe(
    `UPDATE outbox_message SET published_at = $1 WHERE id = ANY($2::text[])`,
    publishedAt,
    [...ids],
  );
}

export async function markFailedSql(
  client: OutboxSqlClient,
  id: string,
  error: string,
): Promise<number> {
  return client.$executeRawUnsafe(
    `UPDATE outbox_message
        SET attempts = attempts + 1, last_error = $2
      WHERE id = $1`,
    id,
    error,
  );
}

export async function oldestPendingAgeSecondsSql(client: OutboxSqlClient): Promise<number> {
  const result = await client.$queryRawUnsafe<{ age: number | null }[]>(
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float8 AS age
       FROM outbox_message
      WHERE published_at IS NULL`,
  );
  return result[0]?.age ?? 0;
}
