import {
  type MeterCertificate,
  maintenanceMeterReconciledPayloadV1,
  meterReconcileOperatorSchema,
  MAINTENANCE_METER_RECONCILED,
  MAINTENANCE_METER_RECONCILED_VERSION,
} from '@rasta/contracts';
import { ulid } from 'ulid';
import { MAINTENANCE_TOPIC } from '../config/env';
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
import { DueAnnouncerService } from './due-announcer.service';
import { MaintenanceRepository } from './maintenance.repository';

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
function readSourcePage(value: unknown): MeterUsagePage {
  const parsed = sourcePage.safeParse(value);
  if (!parsed.success) throw new UsageMeterRefusal('SOURCE_PAGE_MALFORMED');
  return parsed.data;
}
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
    return readSourcePage(response.body);
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
  /** Per-asset snapshot verified and committed with the durable outbox/lock handoff. */
  sourceComplete: boolean;
  outcome: 'PREVIEW' | 'REFUSED' | 'APPLIED' | 'UNCONFIRMED';
  refusal: string | null;
}
class PreviewComplete extends Error {
  constructor(readonly report: MeterReconcileAssetReport) {
    super('PREVIEW_ROLLBACK');
  }
}

/** Per-asset cutover. Global inventory/marker activation is a separate operation. */
export class MeterReconcile {
  private readonly runId = ulid();
  constructor(
    private readonly prisma: PrismaService,
    private readonly source: MeterUsageSource,
    private readonly announcer: Pick<
      DueAnnouncerService,
      'announceForAsset'
    > = new DueAnnouncerService(new MaintenanceRepository(prisma)),
    private readonly operatorId?: string,
  ) {}

  async report(
    organizationId: string,
    now = new Date(),
    apply = false,
  ): Promise<{
    organizationId: string;
    dryRun: boolean;
    sourceComplete: false;
    assets: MeterReconcileAssetReport[];
  }> {
    if (apply && !meterReconcileOperatorSchema.safeParse(this.operatorId).success)
      throw new Error('OPERATOR_ID_REQUIRED');
    const assets: MeterReconcileAssetReport[] = [];
    let after = '';
    for (;;) {
      const rows = await this.assets(organizationId, after, ASSET_PAGE_SIZE);
      for (const { id } of rows)
        assets.push(await this.reportAsset(organizationId, id, now, apply));
      if (rows.length < ASSET_PAGE_SIZE) break;
      const last = rows.at(-1);
      if (!last) break;
      after = last.id;
    }
    return { organizationId, dryRun: !apply, sourceComplete: false, assets };
  }

