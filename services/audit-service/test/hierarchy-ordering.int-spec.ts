import request from 'supertest';
import type { Server } from 'node:http';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import {
  ORGANIZATION_PROJECTION_EVENTS,
  ORGANIZATION_TOPIC,
  toOrganizationProjection,
} from '../src/audit/organization-projection';
import type { PrismaService } from '../src/prisma/prisma.service';
import { cleanupRun, id, newMigratorPrisma } from './helpers';
import { startApi, unionAdmin, type ApiHarness } from './api-helpers';
import { at, orgId, queryWindow } from './fixtures';

/**
 * Out-of-order and replayed organization events, against real PostgreSQL.
 *
 * ## Why this suite exists separately from `tenant-isolation.int-spec.ts`
 *
 * That suite seeds the projection directly and asks what a query returns. This
 * one asks a narrower and nastier question: what the projection *becomes* when
 * the events that build it do not arrive in the order they happened — and
 * whether the answer can ever be wider than the truth.
 *
 * The ordering is not hypothetical. `services/organization-service/src/
 * organization/routing.ts` partitions every organization event by its
 * **aggregate id**, so Kafka orders one organization's own lifecycle and
 * nothing else. `ORGANIZATION_STATUS_CHANGED` is keyed by the organization
 * whose status changed but names its entire subtree in `affectedIds`
 * (`organization.service.ts` § `changeStatus`), and every one of those
 * descendants lives on a different partition. A descendant's DEACTIVATED
 * cascade and that descendant's own `ORGANIZATION_CREATED` therefore carry no
 * ordering relationship at all, and a consumer replaying from the beginning of
 * the log reads its partitions concurrently.
 *
 * Everything here runs through the real ingestion path — `toAuditEventRecord`,
 * `toOrganizationProjection` and `AuditRepository.ingest`, exactly as
 * `DomainProjectorConsumer` calls them — so the transaction boundary, the
 * `ON CONFLICT` guard and the recursive subtree walk are the real ones.
 */
