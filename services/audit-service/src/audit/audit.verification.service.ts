import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import {
  AuditRepository,
  type AuditChainHeadRow,
  type AuditChainRow,
  type AuditChainSegment,
} from './audit.repository';
import { resolveCallerAuthority, type AuditCallerAuthority } from '../access/access';
import { resolveSubtreeTarget } from './audit.scope';
import {
  computeRecordHash,
  hashesEqual,
  monthLabel,
  monthsBetween,
  type AuditChainKey,
} from './audit.chain';
import { CANONICAL_VERSION } from './audit.canonical';
import type { AuditVerifyQuery } from './audit.query.dto';
import {
  auditChainVerificationSchema,
  DIVERGENCE_REASONS,
  type AuditChainMonthResult,
  type AuditChainVerification,
  type DivergenceReason,
  type VerificationStatus,
} from './audit.verification.view';
import {
  auditChainRecordsVerified,
  auditChainVerificationFailuresTotal,
  auditChainVerificationSeconds,
  auditChainVerificationsTotal,
  VERIFICATION_OUTCOMES,
  VERIFICATION_SCOPE_LABELS,
} from '../observability/metrics';
import { ENV, LOGGER } from '../tokens';
import type { AuditEnv } from '../config/env';

/**
 * Recomputes a range of one chain and reports the first place it stops
 * agreeing (ADR-053 § 6).
 *
 * ## Without this, the chain is decoration
 *
 * A hash written and never checked proves nothing — it is a column that looks
 * like evidence. This is the endpoint the ADR names for that reason, and
 * everything about its shape follows from one requirement: the answer has to be
 * something an operator can act on, produced without becoming a way to read the
 * store or to take it down.
 *
 * ## One chain, resolved from the token, always
 *
 * A verification targets exactly one `(organization, month-range)` chain family
 * or the platform one, and never "whatever the caller named". The organization
 * a `UNION_ADMIN` may verify is their own or a descendant the local projection
 * proves — the same decision, in the same code, as the search endpoint
 * (`audit.scope.ts`). A `SYSTEM_ADMIN` must name the tenant, or ask for
 * `scope=PLATFORM` explicitly; there is no "verify everything", because there
 * is no single chain to verify and pretending otherwise would return a valid
 * verdict over a union of chains none of which was checked end to end.
 *
 * ## Streamed, bounded, and in chain order
 *
 * The walk pages through `sequence_no` ascending rather than loading a month,
 * and it walks the **contiguous** chain segment the window touches rather than
 * only the records whose `occurredAt` falls inside it. Those are different sets
 * — ADR-053 § 8 tolerates out-of-order arrival, so chain order and `occurredAt`
 * order genuinely differ — and verifying a non-contiguous subsequence would be
 * verifying links that do not exist.
 *
 * ## Nothing identifying is logged
 *
 * Not the organization, not an actor, not a resource, not a correlation id, not
 * a payload, and not a hash. Shape, counts, timing and outcome only. A log
 * aggregator has none of the audit store's access controls, and "whose evidence
 * looks altered" written into one is a disclosure the store's own authorization
 * was built to prevent (`AGENTS.md` S-09, ADR-053 § 13).
 */

/** How many records one page of the chain walk reads. */
export const CHAIN_PAGE_SIZE = 500;

/** Where a chain stopped agreeing, before it is shaped into a response. */
interface Divergence {
  readonly month: string;
  readonly auditEventId: string;
  readonly occurredAt: Date;
  readonly sequenceNo: bigint;
  readonly reason: DivergenceReason;
}

interface MonthOutcome {
  readonly result: AuditChainMonthResult;
  readonly divergence: Divergence | null;
  readonly walked: number;
}