  async reportAsset(
    organizationId: string,
    assetId: string,
    now = new Date(),
    apply = false,
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
      outcome: 'REFUSED',
      refusal: 'CUTOVER_PROOF_REQUIRED',
    };
    if (apply && !meterReconcileOperatorSchema.safeParse(this.operatorId).success)
      return { ...report, refusal: 'OPERATOR_ID_REQUIRED' };
    // Partition reports by the current local asset owner. Orphan meters are included
    // under their last recorded tenant; this is an operator report, not authorization.
    if (!(await this.assets(organizationId, '', 1, assetId)).length)
      return { ...report, refusal: 'ASSET_NOT_IN_TENANT' };
    if (apply && !this.source.certificate) return report;
    const records: MeterUsagePage['items'] = [];
    let certificate: MeterCertificate | undefined;
    try {
      if (this.source.certificate) {
        certificate = readMeterCertificate(
          await this.source.certificate(organizationId, assetId),
          assetId,
        );
        if (
          apply &&
          !maintenanceMeterReconciledPayloadV1.shape.snapshot.safeParse(certificate.snapshot)
            .success
        )
          return { ...report, refusal: 'SNAPSHOT_NOT_AUDITABLE' };
        records.push(...certificate.facts);
        report.sourceSnapshot = certificate.snapshot;
      } else {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        const ids = new Set<string>();
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = readSourcePage(await this.source.page(organizationId, assetId, cursor));
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
    } catch (error) {
      // Source reads precede the transaction: no apply could have been sent.
      return {
        ...report,
        recordsRead: records.length,
        refusal: error instanceof UsageMeterRefusal ? error.code : 'SOURCE_READ_FAILED',
      };
    }
    report.recordsRead = records.length;
    let callbackReturned = false;
    try {
      await runWithContext(
        createSystemContext({
          organizationId,
          callerService: 'maintenance-service',
          correlationId: this.runId,
          userId: this.operatorId,
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
              if (!apply) throw new PreviewComplete({ ...report, outcome: 'PREVIEW' });
              if (!certificate) throw new UsageMeterRefusal('CUTOVER_PROOF_REQUIRED');
              const state = (mode: 'LEGACY' | 'LEDGER', value: typeof ledger | typeof meter) => ({
                mode,
                hours: difference(value.hour_meter, '0'),
                kilometres: difference(value.odometer, '0'),
                recordCount: value.record_count,
                lastPeriodEnd: value.last_period_end?.toISOString() ?? null,
                lastUsageRecordId: value.last_usage_record_id,
              });
              const before = state(meter.meter_source, meter);
              const after = state('LEDGER', ledger);
              // Under the shared lock: timestamp-only retries write no transition evidence.
              if (JSON.stringify(before) !== JSON.stringify(after)) {
                const payload = maintenanceMeterReconciledPayloadV1.safeParse({
                  assetId,
                  organizationId,
                  before,
                  after,
                  certificateDigest: certificate.digest,
                  snapshot: certificate.snapshot,
                  runId: this.runId,
                  operatorId: this.operatorId,
                });
                if (!payload.success) throw new UsageMeterRefusal('CUTOVER_AUDIT_INVALID');
                await new MaintenanceRepository(this.prisma).enqueueEvent(tx, {
                  aggregateType: 'AssetUsageMeter',
                  aggregateId: assetId,
                  eventName: MAINTENANCE_METER_RECONCILED,
                  eventVersion: MAINTENANCE_METER_RECONCILED_VERSION,
                  topic: MAINTENANCE_TOPIC,
                  organizationId,
                  payload: payload.data,
                });
              }
              // Staging precedes the shared lock. An unseen post-snapshot fact
              // either committed before verification (exact-set refusal), or
              // must take this lock after commit and observe LEDGER. No fact
              // insert/uniqueness wait is allowed below the meter lock.
              await tx.$executeRaw`
                UPDATE asset_usage_meter SET meter_source = 'LEDGER',
                  hour_meter = ${ledger.hour_meter}::numeric,
                  odometer = ${ledger.odometer}::numeric,
                  last_period_end = ${ledger.last_period_end},
                  last_usage_record_id = ${ledger.last_usage_record_id},
                  record_count = ${ledger.record_count}, updated_at = ${now}
                WHERE asset_id = ${assetId}`;
              callbackReturned = true;
            },
            { timeoutMs: 30_000 },
          ),
      );
    } catch (error) {
      if (!callbackReturned && error instanceof PreviewComplete) return error.report;
      const unconfirmed = apply && callbackReturned;
      return {
        ...report,
        L: null,
        diff: null,
        schedulesWouldAnnounce: [],
        snapshotVerified: false,
        outcome: unconfirmed ? 'UNCONFIRMED' : 'REFUSED',
        refusal: unconfirmed
          ? 'APPLY_UNCONFIRMED'
          : error instanceof UsageMeterRefusal
            ? error.code
            : error instanceof Error && error.message === 'SOURCE_LEDGER_MISMATCH'
              ? 'SOURCE_LEDGER_MISMATCH'
              : apply
                ? 'APPLY_PRECOMMIT_FAILED'
                : 'PREVIEW_FAILED',
      };
    }
    report.sourceComplete = true;
    report.outcome = 'APPLIED';
    report.refusal = null;
    try {
      await runWithContext(
        createSystemContext({
          organizationId,
          callerService: 'maintenance-service',
          correlationId: 'maintenance-meter-reconcile',
        }),
        async () => this.announcer.announceForAsset(assetId, now),
      );
    } catch {
      // The meter is confirmed durable even if the separate announcement fails.
      report.refusal = 'ANNOUNCEMENT_UNCONFIRMED';
    }
    return report;
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
  if (x === null || y === null) throw new UsageMeterRefusal('METER_OUT_OF_RANGE');
  return formatHundredths(x - y);
}
