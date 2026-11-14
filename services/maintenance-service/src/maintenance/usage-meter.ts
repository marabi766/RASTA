import { runUnscoped } from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

export interface UsageMeterInput {
  assetId: string;
  organizationId: string;
  usageRecordId: string;
  hoursDelta: string;
  kilometresDelta: string;
  reportedHourMeter: string | null;
  reportedOdometer: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  now: Date;
}
export interface LockedUsageMeter {
  meter_source: 'LEGACY' | 'LEDGER';
  last_period_end: Date | null;
  last_usage_record_id: string | null;
  record_count: number;
  hour_meter: string;
  odometer: string;
}
export interface CalculatedUsageMeter {
  hour_meter: string;
  odometer: string;
  over_max: boolean;
  incomplete: boolean;
  last_period_end: Date | null;
  last_usage_record_id: string | null;
  record_count: number;
}

/** Forces rollback of the tentative ledger insert on a processed event. */
export class UsageAlreadyProcessed extends Error {}

/** Closed codes only: the consumer maps these to DLQ without repeating payload quantities. */
export class UsageMeterRefusal extends Error {
  constructor(
    readonly code:
      | 'INCOMPLETE_INTERVAL'
      | 'METER_OUT_OF_RANGE'
      | 'UNKNOWN_METER_SOURCE'
      | 'ENTRY_CONFLICT'
      | 'CUTOVER_PROOF_REQUIRED'
      | 'CUTOVER_AUDIT_INVALID'
      | 'SOURCE_CERTIFICATE_INVALID'
      | 'SOURCE_PAGE_MALFORMED',
  ) {
    super(code);
  }
}

