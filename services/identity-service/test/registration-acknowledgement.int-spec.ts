import { Logger } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { startIdentityApi, type IdentityApiHarness } from './api-helpers';
import {
  asAnonymousRequest,
  http,
  processRegistrations,
  registrationBody,
  seedPerson,
} from './identity-fixtures';
import { id, tenants } from './helpers';
import { IdentityService } from '../src/identity/identity.service';
import type { SubmitRegistrationDto } from '../src/identity/dto';

/**
 * Public registration answers the same, and does the same, whoever already has
 * an account (task 117, audit F5; task 130, PR #483 r1 R5).
 *
 * `POST /v1/registration-requests` needs no token. It used to answer
 * `409 ALREADY_EXISTS` when the username or the email was taken and `201`
 * with the new request's id otherwise: sent with one field fresh and the other
 * a guess, the answer said whether the guess had an account. Task 117 made
 * every valid request get `202 {"status":"RECEIVED"}`, byte for byte; the work
 * behind it still differed, and so did the time. Now every valid submission
 * writes one intake row and commits — nothing else, and nothing that depends
 * on who holds what — and the registration worker decides afterwards: a
 * request recorded for a fresh identity; for an email or a username already
 * held (each on its own), one held by a removed user (the unique indexes are
 * global, `schema.prisma`), or two at once racing for the same one, nothing
 * recorded, nothing emitted, the submission dropped, and neither the username
 * nor the email logged.
 */
