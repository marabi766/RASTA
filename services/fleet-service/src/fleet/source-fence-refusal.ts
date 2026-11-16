import { DLQ_REASONS } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import { Prisma } from '../generated/prisma';

/** Only a proven statement refusal, called inside the transaction, never on its commit result. */
export function sourceFenceRefusal(error: unknown): UnprocessableEventError | undefined {
  if (!(error instanceof Prisma.PrismaClientUnknownRequestError)) return undefined;
  // Prisma's model API exposes a trigger's SQLSTATE only in the connector error.
  // Match its exact database message, not a code mentioned in a query/payload excerpt.
  const reason =
    /QueryError\(PostgresError \{ code: "P0001", message: "(SOURCE_OWNER_DRIFT|SOURCE_INVENTORY_SEALED)", severity: "ERROR", detail: None, column: None, hint: None \}\), transient: false \}\)$/.exec(
      error.message,
    )?.[1];
  if (reason !== DLQ_REASONS.SOURCE_OWNER_DRIFT && reason !== DLQ_REASONS.SOURCE_INVENTORY_SEALED)
    return undefined;
  // Fixed text only: the driver error may include payload values and another tenant's owner.
  return new UnprocessableEventError(reason, reason);
}
