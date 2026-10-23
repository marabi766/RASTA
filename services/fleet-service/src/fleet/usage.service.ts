import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ERROR_CODES, ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, type RequestContext } from '@rasta/nest-common';
import { usageDuplicatesTotal, usageRecordsTotal } from '../observability/metrics';
import { FleetRepository, isUniqueViolation } from './fleet.repository';
import { FLEET_EVENTS, validateFleetPayload } from './events';
import { FLEET_TOPIC, SERVICE_NAME } from '../config/env';
import { currentFleetScope, type FleetScope } from './access';
import { hashRequest } from './idempotency';
import { Prisma } from '../generated/prisma';
import {
  canonicalInstant,
  canonicalLineEndings,
  canonicalQuantity,
  type ListUsageQuery,
  type RecordUsageDto,
  type UsageRecordView,
} from './dto';

/**
 * Usage recording — the busiest write path in the fleet domain.
 *
 * `USAGE_RECORDED` is the event that drives usage-based maintenance schedules
 * (docs/04 § 4.6): "service every 250 hours" is evaluated by
 * maintenance-service consuming this stream. That makes accuracy here a safety
 * property rather than a reporting nicety, and it is why quantities are
 * NUMERIC end to end and never pass through a float.
 *
 * The other shaping force is the field. The product asks for offline capture
 * that syncs later (docs/17), so the same reading *will* be submitted twice.
 * A resubmission carrying the same `clientReference` returns the record that
 * already exists rather than adding a second one — and, importantly, does not
 * publish a second event, because maintenance-service would count those hours
 * twice.
 *
 * A reference replays only **its own request**: the same caller sending the
 * same body, who may still read the record by the rule {@link UsageService.get}
 * applies. Anything else under a reference already taken — another body,
 * another user or service of the organization, a caller who may not read the
 * record — is one `409 IDEMPOTENCY_KEY_REUSED` with nothing of the stored
 * record: the rule `IdempotencyStore` (./idempotency.ts) applies to an
 * `Idempotency-Key`, a hash over the caller and the canonical body, and its
 * re-authorized replay (see {@link usageRequestHash}).
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly repository: FleetRepository) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<UsageRecordView> {
    const record = await this.repository.findUsageById(id);
    // Reported as absent rather than forbidden: a 403 would confirm that a
    // reading exists for a machine the caller is not entitled to see.
    if (!record || !(await this.mayRead(record))) throw RastaError.notFound('UsageRecord', id);

    return toUsageView(record);
  }

  /**
   * The read rule for one usage record, shared by {@link get} and every
   * replay: a supervisor (or a service caller) reads the organization's
   * records; anyone else only those filed under their own driver record.
   */
  private async mayRead(record: Pick<UsageRow, 'driverId'>): Promise<boolean> {
    const scope = currentFleetScope();
    if (scope.kind === 'SUPERVISOR') return true;
    const own = await this.repository.findDriverByUserId(scope.userId);
    return own !== null && record.driverId === own.id;
  }

  async list(query: ListUsageQuery) {
    const scope = currentFleetScope();

    let effective = query;
    if (scope.kind === 'SELF') {
      const own = await this.repository.findDriverByUserId(scope.userId);
      if (!own) return { items: [], nextCursor: null, hasMore: false };
      if (query.driverId && query.driverId !== own.id) {
        return { items: [], nextCursor: null, hasMore: false };
      }
      effective = { ...query, driverId: own.id };
    }

    const result = await this.repository.listUsage(effective);
    return {
      items: result.items.map(toUsageView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async record(request: RecordUsageDto): Promise<UsageRecordView> {
    // The validation pipe has already canonicalized; again here so that
    // what is compared, hashed and stored never depends on the path in.
    const dto = canonicalUsageRequest(request);
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? 'SYSTEM';

    // Replay check first, before any validation that could reject a record
    // that was already accepted once. A tablet resyncing a week-old reading
    // must get back the record it created then, not a fresh refusal because
    // the driver has since been suspended.
    //
    // The replay itself is decided by the binding and the read rule alone,
    // which is why it can run this early: a caller whose request hash matches
    // already sent exactly this request, and was answered with exactly this
    // record.
    const binding = dto.clientReference
      ? { reference: dto.clientReference, hash: usageRequestHash(dto) }
      : null;
    if (binding) {
      const existing = await this.repository.findUsageByClientReference(binding.reference);
      if (existing) return this.replay(existing, dto, binding.hash);
    }

    let operator: { driverId: string | null; assignmentId: string | null };
    try {
      const asset = await this.repository.findAssetRef(organizationId, dto.assetId);
      if (!asset) {
        // Absent, not forbidden — the same non-disclosure rule the rest of the
        // platform follows for a resource in another tenant.
        throw RastaError.notFound('Asset', dto.assetId);
      }

      operator = await this.resolveOperator(dto);
    } catch (refusal) {
      // Refused on the machine's or the operator's state *now*. A twin of
      // this request may have committed after the look above and before that
      // state changed — the assignment ended, the machine transferred — and
      // then this is a replay the state no longer matters to (#372 r1 F2).
      // So the reference once more, under the asset lock a twin in flight
      // holds until it commits, and with the same binding and read rule;
      // only a reference still free lets the refusal stand.
      if (binding && refusal instanceof RastaError) {
        const settled = await this.findUnderAssetLock(dto.assetId, binding.reference);
        if (settled) return this.replay(settled, dto, binding.hash);
      }
      throw refusal;
    }
    const { driverId, assignmentId } = operator;

    const periodStart = new Date(dto.periodStart);
    const periodEnd = new Date(dto.periodEnd);

    if (periodEnd.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      // A small tolerance absorbs clock skew on a field device; anything
      // beyond it is a wrong date, and accepting it would put usage into a
      // reporting window before the work happened.
      throw RastaError.businessRule('Usage cannot be recorded for a period in the future.', {
        rule: 'FUTURE_PERIOD',
        periodEnd: periodEnd.toISOString(),
      });
    }

    const id = `${ID_PREFIXES.usageRecord}_${ulid()}`;

    try {
      const outcome = await this.repository.transaction(async (tx) => {
        // Locked before the overlap check, not after: without the lock, two
        // concurrent submissions for the same machine can both read "no
        // overlap" before either has inserted, and both succeed (L3-05).
        await this.repository.lockAssetRef(tx, dto.assetId);

        // The reference again, now under the lock and before anything else
        // can refuse. A twin of this request may have passed the check above
        // at the same moment and committed while this one waited for the
        // lock; its period then overlaps this one exactly, and without this
        // look the replay would be refused as `USAGE_PERIOD_OVERLAP` — the
        // unique index below is never reached. Same binding, same read rule.
        if (binding) {
          const settled = await this.repository.findUsageByClientReference(binding.reference, tx);
          if (settled) {
            return {
              kind: 'REPLAYED',
              view: await this.replay(settled, dto, binding.hash),
            } as const;
          }
        }

        // Ownership again, now under the lock. The check above ran before it,
        // and a transfer consumed in between would otherwise let this
        // organization record usage against a machine it no longer holds.
        const locked = await this.repository.findAssetRef(organizationId, dto.assetId, tx);
        if (!locked) {
          throw RastaError.notFound('Asset', dto.assetId);
        }

        const overlapping = await this.repository.findOverlappingUsage(
          tx,
          dto.assetId,
          periodStart,
          periodEnd,
        );
        if (overlapping) {
          throw RastaError.businessRule(
            'This usage period overlaps an existing record for the same machine.',
            {
              rule: 'USAGE_PERIOD_OVERLAP',
              assetId: dto.assetId,
              // Named only when it is this organization's own record. The
              // overlap check spans owners, but naming a previous owner's
              // record would disclose it.
              ...(overlapping.organizationId === organizationId
                ? { conflictingRecordId: overlapping.id }
                : {}),
            },
          );
        }

        const record = await tx.usageRecord.create({
          data: {
            id,
            organizationId,
            assetId: dto.assetId,
            driverId,
            assignmentId,
            periodStart,
            periodEnd,
            hours: dto.hours ?? null,
            kilometres: dto.kilometres ?? null,
            hourMeter: dto.hourMeter ?? null,
            odometer: dto.odometer ?? null,
            source: dto.source,
            notes: dto.notes ?? null,
            clientReference: dto.clientReference ?? null,
            requestHash: binding?.hash ?? null,
            recordedBy: actor,
          },
        });

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'UsageRecord',
          aggregateId: id,
          eventName: FLEET_EVENTS.USAGE_RECORDED,
          topic: FLEET_TOPIC,
          organizationId,
          payload: validateFleetPayload(FLEET_EVENTS.USAGE_RECORDED, {
            usageRecordId: id,
            assetId: dto.assetId,
            organizationId,
            driverId,
            assignmentId,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            // Strings, for the same reason money is a string (ADR-022): the
            // column is NUMERIC and a JSON float would reintroduce exactly the
            // drift the column type exists to prevent.
            hours: dto.hours ?? null,
            kilometres: dto.kilometres ?? null,
            hourMeter: dto.hourMeter ?? null,
            odometer: dto.odometer ?? null,
            source: dto.source,
          }),
        });

        return { kind: 'CREATED', record } as const;
      });

      if (outcome.kind === 'REPLAYED') return outcome.view;
      usageRecordsTotal.inc({ service: SERVICE_NAME, source: dto.source });
      return toUsageView(outcome.record);
    } catch (error) {
      // Two tablets replaying the same queued reading at once: both passed the
      // replay check, one committed. The unique index is what actually makes
      // the operation idempotent, and the loser reads back the winner's row
      // rather than reporting a conflict the caller cannot act on — under the
      // same binding as the check above, so a race is no way around it.
      if (isUniqueViolation(error) && binding) {
        const existing = await this.repository.findUsageByClientReference(binding.reference);
        if (existing) return this.replay(existing, dto, binding.hash);
      }
      throw error;
    }
  }

  /** The record a reference names, read under the asset's lock: after any twin in flight. */
  private async findUnderAssetLock(assetId: string, reference: string): Promise<UsageRow | null> {
    return this.repository.transaction(async (tx) => {
      await this.repository.lockAssetRef(tx, assetId);
      return this.repository.findUsageByClientReference(reference, tx);
    });
  }

  /**
   * The record a reference already names, returned only to the request that
   * created it, and only while that caller may still read it. Every refusal —
   * another body, another caller, a caller the read rule no longer admits —
   * is one and the same `409`, so the answer never says which, nor whether
   * the reference names a record at all beyond "taken", nor anything the
   * record holds.
   *
   * Reads only, so it can run before validation and inside the usage
   * transaction alike.
   */
  private async replay(
    existing: UsageRow,
    dto: RecordUsageDto,
    requestHash: string,
  ): Promise<UsageRecordView> {
    const bound =
      existing.requestHash === null
        ? sameLegacyRequest(existing, dto, getContext(), currentFleetScope())
        : existing.requestHash === requestHash;
    if (!bound || !(await this.mayRead(existing))) throw usageReferenceReused(existing.id);

    usageDuplicatesTotal.inc({ service: SERVICE_NAME });
    // The record's id, not the client's reference: that is a key the client
    // chose, logged no more than an Idempotency-Key is (S-09).
    this.logger.debug(`Usage submission matched existing ${existing.id}`);
    return toUsageView(existing);
  }

  /**
   * Works out who operated the machine, and under which assignment.
   *
   * Three cases, and the third is the one that matters for authorization: a
   * caller holding only `DRIVER` or `OPERATOR` may record usage for the
   * machine they are actually holding, and for nothing else. Without that
   * check, any operator could file readings against the whole yard.
   */
  private async resolveOperator(
    dto: RecordUsageDto,
  ): Promise<{ driverId: string | null; assignmentId: string | null }> {
    const scope = currentFleetScope();

    if (scope.kind === 'SELF') {
      const own = await this.repository.findDriverByUserId(scope.userId);
      if (!own) {
        throw RastaError.forbidden('Only a registered driver may record usage for a machine');
      }
      if (dto.driverId && dto.driverId !== own.id) {
        throw RastaError.forbidden('You may only record usage under your own driver record');
      }

      const active = await this.repository.findActiveAssignmentForDriver(own.id);
      if (!active || active.assetId !== dto.assetId) {
        // Absent rather than forbidden: the caller learns nothing about which
        // machines exist or who else is holding them.
        throw RastaError.notFound('Asset', dto.assetId);
      }

      return { driverId: own.id, assignmentId: active.id };
    }

    if (!dto.driverId) {
      // A supervisor may record usage with no driver named — a contractor's
      // operator, or a reading taken from the meter after the fact. Losing
      // that usage would be worse than not knowing who produced it.
      const active = await this.repository.findActiveAssignmentForAsset(dto.assetId);
      return { driverId: active?.driverId ?? null, assignmentId: active?.id ?? null };
    }

    const driver = await this.repository.findDriverById(dto.driverId);
    if (!driver) throw RastaError.notFound('Driver', dto.driverId);

    const active = await this.repository.findActiveAssignmentForDriver(dto.driverId);
    // Linked only when the assignment is for this machine. A driver holding a
    // different machine gets a record with no assignment rather than one
    // attributed to the wrong job.
    const assignmentId = active && active.assetId === dto.assetId ? active.id : null;

    return { driverId: dto.driverId, assignmentId };
  }
}

