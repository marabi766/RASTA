import { type MeterCertificate } from '@rasta/contracts';
import { readMeterCertificate, verifyMeterCertificate } from './meter-certificate';
import { z } from 'zod';
import {
  createSystemContext,
  internalGet,
  runUnscoped,
  runWithContext,
  type InternalGetOptions,
} from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { usageRecordedSchema } from './events';
import {
  calculateLedgerMeter,
  insertUsageEntry,
  lockUsageMeter,
  UsageMeterRefusal,
} from './usage-meter';
import { assessDue, isAnnounceable } from './due';
import { toRule } from './schedule.service';
import { formatHundredths, parseHundredths } from './quantity';

const CERTIFICATE_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 200;
const MAX_PAGES = 1000;
const MAX_RECORDS = 20_000;
const ASSET_PAGE_SIZE = 200;
const sourceRow = z
  .object({
    hours: usageRecordedSchema.shape.hours.unwrap(),
    kilometres: usageRecordedSchema.shape.kilometres.unwrap(),
    hourMeter: usageRecordedSchema.shape.hourMeter.unwrap(),
    odometer: usageRecordedSchema.shape.odometer.unwrap(),
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    organizationId: z.string().min(1).max(64),
    periodStart: z.iso.datetime({ offset: true }),
    periodEnd: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((r) => new Date(r.periodStart) < new Date(r.periodEnd));
const sourcePage = z
  .object({
    items: z.array(sourceRow).max(PAGE_SIZE),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(1024).nullable(),
  })
  .strict();
export type MeterUsagePage = z.infer<typeof sourcePage>;
export interface MeterUsageSource {
  certificate?(organizationId: string, assetId: string): Promise<MeterCertificate>;
  page(organizationId: string, assetId: string, cursor?: string): Promise<MeterUsagePage>;
}
export class MeterUsageClient implements MeterUsageSource {
  constructor(private readonly options: Omit<InternalGetOptions, 'from' | 'to'>) {}
  async certificate(organizationId: string, assetId: string): Promise<MeterCertificate> {
    const query = new URLSearchParams({ assetId });
    const response = await internalGet(
      {
        ...this.options,
        from: 'maintenance-service',
        to: 'fleet-service',
        maxBodyBytes: this.options.maxBodyBytes ?? CERTIFICATE_MAX_BYTES,
      },
      `/v1/internal/usage-records/certificate?${query}`,
      organizationId,
    );
    if (response.status !== 200) throw new Error('SOURCE_READ_FAILED');
    return readMeterCertificate(response.body, assetId);
  }
  async page(organizationId: string, assetId: string, cursor?: string): Promise<MeterUsagePage> {
    const query = new URLSearchParams({ assetId, limit: String(PAGE_SIZE) });
    if (cursor !== undefined) query.set('cursor', cursor);
    const response = await internalGet(
      { ...this.options, from: 'maintenance-service', to: 'fleet-service' },
      `/v1/internal/usage-records?${query}`,
      organizationId,
    );
    if (response.status !== 200) throw new Error('SOURCE_READ_FAILED');
    return sourcePage.parse(response.body);
  }
}
type Quantities = { hours: string; kilometres: string };
export interface MeterReconcileAssetReport {
  organizationId: string;
  assetId: string;
  M: Quantities | null;
  L: Quantities | null;
  diff: Quantities | null;
  schedulesWouldAnnounce: string[];
  recordsRead: number;
  pagesExhausted: boolean;
  snapshotVerified: boolean;
  sourceSnapshot: string | null;
  /** A live cursor supplies no snapshot or future-write fence. Still false until the durable live-write handoff and inventory are proven. */
  sourceComplete: false;
  refusal: string;
}
class PreviewComplete extends Error {
  constructor(readonly report: MeterReconcileAssetReport) {
    super('PREVIEW_ROLLBACK');
  }
}

/** Read-only operator preview. Every tentative ledger/meter insert is rolled back. */
export class MeterReconcile {
  constructor(
    private readonly prisma: PrismaService,
    private readonly source: MeterUsageSource,
  ) {}

  async report(
    organizationId: string,
    now = new Date(),
  ): Promise<{
    organizationId: string;
    dryRun: true;
    sourceComplete: false;
    assets: MeterReconcileAssetReport[];
  }> {
    const assets: MeterReconcileAssetReport[] = [];
    let after = '';
    for (;;) {
      const rows = await this.assets(organizationId, after, ASSET_PAGE_SIZE);
      for (const { id } of rows) assets.push(await this.reportAsset(organizationId, id, now));
      if (rows.length < ASSET_PAGE_SIZE) break;
      const last = rows.at(-1);
      if (!last) break;
      after = last.id;
    }
    return { organizationId, dryRun: true, sourceComplete: false, assets };
  }

  async reportAsset(
    organizationId: string,
    assetId: string,
    now = new Date(),
  ): Promise<MeterReconcileAssetReport> {
    const report: MeterReconcileAssetReport = {
      organizationId,
      assetId,
      M: null,
      L: null,
      diff: null,
      schedulesWouldAnnounce: [],
      recordsRead: 0,
      pagesExhausted: false,
      snapshotVerified: false,
      sourceSnapshot: null,
      sourceComplete: false,
      refusal: 'CUTOVER_PROOF_REQUIRED',
    };
    // Partition reports by the current local asset owner. Orphan meters are included
    // under their last recorded tenant; this is an operator report, not authorization.
    if (!(await this.assets(organizationId, '', 1, assetId)).length)
      return { ...report, refusal: 'ASSET_NOT_IN_TENANT' };
    const records: MeterUsagePage['items'] = [];
    let certificate: MeterCertificate | undefined;
    try {
      if (this.source.certificate) {
        certificate = readMeterCertificate(
          await this.source.certificate(organizationId, assetId),
          assetId,
        );
        records.push(...certificate.facts);
        report.sourceSnapshot = certificate.snapshot;
      } else {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        const ids = new Set<string>();
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = sourcePage.parse(await this.source.page(organizationId, assetId, cursor));
          for (const row of result.items) {
            if (ids.has(row.id) || records.length >= MAX_RECORDS)
              throw new Error('SOURCE_READ_FAILED');
            ids.add(row.id);
            records.push(row);
          }
          if (!result.hasMore) {
            if (result.nextCursor !== null) throw new Error('SOURCE_READ_FAILED');
            report.pagesExhausted = true;
            break;
          }
          if (!result.nextCursor || cursors.has(result.nextCursor))
            throw new Error('SOURCE_READ_FAILED');
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        if (!report.pagesExhausted) throw new Error('SOURCE_READ_FAILED');
      }
    } catch {
      return { ...report, recordsRead: records.length, refusal: 'SOURCE_READ_FAILED' };
    }
    report.recordsRead = records.length;
    try {
      await runWithContext(
        createSystemContext({
          organizationId,
          callerService: 'maintenance-service',
          correlationId: 'maintenance-meter-reconcile',
        }),
        async () =>
          this.prisma.transaction(
            async (tx) => {
              for (const row of records)
                await insertUsageEntry(tx, {
                  assetId,
                  organizationId: row.organizationId,
                  usageRecordId: row.id,
                  periodStart: new Date(row.periodStart),
                  periodEnd: new Date(row.periodEnd),
                  hoursDelta: row.hours ?? '0',
                  kilometresDelta: row.kilometres ?? '0',
                  reportedHourMeter: row.hourMeter ?? null,
                  reportedOdometer: row.odometer ?? null,
                  now,
                });
              const meter = await lockUsageMeter(tx, { assetId, organizationId, now });
              report.M = { hours: meter.hour_meter, kilometres: meter.odometer };
              if (certificate) {
                await verifyMeterCertificate(tx, certificate);
                report.snapshotVerified = true;
              }
              const ledger = await calculateLedgerMeter(tx, assetId);
              report.L = { hours: ledger.hour_meter, kilometres: ledger.odometer };
              report.diff = {
                hours: difference(ledger.hour_meter, meter.hour_meter),
                kilometres: difference(ledger.odometer, meter.odometer),
              };
              const schedules = await tx.maintenanceSchedule.findMany({
                where: { organizationId, assetId, status: 'ACTIVE', dueAnnouncedAt: null },
                orderBy: { id: 'asc' },
              });
              report.schedulesWouldAnnounce = schedules
                .filter((s) =>
                  isAnnounceable(
                    assessDue(
                      toRule(s),
                      {
                        hourMeter: ledger.hour_meter,
                        odometer: ledger.odometer,
                      },
                      now,
                    ),
                  ),
                )
                .map((s) => s.id);
              throw new PreviewComplete(report);
            },
            { timeoutMs: 30_000 },
          ),
      );
    } catch (error) {
      if (error instanceof PreviewComplete) return error.report;
      return {
        ...report,
        L: null,
        diff: null,
        schedulesWouldAnnounce: [],
        snapshotVerified: false,
        refusal:
          error instanceof UsageMeterRefusal
            ? error.code
            : error instanceof Error && error.message === 'SOURCE_LEDGER_MISMATCH'
              ? 'SOURCE_LEDGER_MISMATCH'
              : 'PREVIEW_FAILED',
      };
    }
    throw new Error('PREVIEW_DID_NOT_ROLL_BACK');
  }

  private async assets(
    organizationId: string,
    after: string,
    limit: number,
    assetId: string | null = null,
  ): Promise<{ id: string }[]> {
    return runUnscoped(
      'operator dry-run inventory; explicit tenant partition; no completeness claim',
      async () =>
        this.prisma.client.$queryRaw<{ id: string }[]>`
        SELECT id FROM (
          SELECT id FROM asset_ref WHERE organization_id = ${organizationId}
          UNION
          SELECT asset_id AS id FROM asset_usage_meter m WHERE organization_id = ${organizationId}
            AND NOT EXISTS (SELECT 1 FROM asset_ref a WHERE a.id = m.asset_id)
        ) assets WHERE id > ${after} AND (${assetId}::text IS NULL OR id = ${assetId})
        ORDER BY id LIMIT ${limit}`,
    );
  }
}
function difference(a: string, b: string): string {
  const x = parseHundredths(a);
  const y = parseHundredths(b);
  if (x === null || y === null) throw new Error('METER_OUT_OF_RANGE');
  return formatHundredths(x - y);
}
