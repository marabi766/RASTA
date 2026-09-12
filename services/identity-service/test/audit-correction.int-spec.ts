import request from 'supertest';
import { ulid } from 'ulid';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  auditTrailPayloadSchemaV1,
  parseEnvelope,
} from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';
import { IdentityRepository } from '../src/identity/identity.repository';
import { AuditCorrectionCommandRepository } from '../src/audit-correction/audit-correction.repository';
import {
  serviceToken,
  startIdentityApi,
  userToken,
  type Caller,
  type IdentityApiHarness,
} from './api-helpers';
import { startAuditStub, type AuditStub } from './audit-stub';

/**
 * The audit correction command against a real PostgreSQL (ADR-053 § 7,
 * AUD-003 correction).
 *
 * Every request goes through the real \`AppModule\` — the global auth and role
 * guards, validation, the command service, the real outbox write and the real
 * \`audit_correction_command\` table. Only audit-service is stood in for, by a
 * stub that insists on a genuine internal token (\`audit-stub.ts\`). The domain
 * relay is inert, so every outbox row this suite causes stays put to be read.
 *
 * What it proves: one command is one outbox row and one command record,
 * committed together or not at all; the row is routed, keyed, sequenced and
 * tenanted from the trusted target and never from the request; a replay is a
 * replay, a reuse is refused, a concurrent duplicate is one effect; and a
 * missing target, a refused caller or a failed write leaves nothing behind.
 *
 * Everything written carries \`TAG\`; cleanup removes exactly that.
 */

