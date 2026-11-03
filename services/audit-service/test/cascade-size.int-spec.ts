import { performance } from 'node:perf_hooks';
import request from 'supertest';
import type { Server } from 'node:http';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import {
  ORGANIZATION_PROJECTION_EVENTS,
  ORGANIZATION_TOPIC,
  STATUS_CASCADE_CHUNK,
  toOrganizationProjection,
} from '../src/audit/organization-projection';
import { INGEST_TRANSACTION_TIMEOUT_MS } from '../src/config/operation-budgets';
import type { PrismaService } from '../src/prisma/prisma.service';
import { cleanupRun, id, newMigratorPrisma } from './helpers';
import { startApi, unionAdmin, type ApiHarness } from './api-helpers';
import { at, orgId, projectOrganization, queryWindow } from './fixtures';

/**
 * A real-sized cascade, against real PostgreSQL (PR #378 r1 F1).
 *
 * organization-service deactivates a whole subtree in one transaction and
 * publishes every identifier in one `ORGANIZATION_STATUS_CHANGED`, GZIP-
 * compressed, with no bound of its own (`organization.service.ts` §
 * `changeStatus`). The broker's size limit applies to the compressed batch, so
 * a cascade of 100,001 distinct identifiers — about 1.5 MB of JSON, about
 * 250 KB on the wire — is one the producer really sends. This suite shows the
 * projection takes it: every listed organization ends deactivated, and the
 * union above them stops reaching them.
 *
 * The descendants are seeded directly as `PROJECTED` children of one branch
 * (100,000 creation events through the consumer would only measure the seeding),
 * again before every test, so none depends on another having run (PR #378 r2
 * F2); the cascade itself goes through the real ingestion path —
 * `toAuditEventRecord`, `toOrganizationProjection` and `AuditRepository.ingest`,
 * exactly as `DomainProjectorConsumer` calls them — in the one transaction and
 * the chunks of `STATUS_CASCADE_CHUNK` production uses. Distinct identifiers on
 * purpose: a repeated one would be de-duplicated to a single row and prove
 * nothing about size.
 */
