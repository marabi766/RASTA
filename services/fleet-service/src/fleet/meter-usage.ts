import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getContext, RastaError } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { FleetRepository } from './fleet.repository';
import { canonicalInstant, listMeterUsageQuerySchema, type ListMeterUsageQuery } from './dto';

export const METER_USAGE_CALLER = 'maintenance-service';
const cursorPayload = z.tuple([
  listMeterUsageQuerySchema.shape.assetId,
  z.iso.datetime().refine((value) => canonicalInstant(value) === value),
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
]);

export interface MeterUsageView {
  id: string;
  organizationId: string;
  periodStart: string;
  periodEnd: string;
  hours: string | null;
  kilometres: string | null;
  hourMeter: string | null;
  odometer: string | null;
}
export type MeterUsagePage = CursorPage<MeterUsageView>;

export const meterUsagePageSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          organizationId: z.string(),
          periodStart: z.iso.datetime(),
          periodEnd: z.iso.datetime(),
          hours: z.string().nullable(),
          kilometres: z.string().nullable(),
          hourMeter: z.string().nullable(),
          odometer: z.string().nullable(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

/**
 * ADR-073 § 4 F: maintenance reconciles the physical meter across asset owners.
 * Deliberate tenant exception, behind BOTH the route allowlist and this check.
 * No notes, driver, subject, reference or reward/source-fact fields leave here.
 */
@Injectable()
export class MeterUsageService {
  constructor(private readonly repository: FleetRepository) {}

  async list(query: ListMeterUsageQuery): Promise<MeterUsagePage> {
    const context = getContext();
    if (context.authType !== 'SERVICE' || context.callerService !== METER_USAGE_CALLER) {
      throw RastaError.forbidden('This endpoint is reserved for the maintenance meter consumer');
    }
    // Also validate direct service calls; omission or a bad cursor never means "start over".
    const parsed = listMeterUsageQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidCursor();
    const { assetId, cursor, limit } = parsed.data;
    const after = cursor === undefined ? undefined : this.decode(cursor, assetId);
    if (after && !(await this.repository.hasMeterUsageCursor(assetId, after)))
      throw invalidCursor();
    const rows = await this.repository.listMeterUsage(assetId, limit, after);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      hours: row.hours,
      kilometres: row.kilometres,
      hourMeter: row.hourMeter,
      odometer: row.odometer,
    }));
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? this.encode(assetId, last.periodEnd, last.id) : null,
    };
  }

  private encode(assetId: string, end: string, id: string): string {
    return Buffer.from(JSON.stringify(cursorPayload.parse([assetId, end, id]))).toString(
      'base64url',
    );
  }

  private decode(cursor: string, assetId: string): { end: Date; id: string } {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
      const decoded = Buffer.from(cursor, 'base64url');
      if (decoded.toString('base64url') !== cursor) throw invalidCursor();
      const [boundAsset, end, id] = cursorPayload.parse(JSON.parse(decoded.toString('utf8')));
      if (boundAsset !== assetId) throw invalidCursor();
      return { end: new Date(end), id };
    } catch {
      throw invalidCursor();
    }
  }
}

function invalidCursor(): RastaError {
  return RastaError.validation([], 'Invalid meter usage query or cursor');
}