/** Shared by the live consumer and the PR 7b reconciler. Never updates an existing fact. */
export async function insertUsageEntry(
  tx: ExtendedPrismaClient,
  input: UsageMeterInput,
): Promise<void> {
  const inserted = await tx.$executeRaw`
    INSERT INTO asset_usage_entry (
      usage_record_id, asset_id, organization_id, period_start, period_end,
      hours, kilometres, hour_meter, odometer
    ) VALUES (
      ${input.usageRecordId}, ${input.assetId}, ${input.organizationId}, ${input.periodStart}, ${input.periodEnd},
      ${input.hoursDelta}::numeric, ${input.kilometresDelta}::numeric,
      ${input.reportedHourMeter}::numeric, ${input.reportedOdometer}::numeric
    ) ON CONFLICT (usage_record_id) DO NOTHING
  `;
  if (inserted === 0) {
    // ON CONFLICT protects a fact, not the validity of an event that reuses its id.
    // Compare by exact value, without returning any other tenant's fact.
    const [existing] = await tx.$queryRaw<{ matches: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM asset_usage_entry
        WHERE usage_record_id = ${input.usageRecordId} AND asset_id = ${input.assetId}
          AND organization_id = ${input.organizationId}
          AND period_start IS NOT DISTINCT FROM ${input.periodStart}::timestamp
          AND period_end IS NOT DISTINCT FROM ${input.periodEnd}::timestamp
          AND hours = ${input.hoursDelta}::numeric AND kilometres = ${input.kilometresDelta}::numeric
          AND hour_meter IS NOT DISTINCT FROM ${input.reportedHourMeter}::numeric
          AND odometer IS NOT DISTINCT FROM ${input.reportedOdometer}::numeric
      ) AS matches
    `;
    if (!existing.matches) throw new UsageMeterRefusal('ENTRY_CONFLICT');
  }
}

/**
 * Shared lock statement for consumer AND reconciler. State is read only by the
 * SELECT that holds FOR UPDATE; a cutover that wins the lock is observed here.
 */
export async function lockUsageMeter(
  tx: ExtendedPrismaClient,
  input: Pick<UsageMeterInput, 'assetId' | 'organizationId' | 'now'>,
): Promise<LockedUsageMeter> {
  return runUnscoped(
    'physical usage meter spans asset owners; not used for authorization',
    async () => {
      // PostgreSQL's BEFORE INSERT trigger owns the mode decision and gate lock,
      // including ON CONFLICT and writers running an older application image.
      await tx.$executeRaw`
      INSERT INTO asset_usage_meter(asset_id, organization_id, updated_at)
      VALUES (${input.assetId}, ${input.organizationId}, ${input.now})
      ON CONFLICT (asset_id) DO NOTHING
    `;
      const [meter] = await tx.$queryRaw<LockedUsageMeter[]>`
      SELECT meter_source, hour_meter::text, odometer::text,
        last_period_end, last_usage_record_id, record_count
      FROM asset_usage_meter WHERE asset_id = ${input.assetId} FOR UPDATE
    `;
      if (!meter) throw new Error('usage meter lock returned no row');
      return meter;
    },
  );
}

/**
 * ADR-073 § 4 D closed form: max(sum(d), max(r_k + sum(d_i after k))).
 * The cumulative RANGE includes peers: total minus covered is strictly later,
 * even at equal period_end instants. No frame exclusion or per-row subquery.
 * SQL numeric sums are unbounded; check BEFORE a NUMERIC(20,2) write.
 * Caller MUST hold lockUsageMeter until the result is written/committed.
 */
export async function calculateLedgerMeter(
  tx: ExtendedPrismaClient,
  assetId: string,
): Promise<CalculatedUsageMeter> {
  return runUnscoped(
    'physical meter recomputes quantity facts across asset owners under its row lock',
    async () => {
      const [meter] = await tx.$queryRaw<CalculatedUsageMeter[]>`
      WITH ordered AS (
        SELECT *,
          sum(hours) OVER covered AS covered_hours,
          sum(kilometres) OVER covered AS covered_kilometres
        FROM asset_usage_entry WHERE asset_id = ${assetId}
        WINDOW covered AS (ORDER BY period_end RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      ), totals AS (
        SELECT COALESCE(sum(hours), 0) + GREATEST(COALESCE(max(hour_meter - covered_hours), 0), 0) AS h,
          COALESCE(sum(kilometres), 0) + GREATEST(COALESCE(max(odometer - covered_kilometres), 0), 0) AS k,
          COALESCE(bool_or(period_start IS NULL OR period_end IS NULL), false) AS incomplete,
          max(period_end) AS last_period_end, count(*)::int AS record_count
        FROM ordered
      )
      SELECT h::text AS hour_meter, k::text AS odometer,
        (h > 999999999999999999.99 OR k > 999999999999999999.99) AS over_max,
        incomplete, last_period_end, record_count,
        (SELECT usage_record_id FROM asset_usage_entry WHERE asset_id = ${assetId}
          ORDER BY period_end DESC, usage_record_id DESC LIMIT 1) AS last_usage_record_id
      FROM totals
    `;
      if (meter.incomplete) throw new UsageMeterRefusal('INCOMPLETE_INTERVAL');
      if (meter.over_max) throw new UsageMeterRefusal('METER_OUT_OF_RANGE');
      return meter;
    },
  );
}

/** LEGACY keeps today's chronological fold semantics until verified cutover. */
export async function calculateLegacyMeter(
  tx: ExtendedPrismaClient,
  meter: LockedUsageMeter,
  input: UsageMeterInput,
): Promise<CalculatedUsageMeter> {
  const [result] = await tx.$queryRaw<CalculatedUsageMeter[]>`
    WITH totals AS (
      SELECT GREATEST(${meter.hour_meter}::numeric + ${input.hoursDelta}::numeric,
        COALESCE(${input.reportedHourMeter}::numeric, 0)) AS h,
        GREATEST(${meter.odometer}::numeric + ${input.kilometresDelta}::numeric,
        COALESCE(${input.reportedOdometer}::numeric, 0)) AS k
    ) SELECT h::text AS hour_meter, k::text AS odometer,
      (h > 999999999999999999.99 OR k > 999999999999999999.99) AS over_max
    FROM totals
  `;
  if (result.over_max) throw new UsageMeterRefusal('METER_OUT_OF_RANGE');
  return {
    ...result,
    incomplete: false,
    last_period_end: input.periodEnd,
    last_usage_record_id: input.usageRecordId,
    record_count: 1,
  };
}