describe('audit hierarchy projection of a 100,001-organization cascade (real PostgreSQL)', () => {
  let api: ApiHarness;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let server: Server;

  /** The caller's union. Never named in the cascade, so it stays ACTIVE. */
  const UNION = orgId('CASCADE-UNION');
  /** The organization whose deactivation cascades. Also listed in `affectedIds`. */
  const BRANCH = orgId('CASCADE-BRANCH');
  const DESCENDANT_COUNT = 100_000;
  /** Every cascade id carries the run tag, so `cleanupRun` removes the rows. */
  const DESCENDANT_PREFIX = `${orgId('CASCADE-D')}-`;
  const descendant = (index: number): string =>
    `${DESCENDANT_PREFIX}${String(index).padStart(6, '0')}`;
  /** First, a middle one, and last: one per end of the chunk loop and between. */
  const SAMPLES = [descendant(1), descendant(50_000), descendant(DESCENDANT_COUNT)];
  const affectedIds = [
    BRANCH,
    ...Array.from({ length: DESCENDANT_COUNT }, (_, index) => descendant(index + 1)),
  ];

  const delivery: EventDelivery = Object.freeze({
    topic: ORGANIZATION_TOPIC,
    partition: 0,
  }) as EventDelivery;

  const query = (organizationId: string) =>
    request(server)
      .get('/v1/audit-events')
      .query({ ...queryWindow(), organizationId })
      .set('Authorization', `Bearer ${unionAdmin(UNION)}`);

  const countWithStatus = async (status: string): Promise<number> => {
    const [row] = await migrator.client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count FROM organization_ref
        WHERE (organization_id LIKE $1 OR organization_id = $2) AND status = $3`,
      `${DESCENDANT_PREFIX}%`,
      BRANCH,
      status,
    );
    return Number(row?.count ?? 0n);
  };

  /**
   * The cascade, through the real ingestion path: `toAuditEventRecord`,
   * `toOrganizationProjection` and `AuditRepository.ingest`, as
   * `DomainProjectorConsumer` calls them. A new event id each time, so the
   * processed marker never turns it into a redelivery.
   */
  async function cascade(): Promise<{ outcome: string; elapsedMs: number }> {
    const source = {
      eventId: id('EVT'),
      eventName: ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED,
      eventVersion: 1,
      occurredAt: at(9).toISOString(),
      producer: 'organization-service',
      producerVersion: '1.0.0',
      aggregateType: 'Organization',
      aggregateId: BRANCH,
      tenantId: BRANCH,
      correlationId: id('CORR'),
      payload: { organizationId: BRANCH, newStatus: 'DEACTIVATED', affectedIds },
    } as EventEnvelope;

    const projection = toOrganizationProjection(source, delivery);
    expect(projection).toMatchObject({ kind: 'STATUS_CHANGED' });

    const started = performance.now();
    const outcome = await repository.ingest(
      toAuditEventRecord(source, delivery),
      DOMAIN_PROJECTOR_CONSUMER,
      projection,
    );
    return { outcome, elapsedMs: performance.now() - started };
  }

  beforeAll(async () => {
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();
    api = await startApi();
    server = api.app.getHttpServer() as Server;
    repository = api.app.get(AuditRepository);
  }, 180_000);

  // Every test starts from the same hierarchy, all of it ACTIVE, whatever ran
  // before it (AGENTS.md § 5): each one that needs the cascade runs it itself.
  beforeEach(async () => {
    await projectOrganization(migrator, {
      organizationId: UNION,
      relationObservedAt: at(1),
    });
    await projectOrganization(migrator, {
      organizationId: BRANCH,
      parentOrganizationId: UNION,
      relationObservedAt: at(2),
    });
    // One statement: every descendant a projected, active child of the branch,
    // observed before the cascade so its monotonic guard lets the cascade in.
    await migrator.client.$executeRawUnsafe(
      `INSERT INTO organization_ref (
         organization_id, parent_organization_id, status, relation_state, relation_observed_at
       )
       SELECT $1 || lpad(g::text, 6, '0'), $2, 'ACTIVE', 'PROJECTED', $3
         FROM generate_series(1, $4::int) AS g
       ON CONFLICT (organization_id) DO UPDATE
          SET parent_organization_id = EXCLUDED.parent_organization_id,
              status                 = EXCLUDED.status,
              relation_state         = EXCLUDED.relation_state,
              relation_observed_at   = EXCLUDED.relation_observed_at`,
      DESCENDANT_PREFIX,
      BRANCH,
      at(3),
      DESCENDANT_COUNT,
    );
  }, 180_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await migrator.onModuleDestroy();
  }, 180_000);

  it('reaches every sampled descendant before the cascade (the positive control)', async () => {
    expect(await countWithStatus('ACTIVE')).toBe(DESCENDANT_COUNT + 1);
    for (const organizationId of [BRANCH, ...SAMPLES]) {
      expect((await query(organizationId)).status).toBe(200);
    }
  });

  it('accepts the cascade of 100,001 distinct identifiers within the ingest transaction budget', async () => {
    expect(new Set(affectedIds).size).toBe(DESCENDANT_COUNT + 1);
    const { outcome, elapsedMs } = await cascade();

    expect(outcome).toBe('WRITTEN');
    // One transaction (`INGEST_TRANSACTION`), ceil(100,001 / 500) = 201 chunks.
    // Printed so CI records the margin, which the bounded-cascade follow-up uses.
    console.warn(
      `[cascade-budget] ${affectedIds.length} ids in ${Math.ceil(affectedIds.length / STATUS_CASCADE_CHUNK)} chunks: ` +
        `${Math.round(elapsedMs)} ms of the ${INGEST_TRANSACTION_TIMEOUT_MS} ms ingest transaction budget`,
    );
    expect(elapsedMs).toBeLessThan(INGEST_TRANSACTION_TIMEOUT_MS);
  }, 120_000);

  it('leaves no listed organization ACTIVE after the cascade, and the union, which it did not name, ACTIVE', async () => {
    expect(await countWithStatus('ACTIVE')).toBe(DESCENDANT_COUNT + 1);
    expect((await cascade()).outcome).toBe('WRITTEN');

    expect(await countWithStatus('ACTIVE')).toBe(0);
    expect(await countWithStatus('DEACTIVATED')).toBe(DESCENDANT_COUNT + 1);
    const union = await api.prisma.client.organizationRef.findUniqueOrThrow({
      where: { organizationId: UNION },
    });
    expect(union.status).toBe('ACTIVE');
  }, 120_000);

  it("no longer lets the union's UNION_ADMIN reach a deactivated descendant after the cascade", async () => {
    expect((await query(BRANCH)).status).toBe(200);
    expect((await cascade()).outcome).toBe('WRITTEN');

    for (const organizationId of [BRANCH, ...SAMPLES]) {
      expect((await query(organizationId)).status).toBe(403);
      expect(await repository.isWithinProjectedSubtree(UNION, organizationId)).toBe(false);
    }
  }, 120_000);
});
