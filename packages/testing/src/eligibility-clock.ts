import assert from 'node:assert/strict';
import type { RawSqlClient } from './runtime-role';

type TestPrisma = { client: Pick<RawSqlClient, '$executeRawUnsafe'> };

/**
 * Millisecond timestamp columns round now() forward as well as backward.
 * Use a full second of margin for cross-statement eligibility, never a zero
 * lease/backoff. Exact boundary tests instead need one transaction and clock.
 * Only the explicitly supplied fixture ids are changed, in this service's DB.
 */
export async function expireClaim(
  prisma: TestPrisma,
  ids: readonly string[],
  table: 'outbox_message' | 'notification_intent' = 'outbox_message',
): Promise<void> {
  const sql = {
    outbox_message: `UPDATE outbox_message SET claim_expires_at = now() - interval '1 second'
      WHERE id = ANY($1::text[])`,
    notification_intent: `UPDATE notification_intent SET claim_expires_at = now() - interval '1 second'
      WHERE id = ANY($1::text[])`,
  };
  assert.ok(Object.hasOwn(sql, table), 'unknown eligibility table');
  const updated = await prisma.client.$executeRawUnsafe(sql[table], [...ids]);
  assert.equal(updated, new Set(ids).size, 'expireClaim must update every requested fixture');
}

/** The allowlist keeps SQL identifiers static; ids remain bound parameters. */
export async function makeDue(
  prisma: TestPrisma,
  ids: readonly string[],
  table: 'outbox_message' | 'policy_reconciliation_task' = 'outbox_message',
): Promise<void> {
  const sql = {
    outbox_message: `UPDATE outbox_message SET next_attempt_at = now() - interval '1 second'
      WHERE id = ANY($1::text[])`,
    policy_reconciliation_task: `UPDATE policy_reconciliation_task
      SET next_attempt_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  };
  assert.ok(Object.hasOwn(sql, table), 'unknown eligibility table');
  const updated = await prisma.client.$executeRawUnsafe(sql[table], [...ids]);
  assert.equal(updated, new Set(ids).size, 'makeDue must update every requested fixture');
}
