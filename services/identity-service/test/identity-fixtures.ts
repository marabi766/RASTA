import request from 'supertest';
import { ulid } from 'ulid';
import { runUnscoped, runWithContext, tryGetContext } from '@rasta/nest-common';
import { eligibilityClockWrite } from '@rasta/testing';
import type { PrismaService } from '../src/prisma/prisma.service';
import { RegistrationIntakeWorker } from '../src/identity/registration-intake.worker';
import type { IdentityService } from '../src/identity/identity.service';
import type { SubmitRegistrationDto } from '../src/identity/dto';
import { userToken, type IdentityApiHarness } from './api-helpers';
import { id } from './helpers';

/**
 * People and memberships as rows, and requests as the HTTP surface takes them,
 * for the task 117 suites (live authority, live access, the registration
 * acknowledgement, provisioning intents).
 */

export interface Person {
  userId: string;
  membershipId: string;
  organizationId: string;
  username: string;
  email: string;
}

export interface MembershipSpec {
  organizationId: string;
  roles: string[];
  status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  /** Default: began an hour ago, open-ended, by the database clock (`dateMembershipWindow`). */
  window?: MembershipWindow;
  /** Revoked: `deletedAt` set too, as a revocation leaves it. */
  deletedAt?: Date | null;
}

/** A user with one membership; no Keycloak account. */
export async function seedPerson(
  prisma: PrismaService,
  tag: string,
  membership: MembershipSpec,
): Promise<Person> {
  const userId = id(`USR-${tag}`);
  const membershipId = id(`MBR-${tag}`);
  const handle = `${tag}-${userId.slice(-12)}`.toLowerCase();
  await runUnscoped('test fixture spans organizations', async () => {
    await prisma.client.user.create({
      data: {
        id: userId,
        username: handle,
        email: `${handle}@example.test`,
        firstName: 'آزمون',
        lastName: 'زنده',
        phone: '09120000000',
        status: 'ACTIVE',
        activeOrganizationId: membership.organizationId,
        createdBy: 'ITEST',
        updatedBy: 'ITEST',
      },
    });
    await addMembershipRow(prisma, userId, membership, membershipId);
  });
  return {
    userId,
    membershipId,
    organizationId: membership.organizationId,
    username: handle,
    email: `${handle}@example.test`,
  };
}

/** Another membership of an existing user. */
export async function addMembershipRow(
  prisma: PrismaService,
  userId: string,
  membership: MembershipSpec,
  membershipId = id('MBR-ROW'),
): Promise<string> {
  await runUnscoped('test fixture spans organizations', () =>
    prisma.client.membership.create({
      data: {
        id: membershipId,
        userId,
        organizationId: membership.organizationId,
        roles: membership.roles,
        status: membership.status ?? 'ACTIVE',
        deletedAt: membership.deletedAt ?? null,
        createdBy: 'ITEST',
        updatedBy: 'ITEST',
      },
    }),
  );
  await dateMembershipWindow(
    prisma,
    membershipId,
    membership.window ?? { fromMs: -3_600_000, untilMs: null },
  );
  return membershipId;
}

/** Offsets in milliseconds from the database's now(); `untilMs: null` is open-ended. */
export interface MembershipWindow {
  fromMs: number;
  untilMs: number | null;
}

/**
 * Dates one membership's validity window on the database clock, the clock the
 * product judges it on (`findLiveMemberships` and the lapse sweep compare it
 * with the database's): never with this process's clock (eligibility-clock
 * guard). Returns the stored instants, for a test that needs them exactly.
 */
export async function dateMembershipWindow(
  prisma: PrismaService,
  membershipId: string,
  window: MembershipWindow,
): Promise<{ validFrom: Date; validUntil: Date | null }> {
  const finite = (ms: number | null) => ms === null || Number.isFinite(ms);
  if (!Number.isFinite(window.fromMs) || !finite(window.untilMs))
    throw new Error(`dateMembershipWindow needs finite offsets: ${JSON.stringify(window)}`);
  const updated = await runUnscoped(
    'test fixture dates a membership window',
    () =>
      eligibilityClockWrite(prisma.client)`
      UPDATE membership
         SET valid_from = now() + make_interval(secs => ${window.fromMs / 1000}::float8),
             valid_until = now() + make_interval(secs => ${window.untilMs === null ? null : window.untilMs / 1000}::float8)
       WHERE id = ${membershipId}`,
  );
  if (updated !== 1) throw new Error(`dateMembershipWindow updated ${updated} rows`);
  const row = await runUnscoped('test reads its own fixture', () =>
    prisma.client.membership.findUniqueOrThrow({ where: { id: membershipId } }),
  );
  return { validFrom: row.validFrom, validUntil: row.validUntil };
}

