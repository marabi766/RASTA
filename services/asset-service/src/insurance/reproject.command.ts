import { createHash } from 'node:crypto';
import { runUnscoped } from '@rasta/nest-common';
import { AssetRepository, isUniqueViolation } from '../asset/asset.repository';
import { INSURANCE_EVENTS, validateInsurancePayload } from '../asset/events';
import { INSURANCE_TOPIC } from '../config/env';
import { countsForCurrentOwner, type TransferInsurancePolicy } from './ownership';

/**
 * Re-emits `INSURANCE_RECORDED` for every policy that is still in force or has
 * not started yet, so a replica that never saw them can be filled in (docs/24
 * Q-101, runbook `insurance-reprojection.md`).
 *
 * ## Why it exists
 *
 * fleet-service decides dispatch from the policy windows it has consumed
 * (`asset_ref.insurance_cover`). Rows that predate that column — and any row
 * whose events were lost — hold no window at all, which a rule that REQUIRES a
 * coverage in force reads as "uninsured". The fact lives here, so this service
 * says it again; nothing is written to fleet's database from outside it.
 *
 * ## What makes it safe
 *
 *   - **Through the outbox.** Each event is an ordinary `enqueueEvent` row, so
 *     the relay publishes it with the same producer, headers, stream sequence
 *     and provenance as the original (ADR-051, ADR-061). Nothing here touches
 *     Kafka.
 *   - **Deterministic id.** {@link reprojectEventId}: a rerun produces the same
 *     id. This side skips a policy whose outbox row already exists (before a
 *     stream sequence is allocated, so a rerun leaves no gap); the consumer
 *     side is covered by its processed-event marker, which also holds after the
 *     outbox row has been pruned.
 *   - **Tenant-correct.** The event's organization is the asset's **current**
 *     owner, not the one that recorded the policy, which is what fleet's
 *     replica row is keyed by after a transfer. A policy that does not count
 *     for the current owner (Q-66) is not re-emitted.
 *   - **Bounded.** Keyset pages of `pageSize`; the page only names candidates,
 *     each decided in its own transaction under the asset's lock ({@link reprojectOne}).
 *   - **Generation-stamped.** The event carries the asset's ownership
 *     generation, read under that lock, and the id depends on it.
 */

/** The ULID alphabet (Crockford base32). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The event id of the re-emission of one policy as it stands now.
 *
 * SHA-256 of the policy id and its `updated_at` (the row's version: any edit
 * to the policy moves it), the first 128 bits written as a ULID. A ULID because
 * that is what every other event id is — the consumers key their idempotency
 * marker on the string and the outbox uses it as the primary key — and the
 * digest cannot collide with a random ULID in practice. Same policy, same
 * version, same id; an edited policy is a new fact and gets a new one. An
 * operator-chosen `reissue` label is part of the digest: fleet deduplicates by
 * id, so announcing again after it cleared its windows (runbook, "changing the
 * following-coverage list") needs ids it has not seen. Without a label the id is
 * the one earlier runs made.
 */
export function reprojectEventId(
  policyId: string,
  updatedAt: Date,
  ownershipGeneration: number,
  reissue?: string,
): string {
  // The asset's generation is part of the fact: the same policy announced after
  // a transfer carries another owner and generation, and a consumer that
  // deduplicates by id must see it as a new event, not as the earlier one.
  const digest = createHash('sha256')
    .update(
      `asset-service/insurance-reproject/v2|${policyId}|${updatedAt.toISOString()}|${ownershipGeneration}${
        reissue ? `|${reissue}` : ''
      }`,
    )
    .digest();
  let bits = BigInt(`0x${digest.subarray(0, 16).toString('hex')}`);
  let id = '';
  for (let i = 0; i < 26; i++) {
    id = ALPHABET.charAt(Number(bits & 31n)) + id;
    bits >>= 5n;
  }
  return id;
}

export interface ReprojectOptions {
  /** Count what would be emitted and write nothing. */
  readonly dryRun: boolean;
  /** Only this organization's assets. Omitted: every organization. */
  readonly organizationId?: string;
  /** Policies read and announced per transaction. */
  readonly pageSize: number;
  /** The transfer rule (Q-66), as the service runs it. */
  readonly transferRule: TransferInsurancePolicy;
  /** Makes this run's event ids new ones; see {@link reprojectEventId}. */
  readonly reissue?: string;
}

export interface ReprojectCounts {
  /** Events written (or, in a dry run, that would be). */
  emitted: number;
  /** Policies whose event of this version already exists. */
  alreadyEmitted: number;
}

export interface ReprojectReport extends ReprojectCounts {
  dryRun: boolean;
  /** In-force or upcoming policies read. */
  scanned: number;
  /** Not re-emitted: the policy does not count for the asset's current owner. */
  notCounting: number;
  byOrganization: Record<string, ReprojectCounts>;
}

export const MAX_PAGE_SIZE = 1000;

export interface PolicyRow {
  id: string;
  asset_id: string;
  owner_organization_id: string;
  insurer_name: string;
  coverage: string;
  valid_from: Date;
  valid_to: Date;
  updated_at: Date;
  policy_generation: number;
  asset_generation: number;
}

type PolicyOutcome = 'NOT_ELIGIBLE' | { result: 'EMITTED' | 'ALREADY'; organizationId: string };

/**
 * Announces one policy, or skips it, inside one transaction.
 *
 * Order matches a transfer's: the asset's row lock first (shared, so policy
 * recordings run beside it; a transfer's compare-and-set queues behind it, or
 * has committed before it and is seen below), then the policy, owner and
 * generation are read again, and the event is written from those values only.
 * A policy no longer ACTIVE, deleted, ended, or not counting for the current
 * owner is skipped.
 *
 * Two runs at once may both find no outbox row. The loser's insert hits the
 * primary key; that is the event already emitted, counted as such, and its
 * transaction (stream sequence included) rolls back without touching the rest
 * of the run.
 */
