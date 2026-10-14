import type { PrismaService } from '../prisma/prisma.service';

/**
 * The asset-service half of the drain fence that guards a change of
 * `INSURANCE_COVERAGES_FOLLOWING_VEHICLE` (docs/runbooks/insurance-reprojection.md,
 * #240 round 5).
 *
 * An insurance event already in the outbox was built under the old following
 * rule. If it is published after fleet's `clear-transferred`, it recreates a
 * window the clear just removed. So, with every asset-service replica stopped
 * (nothing new can be produced), the outbox must hold **no unpublished row**
 * before the clear runs. Any row counts, not only insurance ones: a row the
 * relay has claimed but not acknowledged is also unpublished, and so is one it
 * keeps failing on — each of those would still reach the broker.
 */
export interface OutboxDrainReport {
  /** Rows with no `published_at`. Zero is the only value that lets the change go on. */
  unpublished: number;
  drained: boolean;
}

/**
 * @param organizationId  Narrows the count to one organization's rows. The
 *   command never passes it — the fence is about the whole outbox; it exists so
 *   a test can ask about its own rows on a database other suites share.
 */
export async function checkOutboxDrained(
  prisma: Pick<PrismaService, 'client'>,
  organizationId?: string,
): Promise<OutboxDrainReport> {
  const rows =
    organizationId === undefined
      ? await prisma.client.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM outbox_message WHERE published_at IS NULL`
      : await prisma.client.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM outbox_message
           WHERE published_at IS NULL AND organization_id = ${organizationId}`;
  const unpublished = rows[0]?.n ?? 0;
  return { unpublished, drained: unpublished === 0 };
}
