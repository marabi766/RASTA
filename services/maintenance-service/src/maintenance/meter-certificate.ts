import { createHash } from 'node:crypto';
import { runUnscoped } from '@rasta/nest-common';
import {
  canonicalMeterCertificate,
  METER_CERTIFICATE_LIMIT,
  meterCertificateSchema,
  type MeterCertificate,
} from '@rasta/contracts';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

export function readMeterCertificate(value: unknown, assetId: string): MeterCertificate {
  const c = meterCertificateSchema.parse(value);
  if (c.assetId !== assetId || digest(c) !== c.digest)
    throw new Error('SOURCE_CERTIFICATE_INVALID');
  return c;
}
function digest(c: Omit<MeterCertificate, 'digest'>): string {
  return createHash('sha256').update(canonicalMeterCertificate(c)).digest('hex');
}

/** Caller holds lockUsageMeter; only SELECTs here, never waits on a fact insert. */
export async function verifyMeterCertificate(
  tx: ExtendedPrismaClient,
  c: MeterCertificate,
): Promise<void> {
  await runUnscoped(
    'physical meter verification spans historical owners under the meter lock',
    async () => {
      const rows = await tx.assetUsageEntry.findMany({
        where: { assetId: c.assetId },
        orderBy: { usageRecordId: 'asc' },
        take: METER_CERTIFICATE_LIMIT + 1,
      });
      const facts = rows.map((r) => ({
        id: r.usageRecordId,
        organizationId: r.organizationId,
        periodStart: r.periodStart?.toISOString(),
        periodEnd: r.periodEnd?.toISOString(),
        hours: r.hours.toString(),
        kilometres: r.kilometres.toString(),
        hourMeter: r.hourMeter?.toString() ?? null,
        odometer: r.odometer?.toString() ?? null,
      }));
      // Revalidates every identity/interval/quantity, not just count or the supplied digest.
      const ledger = meterCertificateSchema.safeParse({ ...c, facts });
      if (!ledger.success || digest(ledger.data) !== c.digest)
        throw new Error('SOURCE_LEDGER_MISMATCH');
    },
  );
}
