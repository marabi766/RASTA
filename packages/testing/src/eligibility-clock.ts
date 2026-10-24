import type { RawSqlClient } from './runtime-role';

type TestPrisma = { client: Pick<RawSqlClient, '$executeRawUnsafe'> };

/**
 * Millisecond timestamp columns round now() forward as well as backward.
 * Use a full second of margin for cross-statement eligibility, never a zero
 * lease/backoff. Exact boundary tests instead need one transaction and clock.
 * Only the explicitly supplied fixture ids are changed, in this service's DB.
 */
export async function expireClaim(prisma: TestPrisma, ids: readonly string[]): Promise<void> {
  await prisma.client.$executeRawUnsafe(
    `UPDATE outbox_message SET claim_expires_at = now() - interval '1 second'
      WHERE id = ANY($1::text[])`,
    [...ids],
  );
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
  await prisma.client.$executeRawUnsafe(sql[table], [...ids]);
}