/** A committed membership row, outside any transaction. */
export const membershipRow = (prisma: PrismaService, membershipId: string) =>
  runUnscoped('test reads what committed', () =>
    prisma.client.membership.findFirst({ where: { id: membershipId } }),
  );

/** The outbox rows of one aggregate, oldest first: its event names. */
export const eventNames = async (prisma: PrismaService, aggregateId: string) =>
  (
    await runUnscoped('test reads the outbox', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    )
  ).map((event) => event.eventName);

/** The bearer a person's token carried when it was minted, with these roles. */
export const bearerOf = (person: { userId: string; organizationId: string }, roles: string[]) =>
  `Bearer ${userToken({ userId: person.userId, organizationId: person.organizationId, roles })}`;

/** The HTTP surface, as a gateway would call it. */
export function http(harness: IdentityApiHarness) {
  const server = () => harness.app.getHttpServer();
  return {
    roles: (bearer: string, membershipId: string, roles: string[]) =>
      request(server())
        .post(`/v1/memberships/${membershipId}/roles`)
        .set('authorization', bearer)
        .send({ roles, reason: 'task 117 itest' }),
    revoke: (bearer: string, membershipId: string) =>
      request(server())
        .post(`/v1/memberships/${membershipId}/revoke`)
        .set('authorization', bearer)
        .send({ reason: 'task 117 itest' }),
    addMembership: (bearer: string, userId: string, organizationId: string, roles: string[]) =>
      request(server())
        .post(`/v1/users/${userId}/memberships`)
        .set('authorization', bearer)
        .send({ organizationId, roles }),
    createUser: (bearer: string, key: string | null, body: Record<string, unknown>) => {
      const call = request(server()).post('/v1/users').set('authorization', bearer);
      return (key === null ? call : call.set('idempotency-key', key)).send(body);
    },
    getUser: (bearer: string, userId: string) =>
      request(server()).get(`/v1/users/${userId}`).set('authorization', bearer),
    patchUser: (bearer: string, userId: string, body: Record<string, unknown>) =>
      request(server()).patch(`/v1/users/${userId}`).set('authorization', bearer).send(body),
    listUsers: (bearer: string, query: Record<string, string> = {}) =>
      request(server()).get('/v1/users').query(query).set('authorization', bearer),
    register: (body: Record<string, unknown>, correlationId?: string) => {
      const call = request(server()).post('/v1/registration-requests');
      return (
        correlationId === undefined ? call : call.set('x-correlation-id', correlationId)
      ).send(body);
    },
    approve: (bearer: string, registrationId: string) =>
      request(server())
        .post(`/v1/registration-requests/${registrationId}/approve`)
        .set('authorization', bearer)
        .send({}),
    reject: (bearer: string, registrationId: string) =>
      request(server())
        .post(`/v1/registration-requests/${registrationId}/reject`)
        .set('authorization', bearer)
        .send({ reason: 'task 117 itest: not this one' }),
    listRegistrations: (bearer: string, query: Record<string, string>) =>
      request(server()).get('/v1/registration-requests').query(query).set('authorization', bearer),
  };
}

/** A registration body for `username`, asking to join `organizationId`. */
export const registrationBody = (username: string, email: string, organizationId: string) => ({
  username,
  email,
  firstName: 'متقاضی',
  lastName: 'آزمون',
  requestedOrganizationId: organizationId,
  requestedRoles: ['FLEET_MANAGER'],
});

/**
 * Runs the registration worker's passes now, as its timer would, until one
 * handles nothing (task 130): every received public registration recorded or
 * discarded, however many other suites left behind on a shared database — a
 * pass takes one batch. Resolves to how many it handled.
 */