/** Clock skew a field device is forgiven. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * What a `clientReference` is bound to: SHA-256 over the validated body (keys
 * sorted, defaults applied) and the caller who sent it — the shape
 * `IdempotencyStore.hash` gives an `Idempotency-Key`, through the same
 * {@link hashRequest}. Equivalent means canonically equal, one spelling per
 * value ({@link canonicalUsageRequest}): key order, `"7.50"` against `"7.5"`,
 * `…:00Z` against `…:00.000Z`, CRLF against LF in the notes — none of these
 * makes another request. An omitted quantity and `"0"` still do.
 *
 * The caller is the user; a service caller, which has no user, is its service
 * — so a record one service filed replays to that service and to no other.
 */
export function usageRequestHash(dto: RecordUsageDto): string {
  return hashRequest({ caller: usageCaller(getContext()), body: canonicalUsageRequest(dto) });
}

/**
 * The request in its canonical spelling — the forms `recordUsageSchema`
 * already gives it (./dto.ts), applied again so a caller that did not come
 * through the pipe hashes and compares the same. Each form is idempotent, and
 * only a value present is touched: omitted stays omitted.
 */
function canonicalUsageRequest(dto: RecordUsageDto): RecordUsageDto {
  const quantity = (value: string | undefined) =>
    value === undefined ? undefined : canonicalQuantity(value);
  return {
    ...dto,
    periodStart: canonicalInstant(dto.periodStart),
    periodEnd: canonicalInstant(dto.periodEnd),
    ...present('hours', quantity(dto.hours)),
    ...present('kilometres', quantity(dto.kilometres)),
    ...present('hourMeter', quantity(dto.hourMeter)),
    ...present('odometer', quantity(dto.odometer)),
    ...present('notes', dto.notes === undefined ? undefined : canonicalLineEndings(dto.notes)),
  };
}

