import request from 'supertest';
import { ulid } from 'ulid';
import { getContext, runUnscoped } from '@rasta/nest-common';
import { setEligibilityFixture } from '@rasta/testing';
import { IdentityRepository } from '../src/identity/identity.repository';
import { provenanceOnly } from '../src/keycloak/platform-attributes';
import { startIdentityApi, type IdentityApiHarness } from './api-helpers';
import { bearerOf, eventNames, http, seedPerson, type Person } from './identity-fixtures';
import { id, tenants } from './helpers';
import { KeycloakHttpStub, SUCCESS_REQUEST_BUDGET_MS } from './keycloak-http-stub';

/**
 * A direct provisioning that failed after Keycloak made its account is
 * finished by the same request again (task 117, audit F6).
 *
 * `POST /v1/users` creates a disabled Keycloak account, then commits the user.
 * When that transaction failed, a retry used to mint a new user id and get
 * Keycloak's 409 for the username — every time after. Now the request is
 * recorded first, as an intent carrying the user id the account is made with
 * (`provisioning-intent.ts`); the same actor, key, acting organization and
 * body adopt that account, and nobody else's. The real `AppModule` over HTTP,
 * the real PostgreSQL, Keycloak's Admin API stubbed over a real socket.
 */
describe('a failed provisioning is finished by the same request again (task 117, F6)', () => {
  let harness: IdentityApiHarness;
  let stub: KeycloakHttpStub;
  let api: ReturnType<typeof http>;
  let repository: IdentityRepository;

  beforeAll(async () => {
    stub = new KeycloakHttpStub();
    await stub.start();
    harness = await startIdentityApi({
      keycloak: { url: stub.url, requestTimeoutMs: SUCCESS_REQUEST_BUDGET_MS },
    });
    api = http(harness);
    repository = harness.moduleRef.get(IdentityRepository);
  });

  afterAll(async () => {
    await harness?.close();
    await stub?.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    stub.onPut = null;
  });

  async function setUp() {
    const org = tenants();
    const admin = await seedPerson(harness.prisma, 'PI-ADM', {
      organizationId: org.a,
      roles: ['ORGANIZATION_ADMIN'],
    });
    const username = `pi-${id('U').slice(-12)}`.toLowerCase();
    const body = {
      username,
      email: `${username}@example.test`,
      firstName: 'آزمون',
      lastName: 'تأمین',
      organizationId: org.a,
      roles: ['OPERATOR'],
    };
    return { org, admin, bearer: bearerOf(admin, ['ORGANIZATION_ADMIN']), username, body };
  }
  const accountsOf = (username: string) =>
    [...stub.accounts.values()].filter((account) => account.username === username);
  const createsOf = (username: string) =>
    stub.requests.filter((r) => r.method === 'POST' && r.body?.username === username);
  const intentOf = (admin: Person, key: string) =>
    runUnscoped('test reads the intent', () =>
      harness.prisma.client.userProvisioningIntent.findUnique({
        where: { actorId_idempotencyKey: { actorId: admin.userId, idempotencyKey: key } },
      }),
    );
  const userNamed = (username: string) =>
    runUnscoped('test reads the user', () =>
      harness.prisma.client.user.findFirst({ where: { username } }),
    );
  /** The next commit of a user fails, after Keycloak made the account. */
  const failNextCommit = () =>
    jest
      .spyOn(repository, 'enqueueEvent')
      .mockRejectedValueOnce(new Error('the database went away'));

  it('the database step fails after the account was made: the same request again adopts it — one account, disabled until the projection enables it', async () => {
    const { admin, bearer, username, body } = await setUp();
    const key = `pi-${username}`;
    failNextCommit();

    const failed = await api.createUser(bearer, key, body);

    expect(failed.status).toBe(500);
    expect(await userNamed(username)).toBeNull();
    const intent = await intentOf(admin, key);
    expect(intent).toMatchObject({ completedAt: null, responseBody: null });
    const [orphan] = accountsOf(username);
    expect(accountsOf(username)).toHaveLength(1);
    expect(orphan!.enabled).toBe(false);
    expect(orphan!.attributes).toEqual(provenanceOnly(intent!.userId));

    // At each PUT: whether the user had committed by then.
    const seenAtPut: string[] = [];
    stub.onPut = async (put) => {
      const user = await userNamed(username);
      seenAtPut.push(
        `${put.body && 'enabled' in put.body ? 'enable' : 'attributes'}:committed=${user !== null}`,
      );
    };
    const retried = await api.createUser(bearer, key, body);

    expect(retried.status).toBe(201);
    expect(retried.body.id).toBe(intent!.userId);
    expect(createsOf(username)).toHaveLength(2);
    expect(accountsOf(username)).toHaveLength(1);
    expect((await userNamed(username))?.keycloakId).toBe(orphan!.id);
    // Adopted disabled; the normal path wrote its grants and enabled it, after commit.
    expect(seenAtPut).toEqual(['attributes:committed=true', 'enable:committed=true']);
    expect(accountsOf(username)[0]!.enabled).toBe(true);
    expect(accountsOf(username)[0]!.attributes.rasta_activation).toEqual([intent!.userId]);
    expect(await eventNames(harness.prisma, intent!.userId)).toEqual(['USER_ACTIVATED']);
    expect((await intentOf(admin, key))?.completedAt).not.toBeNull();
  });

  it('the answer to a committed request was lost: the same request again replays it, byte for byte, and makes nothing', async () => {
    const { bearer, username, body } = await setUp();
    const key = `pi-${username}`;

    const first = await api.createUser(bearer, key, body);
    const again = await api.createUser(bearer, key, body);

    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.text).toBe(first.text);
    expect(createsOf(username)).toHaveLength(1);
    expect(await eventNames(harness.prisma, first.body.id)).toEqual(['USER_ACTIVATED']);
  });

  it('three sends of one request at once: one user, one account, one answer', async () => {
    const { bearer, username, body } = await setUp();
    const key = `pi-${username}`;

    const answers = await Promise.all([1, 2, 3].map(() => api.createUser(bearer, key, body)));

    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201]);
    expect(new Set(answers.map((answer) => answer.body.id)).size).toBe(1);
    expect(accountsOf(username)).toHaveLength(1);
    expect(await eventNames(harness.prisma, answers[0]!.body.id)).toEqual(['USER_ACTIVATED']);
  });

  it.each([
    ['another body', (body: Record<string, unknown>) => ({ ...body, lastName: 'دیگر' })],
    ['other roles', (body: Record<string, unknown>) => ({ ...body, roles: ['DRIVER'] })],
  ])(
    'the same key with %s: 409 IDEMPOTENCY_KEY_REUSED, before and after the first finished — nothing adopted',
    async (_label, change) => {
      const { bearer, username, body } = await setUp();
      const key = `pi-${username}`;
      failNextCommit();
      expect((await api.createUser(bearer, key, body)).status).toBe(500);

      const whilePending = await api.createUser(bearer, key, change(body));
      expect([whilePending.status, whilePending.body.code]).toEqual([
        409,
        'IDEMPOTENCY_KEY_REUSED',
      ]);
      expect(await userNamed(username)).toBeNull();

      expect((await api.createUser(bearer, key, body)).status).toBe(201);
      const afterwards = await api.createUser(bearer, key, change(body));
      expect([afterwards.status, afterwards.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      expect(createsOf(username)).toHaveLength(2);
    },
  );

  it('the same key and body, acting for another organization: 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { org, body, username } = await setUp();
    const operator = { userId: id('USR-PI-SYS') };
    const key = `pi-${username}`;

    const first = await api.createUser(
      bearerOf({ ...operator, organizationId: org.a }, ['SYSTEM_ADMIN']),
      key,
      body,
    );
    const elsewhere = await api.createUser(
      bearerOf({ ...operator, organizationId: org.b }, ['SYSTEM_ADMIN']),
      key,
      body,
    );

    expect(first.status).toBe(201);
    expect([elsewhere.status, elsewhere.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('another administrator’s request for the username never adopts the account: 409, and the first request still finishes', async () => {
    const { org, admin, bearer, username, body } = await setUp();
    const other = await seedPerson(harness.prisma, 'PI-OTHER', {
      organizationId: org.a,
      roles: ['ORGANIZATION_ADMIN'],
    });
    failNextCommit();
    expect((await api.createUser(bearer, `pi-${username}`, body)).status).toBe(500);

    // The same body, another actor: a different request, whose intent names another user.
    const theirs = await api.createUser(
      bearerOf(other, ['ORGANIZATION_ADMIN']),
      `pi-${username}`,
      body,
    );

    expect([theirs.status, theirs.body.code]).toEqual([409, 'ALREADY_EXISTS']);
    expect(await userNamed(username)).toBeNull();
    const ours = await api.createUser(bearer, `pi-${username}`, body);
    expect(ours.status).toBe(201);
    expect(ours.body.id).toBe((await intentOf(admin, `pi-${username}`))!.userId);
    expect(accountsOf(username)).toHaveLength(1);
  });

  it('an account under the username that no request of ours made: 409 ALREADY_EXISTS, untouched', async () => {
    const { bearer, username, body } = await setUp();
    stub.add({
      id: `kc-foreign-${id('K').slice(-8).toLowerCase()}`,
      username,
      email: body.email,
      firstName: 'دیگر',
      lastName: 'کس',
      enabled: false,
      attributes: provenanceOnly('USR_SOMEBODY_ELSE'),
    });

    const response = await api.createUser(bearer, `pi-${username}`, body);

    expect([response.status, response.body.code]).toEqual([409, 'ALREADY_EXISTS']);
    expect(await userNamed(username)).toBeNull();
    expect(accountsOf(username)[0]!.attributes).toEqual(provenanceOnly('USR_SOMEBODY_ELSE'));
    expect(stub.puts(accountsOf(username)[0]!.id)).toEqual([]);
  });

  it('its own account, enabled outside the platform since: not adopted — 409 ACCOUNT_NOT_HARMLESS, nothing committed', async () => {
    const { bearer, username, body } = await setUp();
    failNextCommit();
    expect((await api.createUser(bearer, `pi-${username}`, body)).status).toBe(500);
    accountsOf(username)[0]!.enabled = true;

    const response = await api.createUser(bearer, `pi-${username}`, body);

    expect(response.status).toBe(409);
    expect(response.body.details?.[0]?.code).toBe('ACCOUNT_NOT_HARMLESS');
    expect(await userNamed(username)).toBeNull();
    expect(stub.puts(accountsOf(username)[0]!.id)).toEqual([]);
  });

  it('without an Idempotency-Key: 400, before Keycloak is asked anything', async () => {
    const { bearer, username, body } = await setUp();

    const response = await api.createUser(bearer, null, body);

    expect([response.status, response.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(createsOf(username)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Task 130, PR #483 r1 R3 and R4: the order of two sends, forced
  // -------------------------------------------------------------------------

  /** A send of `POST /v1/users` this suite can single out: by its correlation id. */
  const tagged = (bearer: string, key: string, body: Record<string, unknown>, tag: string) =>
    request(harness.app.getHttpServer())
      .post('/v1/users')
      .set('authorization', bearer)
      .set('idempotency-key', key)
      .set('x-correlation-id', tag)
      .send(body);

  /**
   * Holds the send tagged `tag` right after its `after`-th transaction has
   * committed, until released — the injected point an interleaving needs. A
   * barrier, not a race: the other send runs to the end while this one waits.
   */
  function holdAfterCommit(tag: string, after: number) {
    let reached!: () => void;
    let release!: () => void;
    const atBarrier = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const original = repository.transaction.bind(repository);
    let committed = 0;
    jest.spyOn(repository, 'transaction').mockImplementation((async (
      work: never,
      options: never,
    ) => {
      const result = await original(work, options);
      if (getContext().correlationId === tag && ++committed === after) {
        reached();
        await released;
      }
      return result;
    }) as never);
    return { atBarrier, release };
  }

  const usersNamed = (username: string) =>
    runUnscoped('test counts the users', () =>
      harness.prisma.client.user.count({ where: { username } }),
    );

  it('R3, the reviewer’s schedule: B reads the intent open, A finishes, then B — B replays A’s answer, never 409', async () => {
    const { bearer, username, body } = await setUp();
    const key = `pi-${username}`;
    const tag = ulid();
    // B's first transaction committed the intent (open); B stops there.
    const hold = holdAfterCommit(tag, 1);

    const b = tagged(bearer, key, body, tag).then((response) => response);
    await hold.atBarrier;
    const a = await api.createUser(bearer, key, body);
    hold.release();
    const bAnswer = await b;

    expect(a.status).toBe(201);
    expect([bAnswer.status, bAnswer.text]).toEqual([201, a.text]);
    expect(await usersNamed(username)).toBe(1);
    expect(accountsOf(username)).toHaveLength(1);
    expect(createsOf(username)).toHaveLength(1);
    expect(await eventNames(harness.prisma, a.body.id)).toEqual(['USER_ACTIVATED']);
  });

  it('R3, later: B reconciled the intent open and is about to ask Keycloak, A finishes — B still replays, under the lock', async () => {
    const { bearer, username, body } = await setUp();
    const key = `pi-${username}`;
    const tag = ulid();
    // B's second transaction (the reconciliation) committed; B stops before Keycloak.
    const hold = holdAfterCommit(tag, 2);

    const b = tagged(bearer, key, body, tag).then((response) => response);
    await hold.atBarrier;
    const a = await api.createUser(bearer, key, body);
    hold.release();
    const bAnswer = await b;

    expect(a.status).toBe(201);
    expect([bAnswer.status, bAnswer.text]).toEqual([201, a.text]);
    expect(await usersNamed(username)).toBe(1);
    // B's create met A's account (409 from Keycloak) and adopted nothing.
    expect(accountsOf(username)).toHaveLength(1);
    expect(await eventNames(harness.prisma, a.body.id)).toEqual(['USER_ACTIVATED']);
  });

  /** The provisioned person's membership, moved on as `data` says. */
  const moveMembership = (userId: string, data: Record<string, unknown>) =>
    runUnscoped('test moves the provisioned membership on', () =>
      harness.prisma.client.membership.updateMany({ where: { userId }, data }),
    );
  /** The provisioned person's membership, ended a minute ago by the database clock. */
  const endMembership = async (userId: string) => {
    const rows = await runUnscoped('test reads the provisioned membership', () =>
      harness.prisma.client.membership.findMany({ where: { userId }, select: { id: true } }),
    );
    await runUnscoped('test ends the provisioned membership', () =>
      setEligibilityFixture(
        harness.prisma,
        'membershipEndedMinuteAgo',
        rows.map((row) => row.id),
      ),
    );
  };
  /** Nothing of the stored answer — no id, username or email of the person — in a refusal. */
  const expectNoUserView = (
    response: { status: number; text: string; body: { code?: string } },
    made: { id: string; username: string; email: string },
  ) => {
    expect([response.status, response.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    for (const value of [made.id, made.username, made.email]) {
      expect(response.text).not.toContain(value);
    }
  };

  it.each<[string, Record<string, unknown> | 'ended a minute ago']>([
    ['revoked', { status: 'REVOKED', deletedAt: new Date() }],
    // By the database clock that judges it, never this process's.
    ['expired', 'ended a minute ago'],
    ['suspended', { status: 'SUSPENDED' }],
  ])(
    'R4: the person’s membership %s since — GET /v1/users/:id says 404, and the replay returns no UserView: 409, nothing stored in it',
    async (_label, change) => {
      const { bearer, username, body } = await setUp();
      const key = `pi-${username}`;
      const first = await api.createUser(bearer, key, body);
      expect(first.status).toBe(201);
      // The control: while the membership is live, the replay answers.
      expect((await api.createUser(bearer, key, body)).text).toBe(first.text);

      if (change === 'ended a minute ago') await endMembership(first.body.id);
      else await moveMembership(first.body.id, change);

      expect((await api.getUser(bearer, first.body.id)).status).toBe(404);
      expectNoUserView(await api.createUser(bearer, key, body), first.body);
    },
  );

  it('R4 at the second replay: B past the reconciliation, A finishes, the person’s membership revoked — B gets no UserView either', async () => {
    const { bearer, username, body } = await setUp();
    const key = `pi-${username}`;
    const tag = ulid();
    const hold = holdAfterCommit(tag, 2);

    const b = tagged(bearer, key, body, tag).then((response) => response);
    await hold.atBarrier;
    const a = await api.createUser(bearer, key, body);
    expect(a.status).toBe(201);
    await moveMembership(a.body.id, { status: 'REVOKED', deletedAt: new Date() });
    hold.release();

    expectNoUserView(await b, a.body);
  });

  it('R4: demoted while the retry waits past its first transaction — the replay boundary itself refuses, 403, nothing stored in it', async () => {
    const { admin, bearer, username, body } = await setUp();
    const key = `pi-${username}`;
    const tag = ulid();
    // B passed the intent's own authorization (its first transaction) and waits.
    const hold = holdAfterCommit(tag, 1);

    const b = tagged(bearer, key, body, tag).then((response) => response);
    await hold.atBarrier;
    const a = await api.createUser(bearer, key, body);
    expect(a.status).toBe(201);
    await runUnscoped('test demotes the administrator', () =>
      harness.prisma.client.membership.update({
        where: { id: admin.membershipId },
        data: { roles: ['OPERATOR'] },
      }),
    );
    hold.release();
    const bAnswer = await b;

    expect([bAnswer.status, bAnswer.body.code]).toEqual([403, 'INSUFFICIENT_ROLE']);
    expect(bAnswer.text).not.toContain(a.body.id);
  });

  it('R4: the administrator demoted since — the replay is refused like any write of theirs, 403, nothing stored in it', async () => {
    const { admin, bearer, username, body } = await setUp();
    const key = `pi-${username}`;
    const first = await api.createUser(bearer, key, body);
    expect(first.status).toBe(201);
    await runUnscoped('test demotes the administrator', () =>
      harness.prisma.client.membership.update({
        where: { id: admin.membershipId },
        data: { roles: ['OPERATOR'] },
      }),
    );

    const again = await api.createUser(bearer, key, body);

    expect([again.status, again.body.code]).toEqual([403, 'INSUFFICIENT_ROLE']);
    expect(again.text).not.toContain(first.body.id);
  });
});
