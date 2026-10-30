import { Logger } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { startIdentityApi, type IdentityApiHarness } from './api-helpers';
import {
  asAnonymousRequest,
  http,
  observeDatabaseWork,
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
   * The timing property, proved on its cause rather than on a clock. Byte
   * equality says nothing about time, and a wall-clock comparison of fresh and
   * held submissions can only estimate it: a median of 40 interleaved pairs
   * agreed within ±25 % on a quiet machine and read 1.48 on a loaded CI runner
   * (main CI 41028991378, attempt 1) with the product unchanged — a bound wide
   * enough not to flake on every runner is too wide to see a smaller gap, and
   * a tight one fails a correct service. The product has no padding or
   * deadline to measure: it equalises by doing the same thing. A submission is
   * one `INSERT` into `registration_intake`, with nothing in it, before it, or
   * under it (the table's indexes, constraints and triggers, next test) that
   * reads or is constrained by who holds a username or an email. So the time to
   * the answer cannot depend on that, whatever the machine is doing.
   *
   * Asserted on exactly that, for the five ways an identity can be held or
   * not — fresh; email held; username held; email, and username, held by a
   * removed user — through both entry points: the service call, and the HTTP
   * route with its whole Nest pipeline (guards, pipes, interceptors, filters).
   * Every operation the request makes on the service's database client is
   * listed by shape (statement text with `?` for the parameters, and each
   * parameter's kind); each held case must list what a fresh one lists, and
   * that must be the single intake insert. A held identity that skips its
   * insert, a lookup that runs only for a fresh one or only for a held one,
   * or a query of the user table added to the path at all, fails here on every
   * run, not on one in several.
   */
  it('every valid submission asks the database for exactly the same thing before its answer — fresh or held, at the service and over HTTP', async () => {
    const org = tenants();
    const holder = await seedPerson(harness.prisma, 'RA-ASK', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    const removed = await seedPerson(harness.prisma, 'RA-ASKDEL', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    await runUnscoped('test removes the user', () =>
      harness.prisma.client.user.update({
        where: { id: removed.userId },
        data: { deletedAt: new Date() },
      }),
    );
    const service = harness.moduleRef.get(IdentityService);
    const identities = {
      fresh: () => ({ ...fresh('rt') }),
      'email held': () => ({ username: fresh('rt').username, email: holder.email }),
      'username held': () => ({ username: holder.username, email: fresh('rt').email }),
      'email held by a removed user': () => ({
        username: fresh('rt').username,
        email: removed.email,
      }),
      'username held by a removed user': () => ({
        username: removed.username,
        email: fresh('rt').email,
      }),
    };
    const entryPoints = {
      service: (body: Record<string, unknown>, correlationId: string) => {
        const dto = { ...body, documentRefs: [] } as unknown as SubmitRegistrationDto;
        return asAnonymousRequest(() => service.submitRegistration(dto), correlationId);
      },
      http: async (body: Record<string, unknown>, correlationId: string) => {
        expect((await api.register(body, correlationId)).status).toBe(202);
      },
    };
    const intakeInsert = {
      operation: '$executeRaw',
      statement:
        'INSERT INTO registration_intake (id, submission, actor_type, actor_id, correlation_id) ' +
        'VALUES (?, ?::jsonb, ?, ?, ?)',
      shape: ['string', 'string', 'string', 'null', 'string'],
    };

    const work = observeDatabaseWork(harness.prisma);
    try {
      for (const [entryPoint, submit] of Object.entries(entryPoints)) {
        for (const [held, identity] of Object.entries(identities)) {
          const { username, email } = identity();
          const asked = await work.during((correlationId) =>
            submit(registrationBody(username, email, org.a), correlationId),
          );
          // One expectation per case, so a failure names the entry point and the case.
          expect({ entryPoint, held, asked }).toEqual({ entryPoint, held, asked: [intakeInsert] });
        }
      }
    } finally {
      work.stop();
    }
    await processRegistrations(harness);
  });

  /**
   * The other half of the same argument: the insert above is the same
   * statement, but the database could still treat it differently if the table
   * looked something up for it — a unique index or exclusion constraint on what
   * the submission holds, a foreign key into `user`, a trigger, a rule, a row
   * security policy. The table has none; this fails if one is added, with the
   * catalogue as it is in the message.
   */
  it('the intake table has no unique index, foreign key, exclusion constraint, trigger, rule or row security that could depend on who holds what', async () => {
    const catalogue = await runUnscoped(
      'test reads the intake table definition',
      () =>
        harness.prisma.client.$queryRaw<Array<{ kind: string; name: string; detail: string }>>`
        SELECT 'index' AS kind, c.relname AS name,
               CASE WHEN i.indisunique THEN 'unique' ELSE 'plain' END AS detail
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'registration_intake'::regclass
        UNION ALL
        SELECT 'constraint', conname::text,
               CASE contype WHEN 'p' THEN 'primary key' WHEN 'c' THEN 'check'
                            WHEN 'f' THEN 'foreign key' WHEN 'u' THEN 'unique'
                            WHEN 'x' THEN 'exclusion' ELSE contype::text END
          FROM pg_constraint WHERE conrelid = 'registration_intake'::regclass
        UNION ALL
        SELECT 'trigger', tgname::text, 'trigger'
          FROM pg_trigger WHERE tgrelid = 'registration_intake'::regclass AND NOT tgisinternal
        UNION ALL
        SELECT 'rule', rulename::text, 'rule'
          FROM pg_rules WHERE tablename = 'registration_intake'
        UNION ALL
        SELECT 'row security', polname::text, 'policy'
          FROM pg_policy WHERE polrelid = 'registration_intake'::regclass
        UNION ALL
        SELECT 'row security', relname::text, 'enabled'
          FROM pg_class WHERE oid = 'registration_intake'::regclass AND relrowsecurity
         ORDER BY 1, 2`,
    );

    // The query sees the table (not vacuous): its key and its two CHECKs are there.
    expect(catalogue).toEqual(
      expect.arrayContaining([
        { kind: 'constraint', name: 'registration_intake_pkey', detail: 'primary key' },
        { kind: 'constraint', name: 'ck_registration_intake_actor', detail: 'check' },
      ]),
    );
    const lookups = catalogue.filter((row) =>
      row.kind === 'index'
        ? row.detail === 'unique' && row.name !== 'registration_intake_pkey'
        : row.kind === 'constraint'
          ? ['unique', 'foreign key', 'exclusion'].includes(row.detail)
          : true,
    );
    expect(lookups).toEqual([]);
  });

  /**
   * The one wall-clock check left, and what it is for. The two tests above
   * prove the work in the database is the same; neither would see a delay in
   * the process itself that only a held identity gets (a sleep, a padding
   * routine pointed the wrong way, a hash computed for one and not the other),
   * because that is not a database operation. So this measures the time to the
   * answer at the service, fresh and held interleaved, and asserts only that
   * the medians do not differ by 50 ms.
   *
   * Why that bound and not a ratio: the answer takes a few milliseconds, so a
   * ratio of two medians is dominated by scheduling noise on a loaded runner
   * (1.48, with the product unchanged, in main CI 41028991378 attempt 1)
   * while the difference of two medians of 20 interleaved pairs is
   * milliseconds: in 30 runs with eight busy loops added to a host at load
   * average 30–60 on 8 cores, the largest difference was 2.2 ms. It takes a
   * systematic delay on more than half of the held answers to move a median at
   * all. 50 ms is twenty times that noise and below any delay a person would add
   * on purpose. It is not a precision claim: a gap of a few milliseconds is
   * not caught here, and cannot be by any clock on a shared runner; the exact
   * statement is the two tests above.
   */
  it('the time to the answer does not say whether the identity is held: no in-process delay for one — medians of 20 interleaved pairs within 50 ms', async () => {
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
    const timed = async (identity: { username: string; email: string }) => {
      const dto = {
        ...registrationBody(identity.username, identity.email, org.a),
        documentRefs: [],
      } as unknown as SubmitRegistrationDto;
      const started = performance.now();
      await asAnonymousRequest(() => service.submitRegistration(dto));
      return performance.now() - started;
    };
    const held = (round: number) =>
      round % 4 < 2
        ? { username: fresh('rt').username, email: holder.email }
        : { username: holder.username, email: fresh('rt').email };
    const ROUNDS = 20;
    const WARM_UP = 4;
    const freshTimes: number[] = [];
    const heldTimes: number[] = [];
    for (let round = 0; round < ROUNDS + WARM_UP; round += 1) {
      // Alternating which goes first, so drift and warm-up fall on both alike.
      const order = round % 2 === 0 ? (['fresh', 'held'] as const) : (['held', 'fresh'] as const);
      const took: Record<'fresh' | 'held', number> = { fresh: 0, held: 0 };
      for (const kind of order)
        took[kind] = await timed(kind === 'fresh' ? fresh('rt') : held(round));
      if (round < WARM_UP) continue;
      freshTimes.push(took.fresh);
      heldTimes.push(took.held);
    }
    await processRegistrations(harness);

    const gap = median(heldTimes) - median(freshTimes);
    // eslint-disable-next-line no-console
    console.info(
      `registration acknowledgement at the service, median of ${ROUNDS} interleaved pairs: ` +
        `fresh ${median(freshTimes).toFixed(2)} ms, held ${median(heldTimes).toFixed(2)} ms, ` +
        `held minus fresh ${gap.toFixed(2)} ms`,
    );
    expect(Math.abs(gap)).toBeLessThan(50);
  });
});