export async function reprojectOne(
  repository: AssetRepository,
  candidate: PolicyRow,
  options: ReprojectOptions,
  now: Date,
): Promise<PolicyOutcome> {
  // The owner this run read inside its transaction, kept for the conflict path:
  // the transaction is gone by then, and the candidate's owner is from the page.
  let owner: string | undefined;
  try {
    return await repository.transaction(async (tx): Promise<PolicyOutcome> => {
      await tx.$queryRaw`SELECT id FROM asset WHERE id = ${candidate.asset_id} FOR SHARE`;
      const [row] = await tx.$queryRaw<PolicyRow[]>`
        SELECT p.id, p.asset_id, a.organization_id AS owner_organization_id,
               p.insurer_name, p.coverage::text AS coverage, p.valid_from, p.valid_to,
               p.updated_at, p.ownership_generation AS policy_generation,
               a.ownership_generation AS asset_generation
          FROM insurance_policy p
          JOIN asset a ON a.id = p.asset_id
         WHERE p.id = ${candidate.id}
           AND p.status = 'ACTIVE' AND p.deleted_at IS NULL AND a.deleted_at IS NULL
           AND p.valid_to > ${now}
           AND (${options.organizationId ?? null}::text IS NULL
                OR a.organization_id = ${options.organizationId ?? null})`;
      if (!row) return 'NOT_ELIGIBLE';
      const policy = { coverage: row.coverage, ownershipGeneration: row.policy_generation };
      if (!countsForCurrentOwner(policy, row.asset_generation, options.transferRule)) {
        return 'NOT_ELIGIBLE';
      }

      const organizationId = row.owner_organization_id;
      owner = organizationId;
      const eventId = reprojectEventId(
        row.id,
        row.updated_at,
        row.asset_generation,
        options.reissue,
      );
      const exists = await tx.outboxMessage.findUnique({
        where: { id: eventId },
        select: { id: true },
      });
      if (exists) return { result: 'ALREADY', organizationId };

      if (!options.dryRun) {
        await repository.enqueueEvent(tx, {
          eventId,
          aggregateType: 'InsurancePolicy',
          aggregateId: row.id,
          eventName: INSURANCE_EVENTS.INSURANCE_RECORDED,
          topic: INSURANCE_TOPIC,
          organizationId,
          payload: validateInsurancePayload(INSURANCE_EVENTS.INSURANCE_RECORDED, {
            assetId: row.asset_id,
            organizationId,
            policyId: row.id,
            insurerName: row.insurer_name,
            coverage: row.coverage,
            validFrom: row.valid_from.toISOString(),
            validTo: row.valid_to.toISOString(),
            ownershipGeneration: row.asset_generation,
          }),
        });
      }
      return { result: 'EMITTED', organizationId };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The concurrent run's row won. Attributed to the owner re-read under the
    // lock, which is the one that row names, not the page's.
    return { result: 'ALREADY', organizationId: owner ?? candidate.owner_organization_id };
  }
}

export async function reprojectInsurance(
  repository: AssetRepository,
  options: ReprojectOptions,
  now: Date = new Date(),
): Promise<ReprojectReport> {
  if (
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  const report: ReprojectReport = {
    dryRun: options.dryRun,
    scanned: 0,
    emitted: 0,
    alreadyEmitted: 0,
    notCounting: 0,
    byOrganization: {},
  };
  const only = options.organizationId ?? null;

  let cursor = '';
  for (;;) {
    const page = await runUnscoped(
      'operator re-projection reads every organization’s policies; each event names the asset’s current owner',
      () =>
        repository.client.$queryRaw<PolicyRow[]>`
          SELECT p.id, p.asset_id, a.organization_id AS owner_organization_id,
                 p.insurer_name, p.coverage::text AS coverage, p.valid_from, p.valid_to,
                 p.updated_at, p.ownership_generation AS policy_generation,
                 a.ownership_generation AS asset_generation
            FROM insurance_policy p
            JOIN asset a ON a.id = p.asset_id
           WHERE p.status = 'ACTIVE' AND p.deleted_at IS NULL AND a.deleted_at IS NULL
             AND p.valid_to > ${now}
             AND p.id > ${cursor}
             AND (${only}::text IS NULL OR a.organization_id = ${only})
           ORDER BY p.id
           LIMIT ${options.pageSize}`,
    );
    if (page.length === 0) break;

    // The page only names candidates. Each policy is decided in its own
    // transaction, under its asset's lock, from values read after the lock: a
    // transfer or a cancellation committed since the page was read must not
    // be announced under the owner and generation the page saw.
    for (const candidate of page) {
      report.scanned += 1;
      const outcome = await reprojectOne(repository, candidate, options, now);
      if (outcome === 'NOT_ELIGIBLE') {
        report.notCounting += 1;
        continue;
      }
      const counts = (report.byOrganization[outcome.organizationId] ??= {
        emitted: 0,
        alreadyEmitted: 0,
      });
      if (outcome.result === 'EMITTED') {
        report.emitted += 1;
        counts.emitted += 1;
      } else {
        report.alreadyEmitted += 1;
        counts.alreadyEmitted += 1;
      }
    }

    // The last row in the database's own order, which is the order `p.id > …`
    // compares in; never a JavaScript string comparison.
    cursor = page.at(-1)?.id ?? cursor;
    if (page.length < options.pageSize) break;
  }
  return report;
}