@Injectable()
export class AuditVerificationService {
  constructor(
    private readonly repository: AuditRepository,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ENV) private readonly env: AuditEnv,
  ) {}

  async verify(query: AuditVerifyQuery): Promise<AuditChainVerification> {
    const startedAt = Date.now();
    const authority = resolveCallerAuthority();
    const organizationId = await this.resolveTarget(authority, query);

    const scopeLabel =
      query.scope === 'PLATFORM'
        ? VERIFICATION_SCOPE_LABELS.PLATFORM
        : VERIFICATION_SCOPE_LABELS.ORGANIZATION;

    const months = monthsBetween(query.from, query.to);

    // The segments are collected first, from aggregates, so an over-large
    // window is refused before a single record is walked. ADR-053 § 10 makes
    // the same argument for the query window: a control that runs after the
    // work has already paid for the denial of service it exists to prevent.
    //
    // ## What is preflighted is the walk, not the window
    //
    // The ceiling is checked against `walkLength` — the contiguous chain
    // interval the walk will actually read — and never against
    // `recordsInRange`, which is only how many records the caller asked about.
    // A sparse window over out-of-order arrivals makes the two differ by orders
    // of magnitude: two records an hour apart in `occurredAt` can sit at
    // opposite ends of a month's chain, so a preflight on `recordsInRange`
    // would wave through exactly the request that costs the most and then
    // refuse it mid-walk, after the work was already done. `recordsInRange` is
    // still carried, separately and truthfully, into the response.
    const segments: { key: AuditChainKey; segment: AuditChainSegment | null }[] = [];
    let plannedWalk = 0;
    for (const chainMonth of months) {
      const key: AuditChainKey =
        query.scope === 'PLATFORM'
          ? { scope: 'PLATFORM', organizationKey: '', chainMonth }
          : { scope: 'ORGANIZATION', organizationKey: organizationId as string, chainMonth };
      const segment = await this.repository.chainSegment(key, query.from, query.to);
      plannedWalk += segment?.walkLength ?? 0;
      segments.push({ key, segment });
    }

    const ceiling = this.env.AUDIT_MAX_VERIFICATION_RECORDS;
    if (plannedWalk > ceiling) {
      throw RastaError.validation([
        {
          path: 'to',
          message:
            `Verifying this window would walk ${plannedWalk} chain records and the ceiling ` +
            `is ${ceiling} (AUDIT_MAX_VERIFICATION_RECORDS); verify a narrower range`,
        },
      ]);
    }

    const monthResults: AuditChainMonthResult[] = [];
    let firstDivergence: Divergence | null = null;
    let recordsInRange = 0;
    let recordsVerified = 0;
    let unchainedRecords = 0;
    let walked = 0;

    for (const { key, segment } of segments) {
      if (firstDivergence !== null) break;

      const outcome = await this.verifyMonth(key, segment, ceiling - walked);
      walked += outcome.walked;

      monthResults.push(outcome.result);
      recordsInRange += outcome.result.recordsInRange;
      recordsVerified += outcome.result.recordsVerified;
      unchainedRecords += outcome.result.unchainedRecords;

      // Months are walked in ascending order, so the first divergence found is
      // the earliest one. Stopping here is deliberate: a divergence is an
      // incident, and the runbook's first instruction is to freeze rather than
      // to keep reading (`docs/runbooks/audit-chain-divergence.md`).
      if (outcome.divergence !== null) firstDivergence = outcome.divergence;
    }

    const status = overallStatus({
      divergent: firstDivergence !== null,
      recordsInRange,
      unchainedRecords,
    });

    this.record(scopeLabel, status, firstDivergence, {
      months: monthResults.length,
      recordsInRange,
      recordsVerified,
      unchainedRecords,
      elapsedMs: Date.now() - startedAt,
    });

    // Parsed, not cast. `auditChainVerificationSchema` carries the cross-field
    // rules this response has to satisfy — `valid` true for exactly `VALID`, a
    // `firstDivergence` for exactly `DIVERGENT`, totals that equal the sum of
    // their months, no negative count — and parsing here is what makes them
    // properties of the endpoint rather than properties of this function
    // staying correct. A response that contradicts itself never leaves the
    // service; it raises, and the caller gets an error instead of a verdict
    // they would have acted on.
    return auditChainVerificationSchema.parse({
      scope: query.scope,
      organizationId: query.scope === 'PLATFORM' ? null : (organizationId as string),
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      status,
      valid: status === 'VALID',
      canonicalVersion: CANONICAL_VERSION,
      recordsInRange,
      recordsVerified,
      unchainedRecords,
      months: monthResults,
      firstDivergence:
        firstDivergence === null
          ? null
          : {
              month: firstDivergence.month,
              auditEventId: firstDivergence.auditEventId,
              occurredAt: firstDivergence.occurredAt.toISOString(),
              sequenceNo: firstDivergence.sequenceNo.toString(),
              reason: firstDivergence.reason,
            },
    });
  }

  /**
   * Which chain this request is allowed to ask about.
   *
   * `scope=PLATFORM` is platform authority and nothing else. The platform chain
   * holds the rows with no tenant, which ADR-053 § 10 reserves to
   * `SYSTEM_ADMIN`; a subtree caller asking for it is refused here as well as
   * by the fact that no tenant query in this service ever matches a null-tenant
   * row.
   *
   * `scope=ORGANIZATION` from a platform caller must name the tenant. There is
   * no chain that spans tenants, so "verify everything" has no answer — and
   * returning a valid verdict over a union of chains, none of which was walked
   * end to end, would be the most dangerous wrong answer this endpoint could
   * give.
   */
  private async resolveTarget(
    authority: AuditCallerAuthority,
    query: AuditVerifyQuery,
  ): Promise<string | null> {
    if (query.scope === 'PLATFORM') {
      if (authority.kind !== 'PLATFORM') {
        throw RastaError.forbidden(
          'Platform-scoped audit records are not within the subtree this request is authorised for',
        );
      }
      return null;
    }

    if (authority.kind === 'PLATFORM') {
      if (query.organizationId === undefined) {
        throw RastaError.validation([
          {
            path: 'organizationId',
            message:
              'Verification targets exactly one chain: name an `organizationId`, ' +
              'or ask for `scope=PLATFORM`',
          },
        ]);
      }
      return query.organizationId;
    }

    return await resolveSubtreeTarget(this.repository, authority, query.organizationId);
  }

  /**
   * Recomputes one month's chain segment.
   *
   * ## A null link is two opposite facts, and the head says which
   *
   * `record_hash IS NULL` on a row written before AUD-003 means the chain did
   * not exist yet. The same null on a row written after it means the link was
   * removed. Treating both as harmless legacy — which is what a verifier
   * without a recorded boundary is forced to do — would hand a privileged
   * attacker a way to strip a record's link and have this endpoint report the
   * result as history.
   *
   * So the boundary is read, not inferred. `audit_chain_head.first_sequence_no`
   * is written once, on the chain's first linked record, and is immutable
   * afterwards by database trigger. Below it, an unlinked row is
   * `UNVERIFIABLE_LEGACY`: counted, reported, and never `VALID`. At or above
   * it, an unlinked row is `MISSING_CHAIN_LINK` — a divergence. A chain with no
   * head at all has no segment, so every unlinked row in it is legacy, which is
   * exactly right for a month nothing has been written to since the migration.
   *
   * ## Seeding, and why an unseeded segment says less
   *
   * If a record exists before the window's first record in this chain, its
   * stored hash is what the window's first `previousHash` must equal. That
   * check is what makes a mid-range verification mean anything: without it, a
   * forger who rewrote a contiguous run of records — links and all — would
   * produce a run that agrees with itself. `seededFromPredecessor` is published
   * so a reader can tell which of the two statements they were given.
   */
  private async verifyMonth(
    key: AuditChainKey,
    segment: AuditChainSegment | null,
    remainingBudget: number,
  ): Promise<MonthOutcome> {
    const month = monthLabel(key.chainMonth);

    if (segment === null) {
      return {
        result: {
          month,
          status: 'EMPTY',
          recordsInRange: 0,
          recordsVerified: 0,
          unchainedRecords: 0,
          seededFromPredecessor: false,
        },
        divergence: null,
        walked: 0,
      };
    }

    // Read before the walk, not after it. The walk needs the segment start to
    // tell legacy from damage on the very first unlinked row it meets, and
    // re-reading the head at the end would be reading it twice.
    const head = await this.repository.chainHead(key);
    const segmentStart = head?.firstSequenceNo ?? null;

    const predecessor = await this.repository.chainPredecessor(key, segment.firstSequenceNo);
    // A predecessor with no hash is a pre-AUD-003 row: it cannot seed anything,
    // and the first linked record after it legitimately opens a fresh segment.
    let expected: Uint8Array | null = predecessor?.recordHash ?? null;
    const seededFromPredecessor = expected !== null;

    let divergence: Divergence | null = null;
    let recordsVerified = 0;
    let unchainedRecords = 0;
    let walked = 0;
    let after: bigint | null = null;
    let lastRow: AuditChainRow | null = null;
    let lastHash: Uint8Array | null = null;

    while (divergence === null) {
      const page = await this.repository.chainPage(key, segment, after, CHAIN_PAGE_SIZE);
      if (page.length === 0) break;

      for (const row of page) {
        after = row.sequenceNo;
        walked += 1;

        if (walked > remainingBudget) {
          throw RastaError.validation([
            {
              path: 'to',
              message:
                `This window walks more than ${this.env.AUDIT_MAX_VERIFICATION_RECORDS} ` +
                `chain records (AUDIT_MAX_VERIFICATION_RECORDS); verify a narrower range`,
            },
          ]);
        }

        if (row.recordHash === null) {
          if (segmentStart !== null && row.sequenceNo >= segmentStart) {
            // At or after the recorded segment start, so this row was written
            // into a chain that already existed and its link has been removed.
            divergence = divergenceAt(month, row, DIVERGENCE_REASONS.MISSING_CHAIN_LINK);
            break;
          }

          // Below the segment start — written before this chain was chained.
          // Counted, never verified, and the expected predecessor resets
          // because the next linked row legitimately opens a fresh segment with
          // `previousHash = NULL`.
          unchainedRecords += 1;
          expected = null;
          continue;
        }

        if (!hashesEqual(row.previousHash, expected)) {
          divergence = divergenceAt(month, row, DIVERGENCE_REASONS.PREVIOUS_HASH_MISMATCH);
          break;
        }

        // Recomputed from the chain this walk has verified, not from the link
        // stored beside the row. The two are equal by the check above, and
        // using the verified one keeps the chain the authority.
        if (!hashesEqual(computeRecordHash(row, expected), row.recordHash)) {
          divergence = divergenceAt(month, row, DIVERGENCE_REASONS.RECORD_HASH_MISMATCH);
          break;
        }

        recordsVerified += 1;
        expected = row.recordHash;
        lastRow = row;
        lastHash = row.recordHash;
      }

      if (page.length < CHAIN_PAGE_SIZE) break;
      if (after !== null && after >= segment.lastSequenceNo) break;
    }

    if (divergence === null && lastRow !== null) {
      divergence = await this.checkTail(key, month, {
        head,
        segment,
        segmentStart,
        lastRow,
        lastHash,
        recordsVerified,
      });
    }

    const status: VerificationStatus =
      divergence !== null ? 'DIVERGENT' : unchainedRecords > 0 ? 'UNVERIFIABLE_LEGACY' : 'VALID';

    return {
      result: {
        month,
        status,
        recordsInRange: segment.recordsInRange,
        recordsVerified,
        unchainedRecords,
        seededFromPredecessor,
      },
      divergence,
      walked,
    };
  }

  /**
   * Whether the records past the verified window are still consistent with the
   * head that claims to describe them.
   *
   * ## “The head is ahead of you” is a claim, not an explanation
   *
   * The head is the only object in this service the runtime role may `UPDATE`,
   * which makes it the cheapest thing to attack: rewind it and the next
   * legitimate write re-links onto an older tip, forking the chain without
   * touching a committed audit row. But the subtler failure is the opposite
   * one. If the verifier accepts any head whose position is *beyond* the
   * window, then deleting the final record of a month and leaving the head
   * alone produces a head that is ahead of every record — and a full-month
   * verification would report `VALID` over a chain whose tail is gone.
   *
   * So a head past the window has to be paid for with evidence, and each of the
   * checks below is one bounded query:
   *
   *   the head is missing or empty   records are linked and nothing describes
   *                                  them
   *   the head is behind             linked records exist past the tip it names
   *   the head names nothing real    or names a record whose id or hash
   *                                  disagrees with it
   *   the head is ahead              then the immediate successor of the
   *                                  window's last record must exist and must
   *                                  link to it — `CHAIN_TAIL_MISSING` when it
   *                                  does not
   *
   * And when the walk happened to cover a whole segment, `chain_length` is
   * compared against what was verified, which catches a record removed anywhere
   * inside it.
   *
   * A head that is genuinely ahead of a mid-range window, with a real successor
   * that links correctly, is normal and is not a divergence. That is the case
   * this method must not break while closing the one above.
   */
  private async checkTail(
    key: AuditChainKey,
    month: string,
    state: {
      head: AuditChainHeadRow | null;
      segment: AuditChainSegment;
      segmentStart: bigint | null;
      lastRow: AuditChainRow;
      lastHash: Uint8Array | null;
      recordsVerified: number;
    },
  ): Promise<Divergence | null> {
    const { head, segment, segmentStart, lastRow, lastHash, recordsVerified } = state;
    const at = (reason: DivergenceReason): Divergence => divergenceAt(month, lastRow, reason);

    // Records carry links but no head describes them. Reached only when the
    // walk verified something, so a legacy-only month never lands here.
    if (head === null || head.headSequenceNo === null || head.chainLength <= 0n) {
      return at(DIVERGENCE_REASONS.CHAIN_HEAD_MISMATCH);
    }

    // Linked records exist past the tip the head names: either the head was
    // rewound, or a record was written around it.
    if (head.headSequenceNo < lastRow.sequenceNo) {
      return at(DIVERGENCE_REASONS.CHAIN_HEAD_MISMATCH);
    }

    if (head.headSequenceNo === lastRow.sequenceNo) {
      if (!hashesEqual(head.headHash, lastHash) || head.headEventId !== lastRow.id) {
        return at(DIVERGENCE_REASONS.CHAIN_HEAD_MISMATCH);
      }
    } else {
      // The head claims the chain continues. Two bounded reads make it prove
      // it: the record the head names must exist and agree with the head, and
      // the record immediately after the window must exist and link to the
      // window's last record.
      const headRecord = await this.repository.chainRecordAt(key, head.headSequenceNo);
      if (
        headRecord === null ||
        headRecord.id !== head.headEventId ||
        !hashesEqual(headRecord.recordHash, head.headHash)
      ) {
        return at(DIVERGENCE_REASONS.CHAIN_HEAD_MISMATCH);
      }

      const successor = await this.repository.chainSuccessor(key, lastRow.sequenceNo);
      if (successor === null || !hashesEqual(successor.previousHash, lastHash)) {
        return at(DIVERGENCE_REASONS.CHAIN_TAIL_MISSING);
      }
    }

    // The walk covered the segment from its recorded start to the head's tip,
    // so the head's own count of linked records is a number this walk can be
    // held to. A record removed anywhere inside the segment shows up here even
    // if its neighbours' links were rewritten to close the gap.
    const coversWholeSegment =
      segmentStart !== null &&
      segment.firstSequenceNo <= segmentStart &&
      segment.lastSequenceNo === head.headSequenceNo;

    if (coversWholeSegment && head.chainLength !== BigInt(recordsVerified)) {
      return at(DIVERGENCE_REASONS.CHAIN_LENGTH_MISMATCH);
    }

    return null;
  }

  /**
   * The one place a verification is written down.
   *
   * The failure counter moves for a real divergence and for nothing else. An
   * empty window, a legacy window and a refusal are all normal answers, and a
   * counter that moved for them would make the one alert that must never be
   * ignored the one that always fires.
   */
  private record(
    scope: string,
    status: VerificationStatus,
    divergence: Divergence | null,
    detail: {
      months: number;
      recordsInRange: number;
      recordsVerified: number;
      unchainedRecords: number;
      elapsedMs: number;
    },
  ): void {
    const outcome = OUTCOME_LABELS[status];
    auditChainVerificationsTotal.inc({ scope, outcome });
    auditChainVerificationSeconds.observe({ scope }, detail.elapsedMs / 1000);
    auditChainRecordsVerified.observe({ scope }, detail.recordsVerified);

    if (divergence !== null) {
      auditChainVerificationFailuresTotal.inc({ reason: divergence.reason, scope });
    }

    // Scope shape, counts, timing, outcome. No organization, no record id, no
    // hash — a divergence's location belongs in the response, behind the
    // authorization the response already carries.
    this.logger.info(
      `audit chain verification scope=${scope} outcome=${outcome} ` +
        `months=${detail.months} inRange=${detail.recordsInRange} ` +
        `verified=${detail.recordsVerified} unchained=${detail.unchainedRecords} ` +
        `elapsedMs=${detail.elapsedMs}`,
    );
  }
}