/** `{ [key]: value }` when there is a value; nothing, so the key stays absent, when not. */
function present<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function usageCaller(context: RequestContext): Record<string, string> {
  if (context.userId) return { userId: context.userId };
  return { service: context.callerService ?? 'SYSTEM' };
}

/**
 * The binding of a row recorded before `request_hash` existed (its column is
 * NULL): no hash can be rebuilt for it, because the caller and body were never
 * stored — so the stored columns stand in, compared one by one. It replays
 * only to the **same user** (`recordedBy`) sending the **same reading**:
 *
 * - asset, period, source and notes (line endings as LF) equal; each
 *   quantity present on both sides and equal as a number (`7.50` and `7.5`:
 *   the column kept no more), or absent on both;
 * - the driver: see {@link sameLegacyOperator}.
 *
 * A row recorded by a service caller (`recordedBy` `SYSTEM`) never replays:
 * which service filed it was not stored. Anything else is a mismatch, `409`.
 * Today's "every resend replays" is not kept for these rows: it is the very
 * defect the binding removes.
 */
function sameLegacyRequest(
  row: UsageRow,
  dto: RecordUsageDto,
  context: RequestContext,
  scope: FleetScope,
): boolean {
  if (!context.userId || row.recordedBy !== context.userId) return false;
  return (
    row.assetId === dto.assetId &&
    row.periodStart.getTime() === new Date(dto.periodStart).getTime() &&
    row.periodEnd.getTime() === new Date(dto.periodEnd).getTime() &&
    sameQuantity(row.hours, dto.hours) &&
    sameQuantity(row.kilometres, dto.kilometres) &&
    sameQuantity(row.hourMeter, dto.hourMeter) &&
    sameQuantity(row.odometer, dto.odometer) &&
    row.source === dto.source &&
    (row.notes === null ? null : canonicalLineEndings(row.notes)) === (dto.notes ?? null) &&
    sameLegacyOperator(row.driverId, dto.driverId, scope)
  );
}

