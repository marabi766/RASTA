import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getContext, RastaError, runUnscoped } from '@rasta/nest-common';
import {
  canonicalMeterCertificate,
  METER_CERTIFICATE_LIMIT,
  meterCertificateQuerySchema,
  meterCertificateSchema,
  type MeterCertificate,
} from '@rasta/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { METER_USAGE_CALLER } from './meter-usage';

/** Snapshot proof only: does not certify subsequent writes or authorize cutover. */
@Injectable()
export class MeterCertificateService {
  constructor(private readonly prisma: PrismaService) {}

  async certificate(query: { assetId: string }): Promise<MeterCertificate> {
    const context = getContext();
    if (context.authType !== 'SERVICE' || context.callerService !== METER_USAGE_CALLER)
      throw RastaError.forbidden('Reserved for the maintenance meter consumer');
    const { assetId } = meterCertificateQuerySchema.parse(query);
    return runUnscoped('physical meter snapshot spans owners; maintenance-service only', async () =>
      this.prisma.client.$transaction(
        async (tx) => {
          // This first statement fixes the snapshot, including in-progress source writes.
          const [marker] = await tx.$queryRaw<{ snapshot: string }[]>`
          SELECT pg_current_snapshot()::text AS snapshot`;
          const rows = await tx.usageRecord.findMany({
            where: { assetId },
            orderBy: { id: 'asc' },
            take: METER_CERTIFICATE_LIMIT + 1,
            select: {
              id: true,
              organizationId: true,
              periodStart: true,
              periodEnd: true,
              hours: true,
              kilometres: true,
              hourMeter: true,
              odometer: true,
            },
          });
          const facts = rows.map((r) => ({
            ...r,
            periodStart: r.periodStart.toISOString(),
            periodEnd: r.periodEnd.toISOString(),
            hours: r.hours?.toString() ?? null,
            kilometres: r.kilometres?.toString() ?? null,
            hourMeter: r.hourMeter?.toString() ?? null,
            odometer: r.odometer?.toString() ?? null,
          }));
          // Refuse overflow/malformed history. Never truncate into a certificate.
          const body = meterCertificateSchema.parse({
            version: 1,
            assetId,
            snapshot: marker.snapshot,
            facts,
            digest: '0'.repeat(64),
          });
          return {
            ...body,
            digest: createHash('sha256').update(canonicalMeterCertificate(body)).digest('hex'),
          };
        },
        { isolationLevel: 'RepeatableRead', timeout: 30_000 },
      ),
    );
  }
}