const OUTCOME_LABELS: Record<VerificationStatus, string> = {
  VALID: VERIFICATION_OUTCOMES.VALID,
  DIVERGENT: VERIFICATION_OUTCOMES.DIVERGENT,
  EMPTY: VERIFICATION_OUTCOMES.EMPTY,
  UNVERIFIABLE_LEGACY: VERIFICATION_OUTCOMES.UNVERIFIABLE_LEGACY,
};

function divergenceAt(month: string, row: AuditChainRow, reason: DivergenceReason): Divergence {
  return {
    month,
    auditEventId: row.id,
    occurredAt: row.occurredAt,
    sequenceNo: row.sequenceNo,
    reason,
  };
}

/**
 * The window's verdict from its months'.
 *
 * Divergence wins over everything, then "nothing to check", then "some of it
 * could not be checked". `VALID` is what is left, and it is deliberately the
 * hardest of the four to reach.
 */
function overallStatus(counts: {
  divergent: boolean;
  recordsInRange: number;
  unchainedRecords: number;
}): VerificationStatus {
  if (counts.divergent) return 'DIVERGENT';
  if (counts.recordsInRange === 0) return 'EMPTY';
  if (counts.unchainedRecords > 0) return 'UNVERIFIABLE_LEGACY';
  return 'VALID';
}
