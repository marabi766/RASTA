import { Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { startIdentityApi, type IdentityApiHarness } from './api-helpers';
import { observeDatabase, pauseBackgroundWorkers } from './database-counters';
import {
  asAnonymousRequest,
  http,
  observeDatabaseWork,
  processRegistrations,
  registrationBody,
  seedPerson,
} from './identity-fixtures';
import { id, tenants } from './helpers';
import { readTableCatalogue } from './table-catalogue';
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
    // Listening once, as a gateway reaches it: a request that also binds and
    // closes a server of its own would put that into every time measured.
    await harness.app.listen(0, '127.0.0.1');
    // The service's own timers read its tables on their own schedule; the
    // time and table-access measurements below need them off.
    await pauseBackgroundWorkers(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  const fresh = (tag = 'ra') => {
    const username = `${tag}-${id('U').slice(-12)}`.toLowerCase();
    return { username, email: `${username}@example.test` };
  };
  /**
   * Everything about an answer a client can see: status, body and EVERY header.
   * The headers that differ for every request by design are named here and
   * compared by presence only — a header on one answer and not on the other
   * (a cookie, a custom header, a different `etag`, `content-length`, `connection`
   * or `x-powered-by`) is a difference, and so is a name not in this list whose
   * value differs.
   */
  const VARYING_HEADERS = ['date', 'x-correlation-id', 'x-request-id'];
  const visible = (response: {
    status: number;
    text: string;
    headers: Record<string, string | string[] | undefined>;
  }) => ({
    status: response.status,
    body: response.text,
    headers: Object.fromEntries(
      Object.entries(response.headers)
        .map(([name, value]) => [
          name.toLowerCase(),
          VARYING_HEADERS.includes(name.toLowerCase()) ? '<varies>' : value,
        ])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
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

  /** The five ways an identity can be held or not, each as a fresh submission's username and email. */
  const identityCases = async (org: { a: string }, tag: string) => {
    const holder = await seedPerson(harness.prisma, `RA-${tag}`, {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    const removed = await seedPerson(harness.prisma, `RA-${tag}DEL`, {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });
    await runUnscoped('test removes the user', () =>
      harness.prisma.client.user.update({
        where: { id: removed.userId },
        data: { deletedAt: new Date() },
      }),
    );
    return {
      fresh: () => fresh('rt'),
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
  };
  type Answer = Parameters<typeof visible>[0];
  /** The two ways in: the service call, and the HTTP route with its whole Nest pipeline. */
  const entryPoints = (org: { a: string }) => {
    const service = harness.moduleRef.get(IdentityService);
    return {
      service: async (identity: { username: string; email: string }, correlationId = ulid()) => {
        const dto = {
          ...registrationBody(identity.username, identity.email, org.a),
          documentRefs: [],
        } as unknown as SubmitRegistrationDto;
        await asAnonymousRequest(() => service.submitRegistration(dto), correlationId);
        return undefined;
      },
      http: async (
        identity: { username: string; email: string },
        correlationId = ulid(),
      ): Promise<Answer | undefined> => {
        const answer = await api.register(
          registrationBody(identity.username, identity.email, org.a),
          correlationId,
        );
        expect(answer.status).toBe(202);
        return answer;
      },
    };
  };

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
   * run, not on one in several. This is the precise layer. It sees what goes
   * through the service's client, and only that: a read through a client kept
   * from before the probe, or through a pool of the code's own, is for the
   * database-side count in the next test. The answers' headers are compared too.
   */
  it('every valid submission asks the database for exactly the same thing before its answer — fresh or held, at the service and over HTTP', async () => {
    const org = tenants();
    const identities = await identityCases(org, 'ASK');
    const intakeInsert = {
      operation: '$executeRaw',
      statement:
        'INSERT INTO registration_intake (id, submission, actor_type, actor_id, correlation_id) ' +
        'VALUES (?, ?::jsonb, ?, ?, ?)',
      shape: ['string', 'string', 'string', 'null', 'string'],
    };

    const work = observeDatabaseWork(harness.prisma);
    try {
      for (const [entryPoint, submit] of Object.entries(entryPoints(org))) {
        const answers: Record<string, ReturnType<typeof visible> | undefined> = {};
        for (const [held, identity] of Object.entries(identities)) {
          let answer: Answer | undefined;
          const asked = await work.during(async (correlationId) => {
            answer = await submit(identity(), correlationId);
          });
          // One expectation per case, so a failure names the entry point and the case.
          expect({ entryPoint, held, asked }).toEqual({ entryPoint, held, asked: [intakeInsert] });
          answers[held] = answer && visible(answer);
        }
        // Over HTTP: every held case answers what the fresh one does, status, body and every header.
        for (const [held, answer] of Object.entries(answers)) {
          expect({ entryPoint, held, answer }).toEqual({
            entryPoint,
            held,
            answer: answers.fresh,
          });
        }
      }
    } finally {
      work.stop();
    }
    await processRegistrations(harness);
  });

  /**
   * The same property where it cannot be bypassed. PostgreSQL counts what every
   * backend does to every table — scans, index scans, tuples read, inserted,
   * updated, deleted (`pg_stat_user_tables`) — whatever client, pool or
   * connection made the request, so this reads the counters of every table of
   * the schema before and after a run of submissions (every case, both entry
   * points, three rounds), through a pool of the test's own, with the service's
   * timers stopped and every backend idle long enough for its counters to have
   * been sent (`database-counters.ts`). Exactly one thing may have moved: the
   * intake table's inserts, one per submission. A read of `"user"` (or of any
   * other table) from the path — through the service's client or one saved
   * before the probe above was installed, through a pool of another name, from
   * a trigger or a function a CHECK calls — moves that table's counters.
   * Non-vacuous: a deliberate read of `"user"` in the same way moves them.
   */
  it('counted by PostgreSQL for every client: a submission, held or fresh, touches no table but the intake', async () => {
    const org = tenants();
    const identities = await identityCases(org, 'COUNT');
    const ways = entryPoints(org);
    const ROUNDS = 3;
    const observer = await observeDatabase();
    try {
      const before = await observer.activity();
      let submissions = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const submit of Object.values(ways)) {
          for (const identity of Object.values(identities)) {
            await submit(identity());
            submissions += 1;
          }
        }
      }
      const afterSubmissions = await observer.activity();

      const idle = { seq_scan: 0, seq_tup_read: 0, idx_scan: 0, idx_tup_fetch: 0 };
      expect(observer.moved(before, afterSubmissions)).toEqual({
        registration_intake: {
          ...idle,
          n_tup_ins: submissions,
          n_tup_upd: 0,
          n_tup_del: 0,
          n_tup_hot_upd: 0,
        },
      });

      // Non-vacuous: a read of the user table does move its counters, as read here.
      await observer.control('user');
      const read = observer.moved(afterSubmissions, await observer.activity()).user;
      expect((read?.seq_scan ?? 0) + (read?.idx_scan ?? 0)).toBeGreaterThan(0);
    } finally {
      await observer.stop();
    }
    await processRegistrations(harness);
  }, 180_000);

  /**
   * The other half of the same argument: the insert above is the same
   * statement, but the database could still treat it differently if the table
   * had something to run for it — a unique index or exclusion constraint on
   * what the submission holds, a foreign key into `user`, a CHECK or a default
   * that calls a function (and the function reads whatever it likes), a
   * generated column, an expression index, a trigger, a rule, a row security
   * policy, a child table or a partition. So the table is compared, whole, to
   * the schema approved for it: relation kind, columns with their defaults,
   * every constraint and index by its definition, every trigger, rule and
   * policy, and every object these depend on beyond the table itself. Anything
   * not in the approved document fails, whatever kind it is; changing the
   * table on purpose means changing the document, in review, where it is read.
   */
  const APPROVED_INTAKE_TABLE = {
    relation: {
      kind: 'r',
      persistence: 'p',
      isPartition: false,
      isPartitioned: false,
      parents: 0,
      children: 0,
      hasSubclass: false,
      ofType: false,
      options: null,
      accessMethod: 'heap',
      rowSecurity: false,
      forcedRowSecurity: false,
      publications: 0,
    },
    columns: [
      { name: 'id', type: 'character varying(64)', notNull: true, default: null },
      { name: 'submission', type: 'jsonb', notNull: true, default: null },
      {
        name: 'received_at',
        type: 'timestamp(3) without time zone',
        notNull: true,
        default: 'CURRENT_TIMESTAMP',
      },
      { name: 'attempts', type: 'integer', notNull: true, default: '0' },
      {
        name: 'next_attempt_at',
        type: 'timestamp(3) without time zone',
        notNull: true,
        default: 'CURRENT_TIMESTAMP',
      },
      { name: 'actor_type', type: 'character varying(16)', notNull: true, default: null },
      { name: 'actor_id', type: 'character varying(256)', notNull: false, default: null },
      { name: 'correlation_id', type: 'character varying(128)', notNull: true, default: null },
    ].map((column) => ({ ...column, generated: '', identity: '' })),
    constraints: [
      {
        name: 'ck_registration_intake_actor',
        definition:
          "CHECK (\nCASE\n    WHEN ((actor_type)::text = 'ANONYMOUS'::text) THEN (actor_id IS NULL)\n" +
          "    WHEN ((actor_type)::text = ANY ((ARRAY['USER'::character varying, 'SERVICE'::character varying])::text[])) " +
          "THEN ((actor_id IS NOT NULL) AND ((actor_id)::text ~ '^[!-~]+$'::text))\n    ELSE false\nEND)",
      },
      {
        name: 'ck_registration_intake_correlation',
        definition: "CHECK (((correlation_id)::text ~ '^[A-Za-z0-9_.:-]{1,128}$'::text))",
      },
      { name: 'registration_intake_pkey', definition: 'PRIMARY KEY (id)' },
    ],
    indexes: [
      {
        definition:
          'CREATE INDEX ix_registration_intake_due ON public.registration_intake USING btree (next_attempt_at, id)',
        valid: true,
      },
      {
        definition:
          'CREATE UNIQUE INDEX registration_intake_pkey ON public.registration_intake USING btree (id)',
        valid: true,
      },
    ],
    triggers: [],
    rules: [],
    policies: [],
    dependencies: [
      {
        object: 'index registration_intake_pkey',
        dependsOn: 'constraint registration_intake_pkey on table registration_intake',
        type: 'i',
      },
      { object: 'table registration_intake', dependsOn: 'schema public', type: 'n' },
    ],
  };

  it('the intake table is exactly the approved one: nothing in it can run, look up or constrain by who holds what', async () => {
    const catalogue = await readTableCatalogue(harness.prisma, 'registration_intake');

    expect(catalogue).toEqual(APPROVED_INTAKE_TABLE);
    // The same, said as the property: the table depends on nothing of the user's making.
    expect(
      catalogue.dependencies.filter(
        (dependency) => !/^(constraint|schema) /.test(dependency.dependsOn),
      ),
    ).toEqual([]);
  });

  /**
   * What the three tests above cannot see: a delay in the process itself that
   * only some identities get (a sleep, a padding routine pointed the wrong way,
   * a hash computed for one and not the other, a call to something outside
   * the database) is no database operation. So the time to the answer is
   * measured too, and per case: for each entry point (service; HTTP, with the
   * pipeline) and each of the four held cases (email held; username held;
   * email, and username, held by a removed user) 30 interleaved pairs of a
   * fresh and a held submission after 5 warm-up pairs, the order of each pair
   * alternating. Each case has its own fresh baseline and its own verdict, so a
   * delay on one of them is not diluted by the others, nor a delay at HTTP by
   * the service.
   *
   * The bound is on the difference of the two medians: less than the larger of
   * 5 ms and a quarter of the fresh median. A ratio is not used: the answer
   * takes a few milliseconds, and the ratio of two such medians moved to 1.48
   * on a loaded runner with the product unchanged (main CI 41028991378). The
   * difference of the medians of 30 pairs never exceeded 2.2 ms in any of the
   * eight cases: 30 runs beside eight busy loops (load average 5–12) and 24
   * beside thirty-two (load average 20–36), 432 cells, 0 over the bound.
   * The floor is 5 ms because the old ratio's own false failure (1.48 of a
   * 3 ms answer) was a gap of under 2 ms, so no bound below that holds on a
   * shared runner; a gap that small is for the exact statements above. A
   * delay on only some of the held answers moves a median by little, so each
   * case is measured with all of its held answers delayed, as a mechanism
   * that decides by identity would.
   */
  it('the time to the answer does not say whether the identity is held, for each case at the service and over HTTP: medians of 30 interleaved pairs within max(5 ms, 25 % of fresh)', async () => {
    const org = tenants();
    const identities = await identityCases(org, 'TIME');
    const ROUNDS = 30;
    const WARM_UP = 5;
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const { fresh: newIdentity, ...heldCases } = identities;

    const results: Array<{
      entryPoint: string;
      held: string;
      fresh: number;
      heldMedian: number;
      gap: number;
      bound: number;
    }> = [];
    for (const [entryPoint, submit] of Object.entries(entryPoints(org))) {
      for (const [held, heldIdentity] of Object.entries(heldCases)) {
        const times: Record<'fresh' | 'held', number[]> = { fresh: [], held: [] };
        for (let round = 0; round < ROUNDS + WARM_UP; round += 1) {
          // Alternating which goes first, so drift and warm-up fall on both alike.
          const order =
            round % 2 === 0 ? (['fresh', 'held'] as const) : (['held', 'fresh'] as const);
          const took: Record<'fresh' | 'held', number> = { fresh: 0, held: 0 };
          for (const kind of order) {
            const identity = kind === 'fresh' ? newIdentity() : heldIdentity();
            const started = performance.now();
            await submit(identity);
            took[kind] = performance.now() - started;
          }
          if (round < WARM_UP) continue;
          times.fresh.push(took.fresh);
          times.held.push(took.held);
        }
        const fresh = median(times.fresh);
        const heldMedian = median(times.held);
        results.push({
          entryPoint,
          held,
          fresh,
          heldMedian,
          gap: heldMedian - fresh,
          bound: Math.max(5, 0.25 * fresh),
        });
      }
    }
    // Nothing of this is worth processing: 480 submissions, 240 of them fresh.
    await runUnscoped(
      'test discards the timing submissions',
      () =>
        harness.prisma.client.$executeRaw`
        DELETE FROM registration_intake WHERE submission->>'requestedOrganizationId' = ${org.a}`,
    );

    // eslint-disable-next-line no-console
    console.info(
      'registration acknowledgement, median of 30 interleaved pairs, held minus fresh (ms):\n' +
        results
          .map(
            (r) =>
              `  ${r.entryPoint.padEnd(7)} ${r.held.padEnd(34)} fresh ${r.fresh.toFixed(2)} ` +
              `held ${r.heldMedian.toFixed(2)} gap ${r.gap.toFixed(2)} (bound ${r.bound.toFixed(2)})`,
          )
          .join('\n'),
    );
    expect(
      results.filter((r) => Math.abs(r.gap) >= r.bound).map((r) => `${r.entryPoint}: ${r.held}`),
    ).toEqual([]);
  }, 120_000);
});
