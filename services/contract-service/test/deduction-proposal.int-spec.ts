import request from 'supertest';
import type { Logger } from '@rasta/logging';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { EXCEPTION_FILTER_LOGGER, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { EventPublisher } from '../src/events/publisher';
import { DeductionRuleRepository } from '../src/deduction/deduction-rule.repository';
import { deductionReceiptSchema } from '../src/deduction/dto';
import { PROPOSE_DEDUCTION_ENDPOINT } from '../src/deduction/deduction-rule.service';
import { bearer, internalToken, person, startApi, type ApiHarness } from './api-helpers';
import {
  configureDeductionRule,
  ownerDatabaseUrl,
  RULE_APPROVER,
  cleanup,
  wire,
  type Wiring,
} from './helpers';
import { seedSigned, http, idemKey } from './amendment-helpers';

/** Real AppModule/AuthGuard/tenant guard, restricted PG16 runtime and canonical migrations.
 * Verifier is a synthetic claims fixture; Kafka/relay and BOTH reconciliation workers are inert.
 * Repository approval/withdrawal below are owned fixture operations, not new HTTP endpoints.
 */
describe('CON003-2a employer proposal command', () => {
  let api: ApiHarness;
  let w: Wiring;
  let owner: PrismaClient;
  const organizations: string[] = [];
  const org = (): string => {
    const id = `ORG_codex-con003-1351-${ulid()}`;
    organizations.push(id);
    return id;
  };
  const identity = {
    sub: 'codex-con003-1351-sub',
    rastaUserId: 'USR_codex-con003-1351',
    iss: 'fixture-issuer',
  };
  const writer = (organizationId: string, roles = ['ORGANIZATION_ADMIN']): string =>
    person(organizationId, roles, identity);
  const body = (name = `Rule ${ulid()}`) => ({ kind: 'CREATE', name, rateBp: 500, base: 'GROSS' });
  const post = (token: string | undefined, payload: object, key = idemKey('codex1351')) => {
    const call = request(api.app.getHttpServer())
      .post('/v1/deduction-rules/changes')
      .set('Idempotency-Key', key);
    if (token) call.set('Authorization', `Bearer ${token}`);
    return call.send(payload);
  };
  const inspect = <T>(read: () => Promise<T>): Promise<T> =>
    runUnscoped(
      'owned synthetic proposal test inspection with explicit organization predicates',
      read,
    );
  const effects = (organizationId: string) =>
    inspect(async () => ({
      changes: await w.prisma.client.deductionRuleChange.count({ where: { organizationId } }),
      events: await w.prisma.client.outboxMessage.count({
        where: { organizationId, eventName: 'DEDUCTION_RULE_CHANGE_PROPOSED' },
      }),
      keys: await w.prisma.client.idempotencyKey.count({
        where: { organizationId, endpoint: PROPOSE_DEDUCTION_ENDPOINT },
      }),
    }));
  const rules = (organizationId: string) =>
    inspect(() =>
      w.prisma.client.deductionRule.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    );
  const change = (organizationId: string, id: string) =>
    inspect(() =>
      w.prisma.client.deductionRuleChange.findFirstOrThrow({ where: { organizationId, id } }),
    );
  const repo = new DeductionRuleRepository();
  const decide = async (
    organizationId: string,
    id: string,
    decision: 'approve' | 'reject' | 'withdraw',
  ): Promise<void> => {
    const row = await change(organizationId, id);
    await w.prisma.transaction(async (tx) => {
      const input = {
        organizationId,
        changeId: id,
        expectedVersion: row.version,
        at: new Date(),
        actor:
          decision === 'withdraw'
            ? {
                userId: row.proposedBy,
                issuer: row.proposedByIssuer,
                subject: row.proposedBySubject,
              }
            : { ...RULE_APPROVER, issuer: row.proposedByIssuer },
      };
      if (decision === 'reject') await repo.reject(tx, { ...input, reason: 'fixture decision' });
      else await repo[decision](tx, input);
    });
  };

  beforeAll(async () => {
    api = await startApi({ CONTRACT_DEDUCTION_WRITER_ROLES: 'ORGANIZATION_ADMIN' });
    w = wire();
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    // Every effective pool (including the cleanup helper's separately resolved URL) is checked.
    for (const [pool, expectedRole] of [
      [api.prisma.client, 'rasta_contract'],
      [w.prisma.client, 'rasta_contract'],
      [owner, 'rasta_contract_migrator'],
    ] as const) {
      const rows = await pool.$queryRaw<
        { db: string; role: string; port: number }[]
      >`SELECT current_database() AS db, current_user AS role, inet_server_port() AS port`;
      expect(rows).toEqual([{ db: 'rasta_contract', role: expectedRole, port: 5432 }]);
    }
    for (const key of ['DATABASE_URL', 'DATABASE_URL_CONTRACT', 'DATABASE_URL_CONTRACT_MIGRATOR']) {
      const url = new URL(process.env[key] ?? '');
      expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
      expect(url.port).toBe(new URL(process.env.DATABASE_URL_CONTRACT ?? '').port);
      expect(url.pathname).toBe('/rasta_contract');
    }
  });
  afterAll(async () => {
    await cleanup(organizations);
    await owner.$disconnect();
    await w.close();
    await api.close();
  });

  it('CREATE and RETIRE persist pending proposals and exact identifier-only row/envelope/receipt facts without changing rules or statement money in either tenant', async () => {
    const signed = await seedSigned(api, w, organizations);
    const other = org();
    const rule = await configureDeductionRule(w.prisma, signed.employer, 'Existing tax', 650);
    await configureDeductionRule(w.prisma, other, 'Other tax', 700);
    const statement = await http(api)
      .post(`/v1/contracts/${signed.id}/statements`)
      .set('Authorization', `Bearer ${signed.contractorToken}`)
      .set('Idempotency-Key', idemKey('fixture-statement'))
      .send({
        lines: [{ description: 'Owned fixture work', amountMinor: '10001' }],
        deductions: [{ deductionRuleId: rule.id }],
      })
      .expect(201);
    const snapshot = () =>
      inspect(async () => ({
        rules: await w.prisma.client.deductionRule.findMany({
          where: { organizationId: { in: [signed.employer, other] } },
          orderBy: { id: 'asc' },
        }),
        statements: await w.prisma.client.statement.findMany({
          where: { organizationId: { in: [signed.employer, other] } },
          include: { deductions: true, lines: true },
        }),
      }));
    const otherSigned = await seedSigned(api, w, organizations);
    const otherRule = await configureDeductionRule(
      w.prisma,
      otherSigned.employer,
      'Other statement tax',
      725,
    );
    await http(api)
      .post(`/v1/contracts/${otherSigned.id}/statements`)
      .set('Authorization', `Bearer ${otherSigned.contractorToken}`)
      .set('Idempotency-Key', idemKey('other-statement'))
      .send({
        lines: [{ description: 'Other owned fixture work', amountMinor: '20003' }],
        deductions: [{ deductionRuleId: otherRule.id }],
      })
      .expect(201);
    // Include a second tenant's actual historical monetary snapshot as well.
    const otherBefore = await inspect(() =>
      w.prisma.client.statement.findMany({
        where: { organizationId: otherSigned.employer },
        include: { deductions: true, lines: true },
      }),
    );
    const before = await snapshot();
    expect(statement.body.netMinor).toBeDefined();
    for (const payload of [
      body(),
      { kind: 'RETIRE', deductionRuleId: rule.id, reason: 'Private reason sentinel' },
    ]) {
      const response = await post(writer(signed.employer), payload).expect(201);
      expect(deductionReceiptSchema.parse(response.body)).toEqual(response.body);
      const persisted = await change(signed.employer, response.body.id as string);
      expect(persisted.status).toBe('PENDING_APPROVAL');
      expect(persisted.version).toBe(1);
      const event = await inspect(() =>
        w.prisma.client.outboxMessage.findFirstOrThrow({
          where: { organizationId: signed.employer, aggregateId: persisted.id },
        }),
      );
      const envelope = eventEnvelopeSchema.parse(event.payload);
      expect(envelope.payload).toEqual({
        changeId: persisted.id,
        organizationId: persisted.organizationId,
        kind: persisted.kind,
        proposedAt: persisted.proposedAt.toISOString(),
        proposedBy: persisted.proposedBy,
        version: 1,
      });
      expect(envelope).toMatchObject({
        tenantId: persisted.organizationId,
        aggregateType: 'DeductionRuleChange',
        aggregateId: persisted.id,
        actor: { type: 'USER', id: persisted.proposedBy },
        streamKey: persisted.id,
        occurredAt: persisted.proposedAt.toISOString(),
      });
      expect(event.partitionKey).toBe(persisted.id);
      expect(response.body.proposedAt).toBe(persisted.proposedAt.toISOString());
    }
    expect(await snapshot()).toEqual(before);
    expect(
      await inspect(() =>
        w.prisma.client.statement.findMany({
          where: { organizationId: otherSigned.employer },
          include: { deductions: true, lines: true },
        }),
      ),
    ).toEqual(otherBefore);
  });

  it.each([
    ['CONTRACTOR'],
    ['AUDITOR'],
    ['SYSTEM_ADMIN'],
    ['DRIVER'],
    ['ORGANIZATION_ADMIN', 'CONTRACTOR'],
    ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'],
    ['ORGANIZATION_ADMIN', 'AUDITOR'],
  ])('refuses prohibited or mixed roles %j before any claim', async (...roles: string[]) => {
    const organizationId = org();
    await post(writer(organizationId, roles), body()).expect(403);
    expect(await effects(organizationId)).toEqual({ changes: 0, events: 0, keys: 0 });
  });

  it('refuses unauthenticated, service, missing selected organization, missing platform ID and unknown actor pair', async () => {
    const organizationId = org();
    await post(undefined, body()).expect(401);
    await post(undefined, body())
      .set('x-internal-token', await internalToken('economic-service', { organizationId }))
      .expect(403);
    await post(
      bearer({ ...identity, organizationIds: [], roles: ['ORGANIZATION_ADMIN'] }),
      body(),
    ).expect(403);
    await post(
      person(organizationId, ['ORGANIZATION_ADMIN'], { ...identity, rastaUserId: undefined }),
      body(),
    ).expect(403);
    const unknown = await post(
      person(organizationId, ['ORGANIZATION_ADMIN'], { ...identity, iss: '' }),
      body(),
    ).expect(422);
    expect(JSON.stringify(unknown.body)).toContain('ACTOR_IDENTITY_UNKNOWN');
    expect(await effects(organizationId)).toEqual({ changes: 0, events: 0, keys: 0 });
  });

  it('denies empty writer configuration without a default grant', async () => {
    const closed = await startApi({ CONTRACT_DEDUCTION_WRITER_ROLES: '' });
    const organizationId = org();
    try {
      await request(closed.app.getHttpServer())
        .post('/v1/deduction-rules/changes')
        .set('Authorization', `Bearer ${writer(organizationId)}`)
        .set('Idempotency-Key', idemKey('closed'))
        .send(body())
        .expect(403);
      expect(await effects(organizationId)).toEqual({ changes: 0, events: 0, keys: 0 });
    } finally {
      await closed.close();
    }
  });

  it('uses asymmetric tenant-specific verified roles and refuses nonmembership independently', async () => {
    const a = org(),
      b = org(),
      stranger = org();
    const token = bearer({
      ...identity,
      organizationId: a,
      organizationIds: [a, b],
      roles: [],
      organizationRoles: [`${a}:ORGANIZATION_ADMIN`, `${b}:DRIVER`],
    });
    await post(token, body()).set('X-Organization-Id', a).expect(201);
    await post(token, body()).set('X-Organization-Id', b).expect(403);
    await post(token, body()).set('X-Organization-Id', stranger).expect(403);
    expect(await effects(b)).toEqual({ changes: 0, events: 0, keys: 0 });
    expect(await effects(stranger)).toEqual({ changes: 0, events: 0, keys: 0 });
  });

  it('requires a valid idempotency header and refuses strict variant fields, rates and base before effects', async () => {
    const organizationId = org();
    for (const key of ['', 'short']) await post(writer(organizationId), body(), key).expect(400);
    for (const payload of [
      { ...body(), organizationId },
      { ...body(), rateBp: 0 },
      { ...body(), rateBp: 10001 },
      { ...body(), rateBp: 1.5 },
      { ...body(), base: 'NET' },
      { ...body(), name: 'A'.repeat(201) },
      { kind: 'RETIRE', deductionRuleId: 'x'.repeat(129), reason: 'reason' },
      { kind: 'RETIRE', deductionRuleId: 'DDR_x', reason: '😀'.repeat(501) },
    ]) {
      const response = await post(writer(organizationId), payload).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
    expect(await effects(organizationId)).toEqual({ changes: 0, events: 0, keys: 0 });
  });

  it('refuses NUL/malformed Unicode input and verified identities with constant errors and no driver/log disclosure or effects', async () => {
    const organizationId = org();
    const spy = jest
      .spyOn(api.app.get<Logger>(EXCEPTION_FILTER_LOGGER), 'debug')
      .mockImplementation(() => undefined);
    const sentinels = ['private-sentinel\u0000tail', 'private-sentinel\ud800tail'];
    try {
      for (const sentinel of sentinels) {
        for (const payload of [
          { ...body(), name: sentinel },
          { kind: 'RETIRE', deductionRuleId: sentinel, reason: 'reason' },
          { kind: 'RETIRE', deductionRuleId: 'DDR_x', reason: sentinel },
        ]) {
          const response = await post(writer(organizationId), payload).expect(400);
          expect(response.body.code).toBe('VALIDATION_FAILED');
          expect(JSON.stringify(response.body)).not.toContain('private-sentinel');
        }
        for (const changedIdentity of [
          { sub: sentinel },
          { iss: sentinel },
          { rastaUserId: sentinel },
        ]) {
          const response = await post(
            person(organizationId, ['ORGANIZATION_ADMIN'], { ...identity, ...changedIdentity }),
            body(),
          ).expect(422);
          expect(JSON.stringify(response.body)).not.toContain('private-sentinel');
        }
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain('private-sentinel');
      expect(await effects(organizationId)).toEqual({ changes: 0, events: 0, keys: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns indistinguishable 404 for foreign, unknown and retired RETIRE targets, without partial effects', async () => {
    const a = org(),
      b = org();
    const foreign = await configureDeductionRule(w.prisma, b, 'Foreign', 500);
    const retired = await configureDeductionRule(w.prisma, a, 'Retired', 500);
    const pending = await w.prisma.transaction((tx) =>
      repo.proposeRetire(tx, {
        organizationId: a,
        deductionRuleId: retired.id,
        reason: 'fixture',
        proposer: identityActor(),
        at: new Date(),
      }),
    );
    await decide(a, pending.id, 'approve');
    const before = await effects(a);
    const answers = [];
    for (const deductionRuleId of [foreign.id, 'DDR_unknown', retired.id]) {
      const response = await post(writer(a), {
        kind: 'RETIRE',
        deductionRuleId,
        reason: 'private reason',
      }).expect(404);
      answers.push([response.body.code, response.body.message]);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(await effects(a)).toEqual(before);
  });

  function identityActor() {
    return { userId: identity.rastaUserId, issuer: identity.iss, subject: identity.sub };
  }

  it('hashes the canonical body and stores valid supplementary Unicode reasons by code points', async () => {
    const organizationId = org(),
      key = idemKey('canonical');
    const rule = await configureDeductionRule(w.prisma, organizationId, 'Unicode target', 500);
    const before = await rules(organizationId);
    const original = await post(writer(organizationId), body('  Canonical\tName  '), key).expect(
      201,
    );
    expect(
      (await post(writer(organizationId), body('Canonical Name'), key).expect(201)).body,
    ).toEqual(original.body);
    const reason = '😀'.repeat(500);
    const retirement = await post(writer(organizationId), {
      kind: 'RETIRE',
      deductionRuleId: rule.id,
      reason,
    }).expect(201);
    expect((await change(organizationId, retirement.body.id as string)).reason).toBe(reason);
    expect(await effects(organizationId)).toEqual({ changes: 3, events: 2, keys: 2 });
    expect(await rules(organizationId)).toEqual(before);
  });

  it('replays the original 201, binds all actor components and body, and rechecks current role authorization', async () => {
    const organizationId = org(),
      key = idemKey('replay'),
      payload = body();
    const original = await post(writer(organizationId), payload, key).expect(201);
    expect((await post(writer(organizationId), payload, key).expect(201)).body).toEqual(
      original.body,
    );
    for (const changed of [
      { sub: 'other-sub' },
      { iss: 'other-issuer' },
      { rastaUserId: 'USR_other' },
    ]) {
      const token = person(organizationId, ['ORGANIZATION_ADMIN'], { ...identity, ...changed });
      const refused = await post(token, payload, key).expect(409);
      expect(refused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(JSON.stringify(refused.body)).not.toContain(original.body.id as string);
    }
    await post(writer(organizationId), { ...payload, rateBp: 501 }, key).expect(409);
    await post(writer(organizationId, ['DRIVER']), payload, key).expect(403);
    expect(await effects(organizationId)).toEqual({ changes: 1, events: 1, keys: 1 });
  });

  it('treats an independently authorized tenant switch as its own keyspace and never replays a foreign receipt', async () => {
    const a = org(),
      b = org(),
      key = idemKey('switch'),
      payload = body();
    const token = bearer({
      ...identity,
      organizationId: a,
      organizationIds: [a, b],
      roles: [],
      organizationRoles: [`${a}:ORGANIZATION_ADMIN`, `${b}:ORGANIZATION_ADMIN`],
    });
    const first = await post(token, payload, key).set('X-Organization-Id', a).expect(201);
    const second = await post(token, payload, key).set('X-Organization-Id', b).expect(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect(second.body.organizationId).toBe(b);
    const foreign = await configureDeductionRule(w.prisma, a, 'A rule', 500);
    await post(token, { kind: 'RETIRE', deductionRuleId: foreign.id, reason: 'reason' })
      .set('X-Organization-Id', b)
      .expect(404);
    expect(await effects(a)).toEqual({ changes: 2, events: 1, keys: 1 });
    expect(await effects(b)).toEqual({ changes: 1, events: 1, keys: 1 });
  });

  it.each(['approve', 'reject', 'withdraw'] as const)(
    'preserves the original receipt after fixture %s with no eligibility recheck or extra event',
    async (decision) => {
      const organizationId = org(),
        key = idemKey('later'),
        payload = body();
      const original = await post(writer(organizationId), payload, key).expect(201);
      await decide(organizationId, original.body.id as string, decision);
      expect((await post(writer(organizationId), payload, key).expect(201)).body).toEqual(
        original.body,
      );
      expect(await effects(organizationId)).toEqual({ changes: 1, events: 1, keys: 1 });
    },
  );

  it('replays RETIRE after fixture approval retired the target, but an expired key is a fresh 404', async () => {
    const organizationId = org(),
      key = idemKey('ttl');
    const rule = await configureDeductionRule(w.prisma, organizationId, 'Target', 500);
    const payload = { kind: 'RETIRE', deductionRuleId: rule.id, reason: 'reason' };
    const original = await post(writer(organizationId), payload, key).expect(201);
    await decide(organizationId, original.body.id as string, 'approve');
    expect((await post(writer(organizationId), payload, key).expect(201)).body).toEqual(
      original.body,
    );
    await owner.idempotencyKey.updateMany({
      where: { organizationId, endpoint: PROPOSE_DEDUCTION_ENDPOINT, key },
      data: { expiresAt: new Date(0) },
    });
    await post(writer(organizationId), payload, key).expect(404);
    expect(await effects(organizationId)).toEqual({ changes: 2, events: 1, keys: 0 });
  });

  it('enforces the shipped pending-name key for Tax A / taxa while allowing an active-name replacement and another tenant', async () => {
    const a = org(),
      b = org();
    await configureDeductionRule(w.prisma, a, 'Tax A', 500);
    await post(writer(a), body('Tax A')).expect(201);
    const spy = jest
      .spyOn(api.app.get<Logger>(EXCEPTION_FILTER_LOGGER), 'debug')
      .mockImplementation(() => undefined);
    try {
      const response = await post(writer(a), body('taxa')).expect(409);
      expect(response.body.code).toBe('ALREADY_EXISTS');
      expect(JSON.stringify([response.body, spy.mock.calls])).not.toMatch(/Tax A|taxa/);
    } finally {
      spy.mockRestore();
    }
    await post(writer(b), body('taxa')).expect(201);
    expect(await effects(a)).toEqual({ changes: 2, events: 1, keys: 1 });
    expect(await effects(b)).toEqual({ changes: 1, events: 1, keys: 1 });
  });

  it('sanitizes RETIRE pending-slot conflicts without reason disclosure', async () => {
    const organizationId = org();
    const rule = await configureDeductionRule(w.prisma, organizationId, 'Retire target', 500);
    const payload = { kind: 'RETIRE', deductionRuleId: rule.id, reason: 'Private-retire-sentinel' };
    await post(writer(organizationId), payload).expect(201);
    const spy = jest
      .spyOn(api.app.get<Logger>(EXCEPTION_FILTER_LOGGER), 'debug')
      .mockImplementation(() => undefined);
    try {
      const response = await post(writer(organizationId), payload).expect(409);
      expect(response.body.code).toBe('ALREADY_EXISTS');
      expect(JSON.stringify([response.body, spy.mock.calls])).not.toContain(
        'Private-retire-sentinel',
      );
    } finally {
      spy.mockRestore();
    }
    expect(await effects(organizationId)).toEqual({ changes: 2, events: 1, keys: 1 });
  });

  it('rolls back proposal/event/sequence/response together on actual publisher aggregate mismatch', async () => {
    const organizationId = org();
    const publisher = api.app.get(EventPublisher),
      original = publisher.enqueue.bind(publisher);
    const spy = jest
      .spyOn(publisher, 'enqueue')
      .mockImplementationOnce((tx, input) => original(tx, { ...input, aggregateId: 'DRC_wrong' }));
    const beforeSequences = await w.prisma.client.outboxStreamSequence.count();
    try {
      await post(writer(organizationId), body()).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await w.prisma.client.outboxStreamSequence.count()).toBe(beforeSequences);
    expect(await effects(organizationId)).toEqual({ changes: 0, events: 0, keys: 0 });
  });

  it('real concurrent different keys contend for one pending slot with one proposal/event/response', async () => {
    const organizationId = org(),
      payload = body();
    const before = await rules(organizationId);
    const results = await Promise.all([
      post(writer(organizationId), payload),
      post(writer(organizationId), payload),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('ALREADY_EXISTS');
    expect(await effects(organizationId)).toEqual({ changes: 1, events: 1, keys: 1 });
    expect(await rules(organizationId)).toEqual(before);
  });

  it('concurrent same-key requests have bounded legal results then replay the sole original receipt', async () => {
    const organizationId = org(),
      payload = body(),
      key = idemKey('same');
    const results = await Promise.all([
      post(writer(organizationId), payload, key),
      post(writer(organizationId), payload, key),
    ]);
    expect(results.some((r) => r.status === 201)).toBe(true);
    for (const result of results) expect([201, 409]).toContain(result.status);
    const winner = results.find((r) => r.status === 201)!;
    expect((await post(writer(organizationId), payload, key).expect(201)).body).toEqual(
      winner.body,
    );
    expect(await effects(organizationId)).toEqual({ changes: 1, events: 1, keys: 1 });
  });

  it('live held claim returns bounded CONFLICT/Retry-After:1 then original 201 after holder commits', async () => {
    const organizationId = org(),
      payload = body(),
      key = idemKey('held');
    let unblock!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // Pause before the business transaction starts, after its committed claim. This tests
    // the store's live-claim wait without extending a database transaction's timeout.
    const original = api.prisma.transaction.bind(api.prisma);
    const spy = jest.spyOn(api.prisma, 'transaction').mockImplementation(async (fn, options) => {
      if (options === undefined) {
        entered();
        await hold;
      }
      return original(fn, options);
    });
    const winner = post(writer(organizationId), payload, key).then((r) => r);
    try {
      await ready;
      const response = await post(writer(organizationId), payload, key).expect(409);
      expect(response.body.code).toBe('CONFLICT');
      expect(response.headers['retry-after']).toBe('1');
    } finally {
      unblock();
      spy.mockRestore();
    }
    const committed = await winner;
    expect(committed.status).toBe(201);
    expect((await post(writer(organizationId), payload, key).expect(201)).body).toEqual(
      committed.body,
    );
    expect(await effects(organizationId)).toEqual({ changes: 1, events: 1, keys: 1 });
  });

  it('real RETIRE/fixture-approval race preserves legal 404/409 and no refused transaction effects', async () => {
    const organizationId = org();
    const rule = await configureDeductionRule(w.prisma, organizationId, 'Race target', 500);
    const first = await post(writer(organizationId), {
      kind: 'RETIRE',
      deductionRuleId: rule.id,
      reason: 'first',
    }).expect(201);
    const [response] = await Promise.all([
      post(writer(organizationId), { kind: 'RETIRE', deductionRuleId: rule.id, reason: 'second' }),
      decide(organizationId, first.body.id as string, 'approve'),
    ]);
    expect([404, 409]).toContain(response.status);
    expect(await effects(organizationId)).toEqual({ changes: 2, events: 1, keys: 1 });
    // Only the explicitly concurrent canonical fixture approval retired this row.
    expect((await rules(organizationId))[0]?.retiredAt).not.toBeNull();
  });

  it.each([
    'missing',
    'extra',
    'type',
    'foreign',
    'organization',
    'kind',
    'time',
    'status',
    'version',
  ])(
    'fails closed on corrupted cached receipt: %s, without reexecution or disclosure',
    async (corruption) => {
      const organizationId = org(),
        payload = body(),
        key = idemKey('corrupt');
      const original = await post(writer(organizationId), payload, key).expect(201);
      const bad: Record<string, unknown> = { ...original.body };
      if (corruption === 'missing') delete bad.id;
      if (corruption === 'extra') bad.secret = 'private-cache-sentinel';
      if (corruption === 'type') bad.id = 42;
      if (corruption === 'foreign') {
        const other = org();
        const own = await post(writer(other), body()).expect(201);
        bad.id = own.body.id;
      }
      if (corruption === 'organization') bad.organizationId = 'ORG_foreign';
      if (corruption === 'kind') bad.kind = 'RETIRE';
      if (corruption === 'time') bad.proposedAt = '2026-01-01T00:00:00.000Z';
      if (corruption === 'status') bad.status = 'APPROVED';
      if (corruption === 'version') bad.version = 2;
      await owner.idempotencyKey.updateMany({
        where: { organizationId, endpoint: PROPOSE_DEDUCTION_ENDPOINT, key },
        data: { responseBody: bad as object },
      });
      const response = await post(writer(organizationId), payload, key).expect(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('private-cache-sentinel');
      expect(await effects(organizationId)).toEqual({ changes: 1, events: 1, keys: 1 });
    },
  );
});