/**
 * The driver a legacy row stores against the one a request names. Named: they
 * must be equal. Omitted, the server resolved it, and the row cannot say
 * whether its own request omitted the driver too or named the one stored —
 * which matters, because an omitted driver resolves to whoever holds the
 * machine *now* (#372 r1 F3: a supervisor's resend without `driverId` would
 * otherwise be answered with driver A's record while driver B holds it).
 *
 * - DRIVER/OPERATOR (`SELF`): omitted and named resolve alike, to the caller's
 *   own driver record — and {@link UsageService.mayRead} admits the row only
 *   if that is the one stored. Reconstructable.
 * - Supervisor or service: only a row stored with no driver is unambiguous —
 *   a request naming one would have stored it. A stored driver is refused.
 */
function sameLegacyOperator(
  stored: string | null,
  sent: string | undefined,
  scope: FleetScope,
): boolean {
  if (sent !== undefined) return stored === sent;
  return scope.kind === 'SELF' || stored === null;
}

function sameQuantity(stored: DecimalLike | null, sent: string | undefined): boolean {
  if (stored === null || sent === undefined) return stored === null && sent === undefined;
  return new Prisma.Decimal(stored.toString()).equals(sent);
}

/**
 * The one refusal for a reference already taken by another request. The code
 * and message are the same for a changed body and for another caller: telling
 * them apart would confirm to a colleague that the reference names a record.
 * The record's id goes to the server log only (S-09: never the reference).
 */