export async function processRegistrations(harness: IdentityApiHarness): Promise<number> {
  const worker = harness.moduleRef.get(RegistrationIntakeWorker);
  let handled = 0;
  for (let pass = await worker.drain(); pass > 0; pass = await worker.drain()) handled += pass;
  return handled;
}

/**
 * Runs `fn` as the public registration route does: inside an HTTP request
 * that presented no credential (`authType: 'ANONYMOUS'`). An intake is always
 * some request's; outside one there is no origin to record, and it is refused
 * (PR #483 r3 F1). A test that must tell this request's database work from
 * the background workers' names its correlation id.
 */
export function asAnonymousRequest<T>(fn: () => T, correlationId: string = ulid()): T {
  return runWithContext(
    {
      correlationId,
      requestId: ulid(),
      organizationIds: [],
      roles: [],
      authType: 'ANONYMOUS',
      startedAt: Date.now(),
    },
    fn,
  );
}

/**
 * A registration received and recorded at once — the intake, then the
 * worker's step for it: the request's id. For suites about what happens to a
 * request after it exists.
 */
export async function recordRegistration(
  service: IdentityService,
  dto: SubmitRegistrationDto,
): Promise<string> {
  const intakeId = await asAnonymousRequest(() => service.receiveRegistration(dto));
  const handled = await service.processRegistrationIntake(intakeId);
  if (handled.outcome !== 'RECORDED') throw new Error(`registration ${handled.outcome}`);
  return handled.registrationId;
}

/** One thing a request asked the database for, as its shape: no value in it that varies with the data. */
export interface DatabaseOperation {
  model?: string;
  operation: string;
  /** A raw statement: its text with the parameters as `?`, whitespace collapsed. */
  statement?: string;
  /** What each parameter / argument leaf is (`string`, `null`, …), never what it holds. */
  shape: unknown;
}

const leafKind = (value: unknown) => (value === null ? 'null' : typeof value);
const shapeOf = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(shapeOf)
    : value !== null &&
        typeof value === 'object' &&
        Object.getPrototypeOf(value) === Object.prototype
      ? Object.fromEntries(Object.entries(value).map(([key, leaf]) => [key, shapeOf(leaf)]))
      : leafKind(value);

const describeOperation = (model: string | undefined, operation: string, args: unknown) => {
  const raw = args as { strings?: string[]; values?: unknown[] } | undefined;
  return Array.isArray(raw?.strings) && Array.isArray(raw?.values)
    ? ({
        operation,
        statement: raw.strings.join('?').replace(/\s+/g, ' ').trim(),
        shape: raw.values.map(leafKind),
      } satisfies DatabaseOperation)
    : ({ model, operation, shape: shapeOf(args) } satisfies DatabaseOperation);
};

/**
 * What the database is asked for by one request, as an ordered list of shapes —
 * for a property about the *work* a request does (what it reads, writes and
 * constrains), which is what a time measurement can only estimate. Every
 * operation of the service's client passes one extension that records it under
 * the correlation id of the request it ran in (`tryGetContext`), so the
 * background workers' queries on the same client are never in a list. The
 * client is swapped for the extended one only until {@link stop}.
 */
export function observeDatabaseWork(prisma: PrismaService) {
  const real = prisma.client;
  const seen = new Map<string, DatabaseOperation[]>();
  const probe = real.$extends({
    name: 'database-work-probe',
    query: {
      $allOperations({ model, operation, args, query }) {
        const correlationId = tryGetContext()?.correlationId;
        const log = correlationId === undefined ? undefined : seen.get(correlationId);
        log?.push(describeOperation(model, operation, args));
        return query(args);
      },
    },
  });
  Object.defineProperty(prisma, 'client', { value: probe, configurable: true, writable: true });
  return {
    /** Runs `run` as one request with a correlation id of its own; resolves to what it asked the database. */
    async during(run: (correlationId: string) => Promise<unknown>): Promise<DatabaseOperation[]> {
      const correlationId = ulid();
      const log: DatabaseOperation[] = [];
      seen.set(correlationId, log);
      await run(correlationId);
      return log;
    },
    stop() {
      Object.defineProperty(prisma, 'client', { value: real, configurable: true, writable: true });
    },
  };
}