describe('public registration answers the same, and does the same, whoever already has an account (task 117 F5, task 130 R5)', () => {
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
  /** Every row the request path can write, counted platform-wide. */
  const tables = () =>
    runUnscoped('test counts every table a submission could touch', async () => ({
      intake: await harness.prisma.client.registrationIntake.count(),
      users: await harness.prisma.client.user.count(),
      requests: await harness.prisma.client.registrationRequest.count(),
      outbox: await harness.prisma.client.outboxMessage.count(),
    }));
  const delta = (before: Record<string, number>, after: Record<string, number>) =>
    Object.fromEntries(Object.keys(before).map((table) => [table, after[table]! - before[table]!]));
  /** The intake rows still holding `username` or `email`. */
  const intakeHolding = (username: string, email: string) =>
    runUnscoped('test looks for the intake rows', () =>
      harness.prisma.client.registrationIntake.count({
        where: {
          OR: [
            { submission: { path: ['username'], equals: username } },
            { submission: { path: ['email'], equals: email } },
          ],
        },
      }),
    );

  it('a fresh identity: 202 and the one acknowledgement, no id in it, and the request recorded', async () => {
    const org = tenants();
    const identity = fresh();

    const response = await api.register(registrationBody(identity.username, identity.email, org.a));

    expect(response.status).toBe(202);
    expect(response.text).toBe('{"status":"RECEIVED"}');
    // Answered before anything is decided about it: received, not yet recorded.
    expect(await recorded(identity.username, identity.email)).toEqual({ users: 0, requests: 0 });
    expect(await intakeHolding(identity.username, identity.email)).toBe(1);

    await processRegistrations(harness);

    expect(await recorded(identity.username, identity.email)).toEqual({ users: 1, requests: 1 });
    expect(await intakeHolding(identity.username, identity.email)).toBe(0);
  });

  it('every valid submission does the same database work before its answer: one intake row, nothing else — fresh or held alike', async () => {
    const org = tenants();
    const holder = await seedPerson(harness.prisma, 'RA-WORK', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    const control = fresh();
    const cases = [
      registrationBody(control.username, control.email, org.a),
      registrationBody(fresh().username, holder.email, org.a),
      registrationBody(holder.username, fresh().email, org.a),
    ];

    const deltas = [];
    for (const body of cases) {
      const before = await tables();
      expect((await api.register(body)).status).toBe(202);
      deltas.push(delta(before, await tables()));
    }

    expect(deltas).toEqual(Array(3).fill({ intake: 1, users: 0, requests: 0, outbox: 0 }));
    await processRegistrations(harness);
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
    await processRegistrations(harness);
    expect(await recorded(otherName.username, holder.email)).toEqual({ users: 1, requests: 0 });
    expect(await recorded(holder.username, otherEmail.email)).toEqual({ users: 1, requests: 0 });
    // Dropped, with the applicant's details: nothing of either kept.
    expect(await intakeHolding(otherName.username, holder.email)).toBe(0);
    expect(await intakeHolding(holder.username, otherEmail.email)).toBe(0);
    expect(await recorded(control.username, control.email)).toEqual({ users: 1, requests: 1 });
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
    await processRegistrations(harness);
    expect(
      await runUnscoped('test counts requests for the removed user', () =>
        harness.prisma.client.registrationRequest.count({
          where: { user: { OR: [{ username: removed.username }, { email: removed.email }] } },
        }),
      ),
    ).toBe(0);
  });

  it('two at once for one identity: both acknowledged alike, one request recorded', async () => {
    const org = tenants();
    const identity = fresh();
    const body = registrationBody(identity.username, identity.email, org.a);

    const answers = await Promise.all([api.register(body), api.register(body), api.register(body)]);

    expect(answers.map(visible)).toEqual(Array(3).fill(visible(answers[0]!)));
    expect(answers[0]!.status).toBe(202);
    expect(await intakeHolding(identity.username, identity.email)).toBe(3);
    await processRegistrations(harness);
    expect(await recorded(identity.username, identity.email)).toEqual({ users: 1, requests: 1 });
    expect(await intakeHolding(identity.username, identity.email)).toBe(0);
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
      await processRegistrations(harness);
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

  /**
   * The timing assertion. Byte equality says nothing about time; the test
   * above proves the request path writes the same rows either way. This one
   * measures the time to the answer for a fresh identity and for one whose
   * email or username is held, interleaved — the order alternating each
   * round, so drift and warm-up fall on both alike — after a warm-up, and
   * asserts their medians agree within ±25 %.
   *
   * Asserted at the service boundary (`submitRegistration`, everything the
   * handler runs but the HTTP and Nest pipeline): that pipeline costs the same
   * for every request and only dilutes a gap — measured locally, the defect
   * this guards (a held identity skipping its intake) showed as 0.76–0.83 over
   * HTTP but well outside the bound here. The HTTP medians are measured and
   * reported too, not asserted, for that reason.
   *
   * Its limits, honestly: the test database on this machine, not a network;
   * a median over 40 pairs bounds a systematic gap, not a single request's;
   * and the bound is generous enough not to flake on a loaded runner, so a
   * gap smaller than ±25 % is not caught here — the row-count test above,
   * which is exact, is what says the work is the same.
   */
  it('the time to the answer does not say whether the identity is held: medians within ±25 % over 40 interleaved pairs', async () => {
    const org = tenants();
    const holder = await seedPerson(harness.prisma, 'RA-TIME', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    const service = harness.moduleRef.get(IdentityService);
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const asNew = () => {
      const identity = fresh('rt');
      return registrationBody(identity.username, identity.email, org.a);
    };
    const held = (round: number) =>
      round % 4 < 2
        ? registrationBody(fresh('rt').username, holder.email, org.a)
        : registrationBody(holder.username, fresh('rt').email, org.a);

    /** Medians of `ROUNDS` interleaved pairs, timed by `timed`: [new, held]. */
    const measure = async (timed: (body: Record<string, unknown>) => Promise<number>) => {
      const ROUNDS = 40;
      const WARM_UP = 6;
      const newTimes: number[] = [];
      const heldTimes: number[] = [];
      for (let round = 0; round < ROUNDS + WARM_UP; round += 1) {
        let fresh: number;
        let taken: number;
        if (round % 2 === 0) {
          fresh = await timed(asNew());
          taken = await timed(held(round));
        } else {
          taken = await timed(held(round));
          fresh = await timed(asNew());
        }
        if (round < WARM_UP) continue;
        newTimes.push(fresh);
        heldTimes.push(taken);
      }
      return { asNew: median(newTimes), held: median(heldTimes) };
    };

    const atService = await measure(async (body) => {
      const dto = { ...body, documentRefs: [] } as unknown as SubmitRegistrationDto;
      const started = performance.now();
      await asAnonymousRequest(() => service.submitRegistration(dto));
      return performance.now() - started;
    });
    const overHttp = await measure(async (body) => {
      const started = performance.now();
      const response = await api.register(body);
      const elapsed = performance.now() - started;
      expect(response.status).toBe(202);
      return elapsed;
    });
    await processRegistrations(harness);

    const ratio = atService.held / atService.asNew;
    // eslint-disable-next-line no-console
    console.info(
      `registration acknowledgement, median of 40 interleaved pairs: at the service new ` +
        `${atService.asNew.toFixed(2)} ms, held ${atService.held.toFixed(2)} ms, ratio ${ratio.toFixed(3)}; ` +
        `over HTTP new ${overHttp.asNew.toFixed(2)} ms, held ${overHttp.held.toFixed(2)} ms, ratio ` +
        `${(overHttp.held / overHttp.asNew).toFixed(3)} (reported)`,
    );
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
  });
});