function usageReferenceReused(usageRecordId: string): RastaError {
  return new RastaError(
    ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
    'This clientReference was already used for a different request',
    { internalContext: { usageRecordId } },
  );
}

// ---------------------------------------------------------------------------
// View mapping
// ---------------------------------------------------------------------------

interface DecimalLike {
  toString(): string;
}

interface UsageRow {
  id: string;
  organizationId: string;
  assetId: string;
  driverId: string | null;
  assignmentId: string | null;
  periodStart: Date;
  periodEnd: Date;
  hours: DecimalLike | null;
  kilometres: DecimalLike | null;
  hourMeter: DecimalLike | null;
  odometer: DecimalLike | null;
  source: string;
  notes: string | null;
  clientReference: string | null;
  requestHash: string | null;
  recordedAt: Date;
  recordedBy: string;
}

export function toUsageView(record: UsageRow): UsageRecordView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    assetId: record.assetId,
    driverId: record.driverId,
    assignmentId: record.assignmentId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    // `toString()` on Prisma's Decimal, never `toNumber()`. The whole reason
    // the column is NUMERIC is that a float cannot hold these values exactly,
    // and converting on the way out would give that up at the last step.
    hours: record.hours?.toString() ?? null,
    kilometres: record.kilometres?.toString() ?? null,
    hourMeter: record.hourMeter?.toString() ?? null,
    odometer: record.odometer?.toString() ?? null,
    source: record.source,
    notes: record.notes,
    clientReference: record.clientReference,
    recordedAt: record.recordedAt.toISOString(),
  };
}
