import request from 'supertest';
import { ulid } from 'ulid';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { startIdentityApi, userToken, type IdentityApiHarness } from './api-helpers';
import { processRegistrations, registrationBody } from './identity-fixtures';
import { id, tenants } from './helpers';
import { IdentityService } from '../src/identity/identity.service';
import { IDENTITY_EVENTS } from '../src/identity/events';
import type { SubmitRegistrationDto } from '../src/identity/dto';

/**
 * REGISTRATION_SUBMITTED keeps the submitting request's provenance across the
 * intake queue (PR #483 r2 N1).
 *
 * Since task 130 the request writes an intake row and answers; the worker
 * builds the event later, after the request — and its context — has ended.
 * Built from the context it then had, the event carried no actor and a fresh
 * correlation id, and the audit trail recorded `SYSTEM / identity-service`
 * instead of the verified submitter. Now the intake stores the request's
 * provenance in its own columns (the auth guard's principal, never the body;
 * the request's correlation id) and the worker hands it to the event
 * explicitly. Every case here submits in one request and drains after it
 * ended — from the same process, from another context, and after a restart.
 *
 * An unauthenticated submission is its own origin (PR #483 r3 F1): stored as
 * `ANONYMOUS` with no id, published with `anonymous: true` and no actor, so
 * audit records it as ANONYMOUS — never as `SYSTEM / identity-service`, the
 * service's own background work. The audit record itself is asserted where
 * audit-service runs: `audit-service/test/ingestion.int-spec.ts` (this
 * envelope, persisted) and `tests/e2e/specs/identity/04-registration-approval`
 * (through the broker, read back from `GET /v1/audit-events`).
 */
