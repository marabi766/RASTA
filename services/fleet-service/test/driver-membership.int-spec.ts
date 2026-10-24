import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InternalTokenService, RastaError, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { DriverService } from '../src/fleet/driver.service';
import {
  LiveMembershipClient,
  NOT_A_MEMBER,
  NOT_A_MEMBER_MESSAGE,
  type MembershipSource,
} from '../src/fleet/membership';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';
import { FakeMembershipSource } from './membership-source.fake';

/**
 * Registering a driver needs a live member of the organization (task 095),
 * against a real database.
 *
 * Before this, `DriverService.create` stored any well-formed `userId`: the
 * demo run of 2026-10-24 registered OP-115 for `USR-DEMO-DRIVER-0115`, a user
 * that does not exist. Every refusal here is checked where it matters — no
 * driver row and no `DRIVER_REGISTERED` in the outbox — not only by the error.
 *
 * Two sources: {@link FakeMembershipSource} for the service's own decisions,
 * and the real {@link LiveMembershipClient} over HTTP to a loopback stand-in
 * for identity-service that verifies the internal token and answers for the
 * organization the token is signed for, as identity's route does — so the
 * tenant a membership is asked about is the one the request acts for, and
 * every failure of the exchange refuses.
 */
describe('driver registration needs a live member of the organization (task 095)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    await cleanup(prisma, [org.a, org.b]);
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const newUser = () => `USR-ITEST-${id('M').slice(-10)}`;

  /** What a refusal must have left behind for `userId`: nothing, in either organization. */
  async function nothingWritten(userId: string): Promise<void> {
    const drivers = await runUnscoped(
      'the test looks for the row in both organizations',
      async () =>
        prisma.client.driver.count({ where: { userId, organizationId: { in: [org.a, org.b] } } }),
    );
    const events = await prisma.client.outboxMessage.count({
      where: {
        organizationId: { in: [org.a, org.b] },
        eventName: 'DRIVER_REGISTERED',
        payload: { path: ['payload', 'userId'], equals: userId },
      },
    });
    expect({ userId, drivers, events }).toEqual({ userId, drivers: 0, events: 0 });
  }

  async function registeredOnce(organizationId: string, userId: string): Promise<string> {
    const rows = await runUnscoped('the test reads what the registration wrote', async () =>
      prisma.client.driver.findMany({ where: { organizationId, userId } }),
    );
    expect(rows).toHaveLength(1);
    const events = await prisma.client.outboxMessage.findMany({
      where: {
        organizationId,
        eventName: 'DRIVER_REGISTERED',
        payload: { path: ['payload', 'userId'], equals: userId },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregateId).toBe(rows[0]!.id);
    return rows[0]!.id;
  }

  async function refusedAsNotAMember(promise: Promise<unknown>): Promise<void> {
    const error = await promise.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(RastaError);
    const refused = error as RastaError;
    expect({
      status: refused.status,
      code: refused.code,
      message: refused.message,
      details: refused.details,
    }).toEqual({
      status: 422,
      code: 'BUSINESS_RULE_VIOLATION',
      message: NOT_A_MEMBER_MESSAGE,
      details: [{ path: 'userId', message: NOT_A_MEMBER_MESSAGE, code: NOT_A_MEMBER }],
    });
  }

  const create = (service: DriverService, organizationId: string, userId: string) =>
    asActor({ organizationId }, () => service.create({ userId, employeeNo: 'OP-1' }));

  describe('the service decides on identity’s answer', () => {
    let source: FakeMembershipSource;
    let service: DriverService;

    beforeEach(() => {
      source = new FakeMembershipSource();
      service = new DriverService(repository, source);
    });

    it('registers a live member: one row, one DRIVER_REGISTERED, asked for this organization', async () => {
      const userId = newUser();
      source.admit(org.a, userId);
      const created = await create(service, org.a, userId);
      expect(created).toMatchObject({ organizationId: org.a, userId, status: 'ACTIVE' });
      expect(await registeredOnce(org.a, userId)).toBe(created.id);
      expect(source.asked).toEqual([{ organizationId: org.a, userId }]);
    });

    it('refuses a user who is a member of nobody (or does not exist): 422, nothing written', async () => {
      const userId = newUser();
      await refusedAsNotAMember(create(service, org.a, userId));
      await nothingWritten(userId);
    });

    it('refuses a member of ANOTHER organization, with the same answer (tenant isolation)', async () => {
      const userId = newUser();
      source.admit(org.b, userId);
      await refusedAsNotAMember(create(service, org.a, userId));
      await nothingWritten(userId);
      expect(source.asked).toEqual([{ organizationId: org.a, userId }]);
    });

    it('decides on the organization of THIS request, not an earlier one (organization switch)', async () => {
      // Drawn while acting for B, where the user is a member; sent after the
      // session moved to A, where they are not. Asked again, for A: refused.
      const userId = newUser();
      source.admit(org.b, userId);
      await refusedAsNotAMember(create(service, org.a, userId));
      await nothingWritten(userId);

      // And a membership that ended between the form and the send is ended.
      const leaver = newUser();
      source.admit(org.a, leaver);
      source.remove(org.a, leaver);
      await refusedAsNotAMember(create(service, org.a, leaver));
      await nothingWritten(leaver);
    });

    it('a member of both organizations is a driver of each only through its own request', async () => {
      const userId = newUser();
      source.admit(org.a, userId).admit(org.b, userId);
      const inA = await create(service, org.a, userId);
      const inB = await create(service, org.b, userId);
      expect(inA.organizationId).toBe(org.a);
      expect(inB.organizationId).toBe(org.b);
      await registeredOnce(org.a, userId);
      await registeredOnce(org.b, userId);
    });

    it('refuses when identity-service cannot answer (fail closed): 503, nothing written', async () => {
      const userId = newUser();
      source.admit(org.a, userId).down();
      const error = await create(service, org.a, userId).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).status).toBe(503);
      expect((error as RastaError).code).toBe('UPSTREAM_UNAVAILABLE');
      await nothingWritten(userId);
    });

    it('two concurrent registrations of one member: one row and one event; the other a 409 ALREADY_EXISTS', async () => {
      const userId = newUser();
      source.admit(org.a, userId);
      // Both pass the membership question before either inserts: the order
      // the unique index has to decide, not the check.
      let release!: () => void;
      const bothAsked = new Promise<void>((resolve) => (release = resolve));
      source.gate = async () => {
        if (source.asked.length >= 2) release();
        await bothAsked;
      };

      const outcomes = await Promise.allSettled([
        create(service, org.a, userId),
        create(service, org.a, userId),
      ]);
      expect(source.asked).toHaveLength(2);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(RastaError);
      expect({
        status: (rejected[0]!.reason as RastaError).status,
        code: (rejected[0]!.reason as RastaError).code,
      }).toEqual({ status: 409, code: 'ALREADY_EXISTS' });
      await registeredOnce(org.a, userId);
    });

    it('a retry after the first registration committed is the same 409, not a second row', async () => {
      const userId = newUser();
      source.admit(org.a, userId);
      await create(service, org.a, userId);
      await expect(create(service, org.a, userId)).rejects.toMatchObject({
        status: 409,
        code: 'ALREADY_EXISTS',
      });
      await registeredOnce(org.a, userId);
    });
  });

  describe('reactivating a suspended driver asks again; suspending never does', () => {
    let source: FakeMembershipSource;
    let service: DriverService;

    beforeEach(() => {
      source = new FakeMembershipSource();
      service = new DriverService(repository, source);
    });

    const statusEvents = (driverId: string) =>
      prisma.client.outboxMessage.count({
        where: { aggregateId: driverId, eventName: 'DRIVER_STATUS_CHANGED' },
      });
    const statusOf = async (driverId: string) =>
      (
        await runUnscoped('the test reads the row it changed', async () =>
          prisma.client.driver.findFirstOrThrow({ where: { id: driverId } }),
        )
      ).status;
    const change = (driverId: string, status: 'ACTIVE' | 'SUSPENDED') =>
      asActor({ organizationId: org.a }, () =>
        service.changeStatus(driverId, { status, reason: 'task 095' } as never),
      );

    async function suspendedDriverOf(userId: string): Promise<string> {
      source.admit(org.a, userId);
      const created = await create(service, org.a, userId);
      await change(created.id, 'SUSPENDED');
      return created.id;
    }

    it('reactivates the driver of a live member', async () => {
      const driverId = await suspendedDriverOf(newUser());
      await change(driverId, 'ACTIVE');
      expect(await statusOf(driverId)).toBe('ACTIVE');
      expect(await statusEvents(driverId)).toBe(2);
    });

    it('refuses to reactivate the driver of someone who is no longer a member: 422, nothing written', async () => {
      const userId = newUser();
      const driverId = await suspendedDriverOf(userId);
      source.remove(org.a, userId);
      await refusedAsNotAMember(change(driverId, 'ACTIVE'));
      expect(await statusOf(driverId)).toBe('SUSPENDED');
      expect(await statusEvents(driverId)).toBe(1);
      expect(source.asked.at(-1)).toEqual({ organizationId: org.a, userId });
    });

    it('refuses to reactivate when identity-service cannot answer (fail closed)', async () => {
      const driverId = await suspendedDriverOf(newUser());
      source.down();
      await expect(change(driverId, 'ACTIVE')).rejects.toMatchObject({
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(await statusOf(driverId)).toBe('SUSPENDED');
      expect(await statusEvents(driverId)).toBe(1);
    });

    it('suspends the driver of someone who left without asking — the manual remedy stays open', async () => {
      const userId = newUser();
      source.admit(org.a, userId);
      const created = await create(service, org.a, userId);
      source.remove(org.a, userId).down();
      const asked = source.asked.length;
      await change(created.id, 'SUSPENDED');
      expect(await statusOf(created.id)).toBe('SUSPENDED');
      expect(source.asked).toHaveLength(asked);
    });
  });

  describe('over HTTP, through the real client (identity stand-in on loopback)', () => {
    const SECRET = `itest-${'k'.repeat(40)}`;
    const tokens = new InternalTokenService(SECRET, 'rasta-internal', 60);
    /** (organization, user) pairs the stand-in holds as live memberships. */
    const live = new Set<string>();
    type Handler = (
      request: IncomingMessage,
      response: ServerResponse,
      asked: { organizationId: string; userId: string },
    ) => void;
    let behave: Handler | null = null;
    let server: Server;
    let baseUrl: string;

    /** identity's route, in miniature: the signed organization is the one answered for. */
    const honest: Handler = (_request, response, asked) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          userId: asked.userId,
          organizationId: asked.organizationId,
          live: live.has(`${asked.organizationId}\n${asked.userId}`),
          asOf: new Date().toISOString(),
        }),
      );
    };

    beforeAll(async () => {
      server = createServer((request, response) => {
        void (async () => {
          const match = /^\/v1\/users\/([^/]+)\/live-membership$/.exec(request.url ?? '');
          let claims;
          try {
            claims = await tokens.verify(
              String(request.headers['x-internal-token'] ?? ''),
              'identity-service',
            );
          } catch {
            claims = null;
          }
          if (
            !match ||
            !claims ||
            claims.callerService !== 'fleet-service' ||
            !claims.organizationId
          ) {
            response.writeHead(403).end();
            return;
          }
          const asked = {
            organizationId: claims.organizationId,
            userId: decodeURIComponent(match[1]!),
          };
          (behave ?? honest)(request, response, asked);
        })();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(() => {
      behave = null;
    });

    const service = (timeoutMs = 2_000): DriverService => {
      const source: MembershipSource = new LiveMembershipClient({ baseUrl, timeoutMs, tokens });
      return new DriverService(repository, source);
    };

    it('registers a member of this organization', async () => {
      const userId = newUser();
      live.add(`${org.a}\n${userId}`);
      await create(service(), org.a, userId);
      await registeredOnce(org.a, userId);
    });

    it('refuses a member of another organization: the token is signed for this one (tenant isolation)', async () => {
      const userId = newUser();
      live.add(`${org.b}\n${userId}`);
      await refusedAsNotAMember(create(service(), org.a, userId));
      await nothingWritten(userId);
    });

    it('refuses a user identity has never heard of, with the same answer', async () => {
      const userId = newUser();
      await refusedAsNotAMember(create(service(), org.a, userId));
      await nothingWritten(userId);
    });

    /** A well-formed "live: true" about exactly what was asked: only the status or size is wrong. */
    const liveAnswer = (asked: { organizationId: string; userId: string }) =>
      JSON.stringify({ ...asked, live: true, asOf: new Date().toISOString() });
    const withStatus =
      (status: number): Handler =>
      (_q, r, asked) => {
        r.writeHead(status, { 'content-type': 'application/json' });
        r.end(liveAnswer(asked));
      };

    const failures: [string, Handler][] = [
      ['a timeout', () => undefined],
      ['a 500 (whose body says live)', withStatus(500)],
      ['a 403 (whose body says live)', withStatus(403)],
      ['a 404 (whose body says live)', withStatus(404)],
      ['a 201 (whose body says live)', withStatus(201)],
      [
        'a malformed body',
        (_q, r) => {
          r.writeHead(200, { 'content-type': 'application/json' });
          r.end('{"live":');
        },
      ],
      [
        // Valid JSON if read whole (whitespace padding): only the cap refuses it.
        'an oversized body',
        (_q, r, asked) => {
          r.writeHead(200, { 'content-type': 'application/json' });
          r.end(`${liveAnswer(asked)}${' '.repeat(4096)}`);
        },
      ],
      [
        'an answer about another user',
        (_q, r, asked) => {
          r.writeHead(200, { 'content-type': 'application/json' });
          r.end(liveAnswer({ ...asked, userId: 'USR-SOMEBODY-ELSE' }));
        },
      ],
      [
        'an answer about another organization',
        (_q, r, asked) => {
          r.writeHead(200, { 'content-type': 'application/json' });
          r.end(liveAnswer({ ...asked, organizationId: org.b }));
        },
      ],
    ];

    it.each(failures)(
      'refuses on %s (fail closed): 503, no driver row, no outbox event',
      async (_label, handler) => {
        const userId = newUser();
        live.add(`${org.a}\n${userId}`);
        behave = handler;
        const error = await create(service(300), org.a, userId).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(RastaError);
        expect({ status: (error as RastaError).status, code: (error as RastaError).code }).toEqual({
          status: 503,
          code: 'UPSTREAM_UNAVAILABLE',
        });
        await nothingWritten(userId);
      },
    );
  });
});
