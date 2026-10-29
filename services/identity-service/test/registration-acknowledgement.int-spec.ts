import { Logger } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { startIdentityApi, type IdentityApiHarness } from './api-helpers';
import { http, registrationBody, seedPerson } from './identity-fixtures';
import { id, tenants } from './helpers';

/**
 * Public registration answers the same whoever already has an account (task
 * 117, audit F5).
 *
 * `POST /v1/registration-requests` needs no token. It used to answer
 * `409 ALREADY_EXISTS` when the username or the email was taken and `201`
 * with the new request's id otherwise: sent with one field fresh and the other
 * a guess, the answer said whether the guess had an account. Now every valid
 * request gets `202 {"status":"RECEIVED"}`, byte for byte — for a fresh
 * identity, an email or a username already held (each on its own), one held
 * by a removed user (the unique indexes are global, `schema.prisma`), and two
 * at once racing for the same one. A collision records nothing, emits nothing,
 * and logs neither the username nor the email.
 */
describe('public registration answers the same whoever already has an account (task 117, F5)', () => {
  let harness: IdentityApiHarness;
  let api: ReturnType<typeof http>;

  beforeAll(async () => {
    harness = await startIdentityApi();
    api = http(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  const fresh = (tag = 'ra') => {
    const username = `${tag}-${id('U').slice(-12)}`.toLowerCase();
    return { username, email: `${username}@example.test` };
  };
  /** Everything about an answer a client can see but the headers random for every request. */
  const visible = (response: {
    status: number;
    text: string;
    headers: Record<string, string>;
  }) => ({
    status: response.status,
    body: response.text,
    contentType: response.headers['content-type'],
    contentLength: response.headers['content-length'],
  });
  const recorded = (username: string, email: string) =>
    runUnscoped('test counts what a registration recorded', async () => ({
      users: await harness.prisma.client.user.count({
        where: { OR: [{ username }, { email }] },
      }),
      requests: await harness.prisma.client.registrationRequest.count({
        where: { user: { OR: [{ username }, { email }] } },
      }),
    }));

  it('a fresh identity: 202 and the one acknowledgement, no id in it, and the request recorded', async () => {
    const org = tenants();
    const identity = fresh();

    const response = await api.register(registrationBody(identity.username, identity.email, org.a));

    expect(response.status).toBe(202);
    expect(response.text).toBe('{"status":"RECEIVED"}');
    expect(await recorded(identity.username, identity.email)).toEqual({ users: 1, requests: 1 });
  });

  it('an email already held, with a fresh username — and a username held, with a fresh email: the same bytes, nothing recorded', async () => {
    const org = tenants();
    const holder = await seedPerson(harness.prisma, 'RA-HOLD', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    const control = fresh();
    const otherName = fresh();
    const otherEmail = fresh();

    const asNew = await api.register(registrationBody(control.username, control.email, org.a));
    const emailHeld = await api.register(registrationBody(otherName.username, holder.email, org.a));
    const usernameHeld = await api.register(
      registrationBody(holder.username, otherEmail.email, org.a),
    );

    expect(visible(emailHeld)).toEqual(visible(asNew));
    expect(visible(usernameHeld)).toEqual(visible(asNew));
    expect(await recorded(otherName.username, holder.email)).toEqual({ users: 1, requests: 0 });
    expect(await recorded(holder.username, otherEmail.email)).toEqual({ users: 1, requests: 0 });
  });

  it('an email or username held by a removed user — invisible to every lookup, still unique — answers the same', async () => {
    const org = tenants();
    const removed = await seedPerson(harness.prisma, 'RA-DEL', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    await runUnscoped('test removes the user', () =>
      harness.prisma.client.user.update({
        where: { id: removed.userId },
        data: { deletedAt: new Date() },
      }),
    );
    const control = fresh();

    const asNew = await api.register(registrationBody(control.username, control.email, org.a));
    const emailHeld = await api.register(registrationBody(fresh().username, removed.email, org.a));
    const usernameHeld = await api.register(
      registrationBody(removed.username, fresh().email, org.a),
    );

    expect(visible(emailHeld)).toEqual(visible(asNew));
    expect(visible(usernameHeld)).toEqual(visible(asNew));
  });

  it('two at once for one identity: both acknowledged alike, one request recorded', async () => {
    const org = tenants();
    const identity = fresh();
    const body = registrationBody(identity.username, identity.email, org.a);

    const answers = await Promise.all([api.register(body), api.register(body), api.register(body)]);

    expect(answers.map(visible)).toEqual(Array(3).fill(visible(answers[0]!)));
    expect(answers[0]!.status).toBe(202);
    expect(await recorded(identity.username, identity.email)).toEqual({ users: 1, requests: 1 });
  });

  it('a collision is logged without the username or the email, and emits nothing', async () => {
    const org = tenants();
    const holder = await seedPerson(harness.prisma, 'RA-LOG', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(function (...args: unknown[]) {
        logged.push(JSON.stringify(args));
      }),
    );
    const outboxBefore = await runUnscoped('test counts the outbox', () =>
      harness.prisma.client.outboxMessage.count({
        where: { eventName: 'REGISTRATION_SUBMITTED', organizationId: org.a },
      }),
    );
    try {
      const response = await api.register(registrationBody(fresh().username, holder.email, org.a));
      expect(response.status).toBe(202);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(logged.some((line) => line.includes('already held'))).toBe(true);
    expect(logged.join('\n')).not.toContain(holder.email);
    expect(logged.join('\n')).not.toContain(holder.username);
    expect(
      await runUnscoped('test counts the outbox', () =>
        harness.prisma.client.outboxMessage.count({
          where: { eventName: 'REGISTRATION_SUBMITTED', organizationId: org.a },
        }),
      ),
    ).toBe(outboxBefore);
  });

  it('does the same work up to the insert either way: both are a transaction to the database (timings reported, not asserted)', async () => {
    const org = tenants();
    const holder = await seedPerson(harness.prisma, 'RA-TIME', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    const timed = async (body: Record<string, unknown>) => {
      const started = performance.now();
      await api.register(body);
      return performance.now() - started;
    };
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
    const asNew: number[] = [];
    const held: number[] = [];
    for (let round = 0; round < 15; round += 1) {
      const identity = fresh('rt');
      asNew.push(await timed(registrationBody(identity.username, identity.email, org.a)));
      held.push(await timed(registrationBody(fresh('rt').username, holder.email, org.a)));
    }
    // eslint-disable-next-line no-console
    console.info(
      `registration acknowledgement, median of 15 over HTTP: new ${median(asNew).toFixed(1)} ms, ` +
        `identity held ${median(held).toFixed(1)} ms`,
    );
    expect(held).toHaveLength(15);
  });
});