describe('REGISTRATION_SUBMITTED keeps the submitting request’s actor and correlation across the intake queue (PR #483 r2 N1)', () => {
  let harness: IdentityApiHarness;

  beforeAll(async () => {
    harness = await startIdentityApi();
  });

  afterAll(async () => {
    await harness?.close();
  });

  const fresh = (tag = 'rp') => {
    const username = `${tag}-${id('U').slice(-12)}`.toLowerCase();
    return { username, email: `${username}@example.test` };
  };
  const submit = (
    on: IdentityApiHarness,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    let call = request(on.app.getHttpServer()).post('/v1/registration-requests');
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send(body);
  };
  /** The intake row holding `username`, every column. */
  const intakeOf = (on: IdentityApiHarness, username: string) =>
    runUnscoped('test reads the intake row', () =>
      on.prisma.client.registrationIntake.findFirst({
        where: { submission: { path: ['username'], equals: username } },
      }),
    );
  /** The REGISTRATION_SUBMITTED outbox row of request `registrationId`. */
  const submittedEvent = async (registrationId: string) => {
    const rows = await runUnscoped('test reads the outbox', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { aggregateId: registrationId, eventName: IDENTITY_EVENTS.REGISTRATION_SUBMITTED },
      }),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // As every consumer reads it, audit-service's included.
    const envelope = eventEnvelopeSchema.parse(row.payload);
    return {
      actor: envelope.actor ?? null,
      anonymous: envelope.anonymous ?? false,
      correlationId: envelope.correlationId,
      rowCorrelationId: row.correlationId,
      headerCorrelationId: (row.headers as Record<string, string>)['x-correlation-id'],
    };
  };
  const sameEverywhere = (correlationId: string) => ({
    correlationId,
    rowCorrelationId: correlationId,
    headerCorrelationId: correlationId,
  });

  it('an authenticated submitter: the event names them and continues their correlation id, drained after the request ended', async () => {
    const org = tenants();
    const identity = fresh();
    const submitter = `USR_${ulid()}`;
    const token = userToken({ userId: submitter, organizationId: org.b });
    const correlationId = ulid();

    const response = await submit(
      harness,
      registrationBody(identity.username, identity.email, org.a),
      { authorization: `Bearer ${token}`, 'x-correlation-id': correlationId },
    );
    expect(response.status).toBe(202);
    expect(response.headers['x-correlation-id']).toBe(correlationId);

    // Stored apart from the submission, and no credential anywhere in the row.
    const intake = await intakeOf(harness, identity.username);
    expect(intake).toMatchObject({ actorType: 'USER', actorId: submitter, correlationId });
    expect(JSON.stringify(intake)).not.toContain(token.slice(5));
    expect(intake!.submission).not.toHaveProperty('actor');

    await processRegistrations(harness);

    const event = await submittedEvent(intake!.id);
    expect(event).toEqual({
      actor: { type: 'USER', id: submitter },
      anonymous: false,
      ...sameEverywhere(correlationId),
    });
  });

  it('an anonymous submitter: ANONYMOUS with no id — never the service’s own work — and the correlation id the request was answered under (PR #483 r3 F1)', async () => {
    const org = tenants();
    const sent = fresh();
    const minted = fresh();
    const refused = fresh();
    const correlationId = ulid();

    const withHeader = await submit(harness, registrationBody(sent.username, sent.email, org.a), {
      'x-correlation-id': correlationId,
    });
    const withoutHeader = await submit(
      harness,
      registrationBody(minted.username, minted.email, org.a),
    );
    // Not a platform id: not adopted, so the request (and its event) got a fresh one.
    const withBadHeader = await submit(
      harness,
      registrationBody(refused.username, refused.email, org.a),
      { 'x-correlation-id': 'forged correlation' },
    );
    for (const response of [withHeader, withoutHeader, withBadHeader]) {
      expect(response.status).toBe(202);
    }
    const intakes = await Promise.all(
      [sent, minted, refused].map((identity) => intakeOf(harness, identity.username)),
    );
    for (const intake of intakes) {
      expect(intake).toMatchObject({ actorType: 'ANONYMOUS', actorId: null });
    }

    // Drained inside some other request's context: it lends the events nothing.
    const unrelated: RequestContext = {
      correlationId: `unrelated-${ulid()}`,
      requestId: ulid(),
      userId: `USR_${ulid()}`,
      organizationId: org.b,
      organizationIds: [org.b],
      roles: ['SYSTEM_ADMIN'],
      authType: 'USER',
      startedAt: Date.now(),
    };
    await runWithContext(unrelated, () => processRegistrations(harness));

    expect(await submittedEvent(intakes[0]!.id)).toEqual({
      actor: null,
      anonymous: true,
      ...sameEverywhere(correlationId),
    });
    expect(await submittedEvent(intakes[1]!.id)).toEqual({
      actor: null,
      anonymous: true,
      ...sameEverywhere(withoutHeader.headers['x-correlation-id'] as string),
    });
    const badHeader = await submittedEvent(intakes[2]!.id);
    expect(badHeader).toEqual({
      actor: null,
      anonymous: true,
      ...sameEverywhere(withBadHeader.headers['x-correlation-id'] as string),
    });
    expect(badHeader.correlationId).not.toBe('forged correlation');
  });

  it('a restart between the answer and the drain loses nothing: another process drains the row with its provenance', async () => {
    const org = tenants();
    const identity = fresh();
    const submitter = `USR_${ulid()}`;
    const correlationId = ulid();

    // The process that answered: it stops before any pass of its worker.
    const answering = await startIdentityApi();
    let intakeId: string;
    try {
      const response = await submit(
        answering,
        registrationBody(identity.username, identity.email, org.a),
        {
          authorization: `Bearer ${userToken({ userId: submitter, organizationId: org.b })}`,
          'x-correlation-id': correlationId,
        },
      );
      expect(response.status).toBe(202);
      intakeId = (await intakeOf(answering, identity.username))!.id;
    } finally {
      await answering.close();
    }

    // A process started afterwards — nothing of the request in its memory.
    const restarted = await startIdentityApi();
    try {
      expect(await processRegistrations(restarted)).toBeGreaterThanOrEqual(1);
    } finally {
      await restarted.close();
    }

    expect(await submittedEvent(intakeId)).toEqual({
      actor: { type: 'USER', id: submitter },
      anonymous: false,
      ...sameEverywhere(correlationId),
    });
  });

  it('an actor in the body is never the actor: refused over HTTP, and ignored by the intake behind it', async () => {
    const org = tenants();
    const forged = { type: 'USER', id: 'USR_FORGED' };

    // The public schema is strict: a body that names an actor is not a submission.
    const overHttp = fresh();
    const before = await runUnscoped('test counts intake', () =>
      harness.prisma.client.registrationIntake.count(),
    );
    const refused = await submit(harness, {
      ...registrationBody(overHttp.username, overHttp.email, org.a),
      actor: forged,
    });
    expect(refused.status).toBe(400);
    expect(await intakeOf(harness, overHttp.username)).toBeNull();
    expect(
      await runUnscoped('test counts intake', () =>
        harness.prisma.client.registrationIntake.count(),
      ),
    ).toBeGreaterThanOrEqual(before);

    // Behind the schema, a submission object carrying actor fields anyway: the
    // provenance is the context's — none, or the verified submitter — never them.
    const service = harness.moduleRef.get(IdentityService);
    const anonymous = fresh();
    const authenticated = fresh();
    const submitter = `USR_${ulid()}`;
    const withForgery = (identity: { username: string; email: string }) =>
      ({
        ...registrationBody(identity.username, identity.email, org.a),
        documentRefs: [],
        actor: forged,
        actorType: 'USER',
        actorId: 'USR_FORGED',
        userId: 'USR_FORGED',
        correlationId: 'COR_FORGED',
      }) as unknown as SubmitRegistrationDto;
    const contextOf = (userId: string | undefined): RequestContext => ({
      correlationId: ulid(),
      requestId: ulid(),
      ...(userId ? { userId, organizationId: org.b } : {}),
      organizationIds: userId ? [org.b] : [],
      roles: [],
      authType: userId ? 'USER' : 'ANONYMOUS',
      startedAt: Date.now(),
    });
    const anonymousContext = contextOf(undefined);
    const submitterContext = contextOf(submitter);
    const anonymousId = await runWithContext(anonymousContext, () =>
      service.receiveRegistration(withForgery(anonymous)),
    );
    const authenticatedId = await runWithContext(submitterContext, () =>
      service.receiveRegistration(withForgery(authenticated)),
    );

    await processRegistrations(harness);

    expect(await submittedEvent(anonymousId)).toEqual({
      actor: null,
      anonymous: true,
      ...sameEverywhere(anonymousContext.correlationId),
    });
    expect(await submittedEvent(authenticatedId)).toEqual({
      actor: { type: 'USER', id: submitter },
      anonymous: false,
      ...sameEverywhere(submitterContext.correlationId),
    });
  });

  it('the table holds only provenance the platform could have captured', async () => {
    const insert = (actorType: string | null, actorId: string | null, correlationId: string) =>
      runUnscoped(
        'test writes an intake row by hand',
        () =>
          harness.prisma.client.$executeRaw`
          INSERT INTO registration_intake (id, submission, actor_type, actor_id, correlation_id)
          VALUES (${`REG_${ulid()}`}, '{}'::jsonb, ${actorType}, ${actorId}, ${correlationId})`,
      );
    for (const [actorType, actorId, correlationId] of [
      ['SYSTEM', 'identity-service', ulid()],
      ['USER', null, ulid()],
      ['USER', 'USR 1', ulid()],
      // An anonymous origin has no id — not even a plausible one.
      ['ANONYMOUS', 'USR_1', ulid()],
      ['ANONYMOUS', null, 'has space'],
      ['ANONYMOUS', null, ''],
    ] as const) {
      await expect(insert(actorType, actorId, correlationId)).rejects.toThrow(
        /ck_registration_intake_(actor|correlation)/,
      );
    }
    // Never no origin at all: an intake row is always some request's.
    for (const [actorType, actorId] of [
      [null, null],
      [null, 'USR_1'],
    ] as const) {
      await expect(insert(actorType, actorId, ulid())).rejects.toThrow(/Code: `23502`/); // not_null_violation
    }
    // And what a capture produces is accepted (and removed: it is no submission).
    const accepted = `REG_${ulid()}`;
    await runUnscoped('test writes an intake row by hand', async () => {
      await harness.prisma.client.$executeRaw`
        INSERT INTO registration_intake (id, submission, actor_type, actor_id, correlation_id)
        VALUES (${accepted}, '{}'::jsonb, 'ANONYMOUS', NULL, ${ulid()})`;
      await harness.prisma.client
        .$executeRaw`DELETE FROM registration_intake WHERE id = ${accepted}`;
    });
  });
});