describe('audit hierarchy projection under out-of-order delivery (real PostgreSQL)', () => {
  let api: ApiHarness;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let server: Server;

  /** The caller's union. Stays ACTIVE throughout, so no assertion below can pass because the root itself was refused. */
  const UNION = orgId('OOO-UNION');
  /** A branch beneath the union. Deactivated, together with its subtree. */
  const BRANCH = orgId('OOO-BRANCH');
  /**
   * Named in the branch's DEACTIVATED cascade, and whose own — older —
   * `ORGANIZATION_CREATED` is consumed afterwards, from another partition.
   *
   * That older event still names the parent this organization was *born*
   * under, the union itself, because it was moved beneath the branch later.
   * So the stale event does not merely restate what the cascade said: applied,
   * it would attach a deactivated organization directly to an active union.
   */
  const LATE_CHILD = orgId('OOO-LATE-CHILD');
  /** The positive control: an ordinary child of the union, created in order. */
  const SIBLING = orgId('OOO-SIBLING');

  const window = queryWindow();

  const delivery: EventDelivery = Object.freeze({
    topic: ORGANIZATION_TOPIC,
    partition: 0,
  }) as EventDelivery;

  function envelope(aggregateId: string, eventName: string, occurredAt: Date, payload: unknown) {
    return {
      // Carries the run tag, which is what `cleanupRun` deletes on.
      eventId: id('EVT'),
      eventName,
      eventVersion: 1,
      occurredAt: occurredAt.toISOString(),
      producer: 'organization-service',
      producerVersion: '1.0.0',
      aggregateType: 'Organization',
      aggregateId,
      tenantId: aggregateId,
      correlationId: id('CORR'),
      payload,
    } as EventEnvelope;
  }

  /** Ingests one organization event the way the consumer does, and asserts it landed. */
  async function project(source: EventEnvelope): Promise<void> {
    const record = toAuditEventRecord(source, delivery);
    const projection = toOrganizationProjection(source, delivery);
    expect(projection).not.toBeNull();
    expect(await repository.ingest(record, DOMAIN_PROJECTOR_CONSUMER, projection)).toBe('WRITTEN');
  }

  const created = (
    organizationId: string,
    parentId: string | null,
    depth: number,
    occurredAt: Date,
    status = 'ACTIVE',
  ): EventEnvelope =>
    envelope(organizationId, ORGANIZATION_PROJECTION_EVENTS.CREATED, occurredAt, {
      organizationId,
      status,
      parentId,
      path: parentId === null ? organizationId : `${parentId}/${organizationId}`,
      depth,
    });

  const statusChanged = (
    organizationId: string,
    newStatus: string,
    affectedIds: string[],
    occurredAt: Date,
  ): EventEnvelope =>
    envelope(organizationId, ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED, occurredAt, {
      organizationId,
      newStatus,
      affectedIds,
    });

  const refOf = (organizationId: string) =>
    api.prisma.client.organizationRef.findUniqueOrThrow({ where: { organizationId } });

  const query = (organizationId: string, callerOrganizationId: string) =>
    request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId })
      .set('Authorization', `Bearer ${unionAdmin(callerOrganizationId)}`);

  beforeAll(async () => {
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();

    api = await startApi();
    server = api.app.getHttpServer() as Server;
    repository = api.app.get(AuditRepository);

    // The order below is the order the projector consumed them in, and it is
    // deliberately not the order they happened in.

    // 1. The union and the branch beneath it, in order. Both events are keyed
    //    by their own aggregate, so Kafka really does order these two against
    //    the branch's later status change.
    await project(created(UNION, null, 0, at(1)));
    await project(created(BRANCH, UNION, 1, at(2)));
    await project(created(SIBLING, UNION, 1, at(3)));

    // 2. The branch is deactivated at minute 9, and the cascade names the
    //    child the owning service saw beneath it at that moment.
    await project(statusChanged(BRANCH, 'DEACTIVATED', [BRANCH, LATE_CHILD], at(9)));

    // 3. Only now does the child's own creation arrive — five minutes older
    //    than the cascade, from a partition that never promised otherwise.
    await project(created(LATE_CHILD, UNION, 1, at(4)));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await migrator.onModuleDestroy();
  }, 120_000);

  // -------------------------------------------------------------------------
  // The security property: a cascade a descendant's row did not exist for is
  // still retained, so the older event cannot re-authorize the descendant.
  // -------------------------------------------------------------------------

  it('refuses a union administrator the descendant its own older creation would have restored', async () => {
    // Without the retained marker this is a 200. The cascade would have found
    // no row to update and dropped the deactivation; the older creation would
    // then have written `PROJECTED`/`ACTIVE` with the union as its parent, and
    // a deactivated organization would sit one hop beneath an active union —
    // readable by that union's administrator, on the authority of an event
    // that predates the deactivation, with nothing anywhere reporting an error.
    const response = await query(LATE_CHILD, UNION);

    expect(response.status).toBe(403);
  });

  it('reaches an ordinary child of the same union', async () => {
    // The positive control. Without it the refusal above could equally be a
    // broken harness, an unprojected root, or a subtree walk that never works.
    const response = await query(SIBLING, UNION);

    expect(response.status).toBe(200);
  });

  it('retains the cascade for an organization it had no row for', async () => {
    const row = await refOf(LATE_CHILD);

    expect(row.status).toBe('DEACTIVATED');
    expect(row.relationObservedAt?.toISOString()).toBe(at(9).toISOString());
    // A status change says nothing about parentage, so the row the cascade
    // created claims none: `UNKNOWN`, with no parent link. It remembers that a
    // status at least this new was seen and conducts no authority in either
    // direction.
    expect(row.relationState).toBe('UNKNOWN');
    expect(row.parentOrganizationId).toBeNull();
  });

  it('leaves the older creation event with nothing to write', async () => {
    // The whole point of the monotonic guard: the older event is a no-op rather
    // than an error. Had it been applied, `relationObservedAt` would read
    // minute 4 and `relationState` would read `PROJECTED`.
    const row = await refOf(LATE_CHILD);

    expect(row.relationObservedAt?.toISOString()).not.toBe(at(4).toISOString());
    expect(row.hierarchyDepth).toBeNull();
    expect(row.hierarchyPath).toBeNull();
  });

  it('keeps the hierarchy of a row the cascade updated rather than demoting it', async () => {
    // The other half of the `ON CONFLICT` branch. The branch was `PROJECTED`
    // before its own status changed, and a status change must not evict a
    // legitimate descendant from its union by overwriting `relation_state` or
    // clearing the parent link it never carried a value for.
    const row = await refOf(BRANCH);

    expect(row.status).toBe('DEACTIVATED');
    expect(row.relationState).toBe('PROJECTED');
    expect(row.parentOrganizationId).toBe(UNION);
    expect(row.hierarchyDepth).toBe(1);
    expect(row.relationObservedAt?.toISOString()).toBe(at(9).toISOString());
  });

  it('keeps the union itself active and unaffected by a cascade that did not name it', async () => {
    const row = await refOf(UNION);

    expect(row.status).toBe('ACTIVE');
    expect(row.relationState).toBe('PROJECTED');
    expect(row.relationObservedAt?.toISOString()).toBe(at(1).toISOString());
  });

  // -------------------------------------------------------------------------
  // Replay: an older status event redelivered after a newer one.
  // -------------------------------------------------------------------------

  it('ignores an older status event replayed after a newer one', async () => {
    // A rebalance redelivers, and the consumer replays from the beginning of
    // whatever the broker still holds. A status event carrying an *older*
    // `occurredAt` must not wind either row forward into an active state — and
    // it arrives as a genuinely new delivery, with its own event id, so the
    // idempotency marker is not what refuses it. The `relation_observed_at`
    // guard is.
    await project(statusChanged(BRANCH, 'ACTIVE', [BRANCH, LATE_CHILD], at(5)));

    for (const organizationId of [BRANCH, LATE_CHILD]) {
      const row = await refOf(organizationId);
      expect(row.status).toBe('DEACTIVATED');
      expect(row.relationObservedAt?.toISOString()).toBe(at(9).toISOString());
    }

    // And the authorization answer is unchanged, which is what the guard is for.
    expect((await query(LATE_CHILD, UNION)).status).toBe(403);
    expect((await query(BRANCH, UNION)).status).toBe(403);
  });

  it('applies a newer status event to both an existing and an absent row', async () => {
    // The positive control for the guard: it refuses older events, not every
    // event. A cascade newer than minute 9 lands on the branch, on the child
    // the projection knows only as an identifier, and on one it has never heard
    // of at all.
    const NEVER_SEEN = orgId('OOO-NEVER-SEEN');

    await project(statusChanged(BRANCH, 'SUSPENDED', [BRANCH, LATE_CHILD, NEVER_SEEN], at(12)));

    for (const organizationId of [BRANCH, LATE_CHILD, NEVER_SEEN]) {
      const row = await refOf(organizationId);
      expect(row.status).toBe('SUSPENDED');
      expect(row.relationObservedAt?.toISOString()).toBe(at(12).toISOString());
    }

    // Suspension is not deactivation, so the branch is the union's again — it
    // is exactly when an organization is suspended that somebody needs its
    // trail. The child stays refused: its row is still `UNKNOWN`, so it belongs
    // to no subtree whatever its status says.
    expect((await query(BRANCH, UNION)).status).toBe(200);
    expect((await query(LATE_CHILD, UNION)).status).toBe(403);
  });
});
