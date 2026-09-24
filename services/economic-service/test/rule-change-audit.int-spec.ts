import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup } from './helpers';

/**
 * Every commission and reward rule change leaves a record: who, when, and the
 * terms before and after (docs/10 § 10.7, ADR-023).
 *
 * `updatedBy` on the row said who touched it last and nothing about what it
 * had been. The record is an outbox event written in the same transaction as
 * the change, so a rule cannot change without one and a record cannot
 * describe a change that rolled back — which is also why a refused change is
 * asserted here to have written nothing.
 */
describe('rule change audit records', () => {
  let harness: ApiHarness;
  let http: Server;

  const org = apiTenant('RULE-AUDIT');
  const actorId = `USR-RULE-AUDIT-${ulid().slice(-8)}`;
  const asSystem = () =>
    `Bearer ${bearer({
      sub: `sub-${ulid()}`,
      rastaUserId: actorId,
      organizationId: org,
      organizationIds: [org],
      roles: ['SYSTEM_ADMIN'],
    })}`;

  interface ChangeRecord {
    ruleId: string;
    change: 'CREATED' | 'UPDATED';
    changedBy: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  }

  async function recordsFor(eventName: string, ruleId: string): Promise<ChangeRecord[]> {
    const rows = await runUnscoped('the suite reads the outbox it asserts on', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { eventName, aggregateId: ruleId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // The outbox stores the whole envelope; the record is its payload.
    return rows.map((row) => (row.payload as unknown as { payload: ChangeRecord }).payload);
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [org]);
    await harness.close();
  });

  it('records a commission rule’s creation, its close, and not a refused reprice', async () => {
    const created = await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asSystem())
      .send({ organizationId: org, transactionType: 'LOGISTICS', rateBasisPoints: 120 })
      .expect(201);
    const ruleId = created.body.id as string;

    const [creation] = await recordsFor('COMMISSION_RULE_CHANGED', ruleId);
    expect(creation).toMatchObject({
      ruleId,
      change: 'CREATED',
      changedBy: actorId,
      before: null,
      after: { organizationId: org, rateBasisPoints: 120, validTo: null, status: 'ACTIVE' },
    });

    await request(http)
      .patch(`/v1/commissions/rules/${ruleId}`)
      .set('authorization', asSystem())
      .send({ rateBasisPoints: 300 })
      .expect(400);
    expect(await recordsFor('COMMISSION_RULE_CHANGED', ruleId)).toHaveLength(1);

    const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await request(http)
      .patch(`/v1/commissions/rules/${ruleId}`)
      .set('authorization', asSystem())
      .send({ validTo: inAnHour, label: 'بسته — جایگزین دارد' })
      .expect(200);

    const records = await recordsFor('COMMISSION_RULE_CHANGED', ruleId);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      change: 'UPDATED',
      changedBy: actorId,
      before: { rateBasisPoints: 120, validTo: null, label: null },
      after: { rateBasisPoints: 120, validTo: inAnHour, label: 'بسته — جایگزین دارد' },
    });
  });

  it('records a platform-wide rule under the organization the administrator acted from', async () => {
    const created = await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asSystem())
      .send({ transactionType: 'PROCUREMENT_ORDER', rateBasisPoints: 0, status: 'INACTIVE' })
      .expect(201);

    const [row] = await runUnscoped('the suite reads the outbox it asserts on', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { eventName: 'COMMISSION_RULE_CHANGED', aggregateId: created.body.id },
      }),
    );
    expect(row?.organizationId).toBe(org);
    const record = (row?.payload as unknown as { payload: ChangeRecord }).payload;
    expect(record.after.organizationId).toBeNull();
  });

  it('records a reward rule’s creation and close, and not a refused change of terms', async () => {
    const created = await request(http)
      .post('/v1/rewards/rules')
      .set('authorization', asSystem())
      .send({ organizationId: org, triggerEvent: 'MAINTENANCE_COMPLETED', points: 7 })
      .expect(201);
    const ruleId = created.body.id as string;

    const [creation] = await recordsFor('REWARD_RULE_CHANGED', ruleId);
    expect(creation).toMatchObject({
      change: 'CREATED',
      changedBy: actorId,
      before: null,
      after: { points: 7, creditPerPointMinor: null },
    });

    await request(http)
      .patch(`/v1/rewards/rules/${ruleId}`)
      .set('authorization', asSystem())
      .send({ creditPerPointMinor: '1000' })
      .expect(400);
    expect(await recordsFor('REWARD_RULE_CHANGED', ruleId)).toHaveLength(1);

    await request(http)
      .patch(`/v1/rewards/rules/${ruleId}`)
      .set('authorization', asSystem())
      .send({ status: 'INACTIVE' })
      .expect(200);

    const records = await recordsFor('REWARD_RULE_CHANGED', ruleId);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      change: 'UPDATED',
      before: { status: 'ACTIVE', points: 7 },
      after: { status: 'INACTIVE', points: 7 },
    });
  });
});