const TAG = ulid().slice(-10);
const tagged = (prefix: string): string => `${prefix}_${TAG}_${ulid()}`;
const auditId = (): string => `01AUD${TAG}${ulid().slice(-11)}`;
const ROUTE = '/v1/audit-corrections';
const REASON = 'Recorded as SUCCESS; the operation actually failed (INC-4471)';
const SECRET_VALUE = `secret-${TAG}`;
const TRACEPARENT = '00-5af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('audit correction command (real PostgreSQL)', () => {
  let harness: IdentityApiHarness;
  let prisma: PrismaService;
  let stub: AuditStub;

  const admin: Caller = {
    userId: tagged('USR'),
    // The administrator's own acting tenant. It must never reach an event.
    organizationId: tagged('ORGADMIN'),
    roles: ['SYSTEM_ADMIN'],
  };

  interface Target {
    id: string;
    organizationId: string | null;
    occurredAt: string;
  }

  const target = (organizationId: string | null = tagged('ORG')): Target => {
    const t = {
      id: auditId(),
      organizationId,
      occurredAt: new Date(Date.now() - 60_000 - Math.floor(Math.random() * 1000)).toISOString(),
    };
    stub.targets.set(t.id, t);
    return t;
  };

  const body = (t: Target, overrides: Record<string, unknown> = {}) => ({
    auditEventId: t.id,
    occurredAt: t.occurredAt,
    reason: REASON,
    changes: [
      { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
      { field: 'credentials.password', from: SECRET_VALUE, to: `${SECRET_VALUE}-new` },
    ],
    ...overrides,
  });

  function submit(
    payload: unknown,
    options: {
      key?: string | null;
      token?: string;
      caller?: Caller;
      headers?: Record<string, string>;
    } = {},
  ) {
    const call = request(harness.app.getHttpServer())
      .post(ROUTE)
      .set('x-correlation-id', tagged('COR'))
      .set('traceparent', TRACEPARENT);
    if (options.token !== undefined) call.set('authorization', `Bearer ${options.token}`);
    else call.set('authorization', `Bearer ${userToken(options.caller ?? admin)}`);
    if (options.key !== null) call.set('idempotency-key', options.key ?? tagged('KEY'));
    for (const [name, value] of Object.entries(options.headers ?? {})) call.set(name, value);
    return call.send(payload as object);
  }

  const outboxFor = (aggregateId: string) =>
    runUnscoped('reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const commandsFor = (targetId: string) =>
    runUnscoped('reads platform plumbing', () =>
      prisma.client.auditCorrectionCommand.findMany({ where: { targetId } }),
    );

  beforeAll(async () => {
    stub = await startAuditStub();
    harness = await startIdentityApi({ auditServiceUrl: stub.url });
    prisma = harness.prisma;
  }, 60_000);

  afterEach(() => {
    stub.failWith = null;
    stub.answerAt = null;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (prisma) await cleanup();
    } finally {
      // Closed even if cleanup fails, so a failed run reports rather than hangs.
      await harness?.close();
      await stub?.close();
    }
  }, 60_000);

  async function cleanup(): Promise<void> {
    {
      await runUnscoped('integration cleanup of this run only', async () => {
        await prisma.client.$executeRawUnsafe(
          'DELETE FROM outbox_message WHERE aggregate_id LIKE $1',
          `01AUD${TAG}%`,
        );
        await prisma.client.$executeRawUnsafe(
          'DELETE FROM outbox_stream_sequence WHERE partition_key LIKE $1',
          `01AUD${TAG}%`,
        );
        await prisma.client.$executeRawUnsafe(
          'DELETE FROM audit_correction_command WHERE actor_id LIKE $1',
          `%_${TAG}_%`,
        );
      });
    }
  }

  it('accepts a tenant correction as one outbox row and one command record, tenanted by the trusted target', async () => {
    const t = target();
    const key = tagged('KEY');

    const response = await submit(body(t), { key, headers: { 'user-agent': 'correction-itest' } });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      status: 'ACCEPTED',
      eventId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      correctionOf: t.id,
      acceptedAt: expect.any(String),
    });

    const rows = await outboxFor(t.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      id: response.body.eventId,
      aggregateType: 'AuditEvent',
      aggregateId: t.id,
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: 1,
      topic: AUDIT_TRAIL_TOPIC,
      // The Kafka key: every correction of one record is one stream.
      partitionKey: t.id,
      organizationId: t.organizationId,
      publishedAt: null,
    });

    // The envelope, parsed with the very schema audit-service consumes.
    const envelope = parseEnvelope(row.payload, auditTrailPayloadSchemaV1);
    expect(envelope).toMatchObject({
      eventId: row.id,
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: 1,
      producer: 'identity-service',
      aggregateType: 'AuditEvent',
      aggregateId: t.id,
      tenantId: t.organizationId,
      streamKey: t.id,
      streamSeq: 1,
      traceparent: expect.stringMatching(/^00-5af7651916cd43dd8448eb211c80319c-/),
    });
    expect(envelope.payload).toEqual({
      actor: { type: 'USER', id: admin.userId, roles: ['SYSTEM_ADMIN'] },
      organizationId: t.organizationId,
      action: 'audit.correction',
      resourceType: 'AuditEvent',
      resourceId: t.id,
      outcome: 'SUCCESS',
      reason: REASON,
      changes: [
        { field: 'outcome', from: 'SUCCESS', to: 'FAILURE' },
        { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
      ],
      occurrenceCount: 1,
      source: { ip: expect.any(String), userAgent: 'correction-itest' },
      correctionOf: t.id,
    });
    expect(Number(row.streamSeq)).toBe(1);

    // Nothing from the request that is not evidence, and not the admin's tenant.
    const wire = JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const leaked of [SECRET_VALUE, admin.organizationId!, key]) {
      expect(wire).not.toContain(leaked);
    }

    const commands = await commandsFor(t.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      actorId: admin.userId,
      idempotencyKey: key,
      targetId: t.id,
      eventId: row.id,
      responseBody: response.body,
    });
    expect(commands[0]!.requestHash).toMatch(/^[0-9a-f]{64}$/);

    // Exactly one authenticated lookup, as the producer and for audit-service only.
    const lookups = stub.lookups.filter((lookup) => lookup.id === t.id);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatchObject({
      occurredAt: t.occurredAt,
      callerService: 'identity-service',
      purpose: 'SERVICE',
      organizationId: undefined,
    });
    expect(lookups[0]!.headers.authorization).toBeUndefined();
    expect(lookups[0]!.headers['x-organization-id']).toBeUndefined();
    expect(lookups[0]!.headers['x-correlation-id']).toBe(envelope.correlationId);
  });

  it('writes a platform-scoped correction with no tenant anywhere, whatever tenant the admin acts for', async () => {
    const t = target(null);

    const response = await submit(body(t), {
      headers: { 'x-organization-id': admin.organizationId! },
    });

    expect(response.status).toBe(202);
    const [row] = await outboxFor(t.id);
    expect(row!.organizationId).toBeNull();
    const envelope = parseEnvelope(row!.payload, auditTrailPayloadSchemaV1);
    expect(envelope).not.toHaveProperty('tenantId');
    expect(envelope.payload).not.toHaveProperty('organizationId');
    expect(envelope.payload.correctionOf).toBe(t.id);
  });

  it('replays the original 202 for the same key and request, with no second effect and no second lookup', async () => {
    const t = target();
    const key = tagged('KEY');

    const first = await submit(body(t), { key });
    const lookupsAfterFirst = stub.lookups.length;
    const second = await submit(
      // The same request, serialised differently: reordered keys, padded reason.
      {
        changes: body(t).changes,
        reason: `  ${REASON}  `,
        occurredAt: t.occurredAt,
        auditEventId: t.id,
      },
      { key },
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(stub.lookups).toHaveLength(lookupsAfterFirst);
    expect(await outboxFor(t.id)).toHaveLength(1);
    expect(await commandsFor(t.id)).toHaveLength(1);
  });

  it('refuses the same key with a different request as 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const t = target();
    const key = tagged('KEY');
    expect((await submit(body(t), { key })).status).toBe(202);

    const reused = await submit(body(t, { reason: 'A different reason' }), { key });

    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
    expect(await outboxFor(t.id)).toHaveLength(1);
  });

  it('keeps keys per actor: another administrator’s identical key is a separate command', async () => {
    const t = target();
    const key = tagged('KEY');
    const other: Caller = {
      userId: tagged('USR'),
      organizationId: tagged('ORGADMIN'),
      roles: ['SYSTEM_ADMIN'],
    };

    expect((await submit(body(t), { key })).status).toBe(202);
    expect((await submit(body(t), { key, caller: other })).status).toBe(202);

    const rows = await outboxFor(t.id);
    expect(rows).toHaveLength(2);
    // Two corrections of one record: one stream, numbered 1 then 2.
    expect(rows.map((row) => Number(row.streamSeq)).sort()).toEqual([1, 2]);
    expect(new Set(rows.map((row) => row.partitionKey))).toEqual(new Set([t.id]));
  });

  it('collapses concurrent duplicate submissions into one command and one outbox row', async () => {
    const t = target();
    const key = tagged('KEY');

    const responses = await Promise.all(Array.from({ length: 6 }, () => submit(body(t), { key })));

    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(202));
    const bodies = new Set(responses.map((r) => JSON.stringify(r.body)));
    expect(bodies.size).toBe(1);
    expect(await outboxFor(t.id)).toHaveLength(1);
    expect(await commandsFor(t.id)).toHaveLength(1);
  });

  it.each([
    ['a target audit-service does not know', (t: Target) => body({ ...t, id: auditId() })],
    [
      'the right id at the wrong instant',
      (t: Target) => body(t, { occurredAt: new Date(Date.parse(t.occurredAt) + 1).toISOString() }),
    ],
  ])('answers %s with 404 and writes nothing', async (_label, build) => {
    const t = target();
    const payload = build(t) as { auditEventId: string };

    const response = await submit(payload);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(await outboxFor(payload.auditEventId)).toHaveLength(0);
    expect(await commandsFor(payload.auditEventId)).toHaveLength(0);
  });

  it('treats an answer for another instant as no target at all', async () => {
    const t = target();
    stub.answerAt = new Date(Date.parse(t.occurredAt) - 5000).toISOString();

    const response = await submit(body(t));

    expect(response.status).toBe(404);
    expect(await outboxFor(t.id)).toHaveLength(0);
  });

  it('turns an unavailable audit-service into a bounded 503 that leaks nothing and writes nothing', async () => {
    const t = target();
    stub.failWith = 500;

    const response = await submit(body(t));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);
    const text = JSON.stringify(response.body);
    for (const leaked of [stub.url, '127.0.0.1', 'stub-internal-detail', t.organizationId!]) {
      expect(text).not.toContain(leaked);
    }
    expect(await outboxFor(t.id)).toHaveLength(0);
    expect(await commandsFor(t.id)).toHaveLength(0);
  });

  it('rolls everything back when the outbox write fails, and stays retryable with the same key', async () => {
    const t = target();
    const key = tagged('KEY');
    const repository = harness.moduleRef.get(IdentityRepository);
    jest
      .spyOn(repository, 'enqueueEvent')
      .mockRejectedValueOnce(new Error('simulated outbox failure'));

    const failed = await submit(body(t), { key });

    expect(failed.status).toBe(500);
    expect(failed.body.message).toBe(
      'The correction could not be recorded; nothing was changed and it is safe to retry',
    );
    expect(await outboxFor(t.id)).toHaveLength(0);
    expect(await commandsFor(t.id)).toHaveLength(0);

    const retried = await submit(body(t), { key });
    expect(retried.status).toBe(202);
    expect(await outboxFor(t.id)).toHaveLength(1);
  });

  it('rolls the outbox row back when the command record cannot be written after it', async () => {
    const t = target();
    const commands = harness.moduleRef.get(AuditCorrectionCommandRepository);
    jest
      .spyOn(commands, 'create')
      .mockRejectedValueOnce(new Error('simulated command-record failure'));

    const failed = await submit(body(t));

    expect(failed.status).toBe(500);
    // The outbox row was inserted first in the same transaction; it is gone.
    expect(await outboxFor(t.id)).toHaveLength(0);
    expect(await commandsFor(t.id)).toHaveLength(0);
    const counters = await runUnscoped('reads platform plumbing', () =>
      prisma.client.$queryRawUnsafe<{ next_seq: bigint }[]>(
        'SELECT next_seq FROM outbox_stream_sequence WHERE topic = $1 AND partition_key = $2',
        AUDIT_TRAIL_TOPIC,
        t.id,
      ),
    );
    // The sequence allocation rolled back with it: no gap is left behind.
    expect(counters.length === 0 || Number(counters[0]!.next_seq) === 1).toBe(true);
  });

  describe('who may correct', () => {
    it.each([
      ['UNION_ADMIN', ['UNION_ADMIN']],
      ['ORGANIZATION_ADMIN', ['ORGANIZATION_ADMIN']],
      ['AUDITOR', ['AUDITOR']],
      ['an ordinary user', ['FLEET_MANAGER']],
    ])('refuses %s with 403 before audit-service is asked anything', async (_label, roles) => {
      const t = target();
      const before = stub.lookups.length;

      const response = await submit(body(t), {
        caller: { userId: tagged('USR'), organizationId: tagged('ORG'), roles },
      });

      expect(response.status).toBe(403);
      expect(stub.lookups).toHaveLength(before);
      expect(await outboxFor(t.id)).toHaveLength(0);
    });

    it('refuses a service token with 403', async () => {
      const t = target();
      const response = await request(harness.app.getHttpServer())
        .post(ROUTE)
        .set('x-internal-token', await serviceToken('fleet-service'))
        .set('idempotency-key', tagged('KEY'))
        .send(body(t));

      expect(response.status).toBe(403);
      expect(await outboxFor(t.id)).toHaveLength(0);
    });

    it('refuses an anonymous caller with 401', async () => {
      const t = target();
      const response = await request(harness.app.getHttpServer())
        .post(ROUTE)
        .set('idempotency-key', tagged('KEY'))
        .send(body(t));

      expect(response.status).toBe(401);
      expect(await outboxFor(t.id)).toHaveLength(0);
    });
  });

  it('requires an Idempotency-Key and refuses a body that tries to name a tenant or an actor', async () => {
    const t = target();

    const noKey = await submit(body(t), { key: null });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe(ERROR_CODES.VALIDATION_FAILED);

    for (const smuggled of [
      { organizationId: tagged('ORG') },
      { actorId: tagged('USR') },
      { source: { ip: '1.2.3.4' } },
    ]) {
      const response = await submit(body(t, smuggled));
      expect(response.status).toBe(400);
    }
    expect(await outboxFor(t.id)).toHaveLength(0);
  });
});
