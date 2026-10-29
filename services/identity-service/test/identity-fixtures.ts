import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';
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
  validFrom?: Date;
  validUntil?: Date | null;
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
        validFrom: membership.validFrom ?? new Date(Date.now() - 3_600_000),
        validUntil: membership.validUntil ?? null,
        deletedAt: membership.deletedAt ?? null,
        createdBy: 'ITEST',
        updatedBy: 'ITEST',
      },
    }),
  );
  return membershipId;
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
    register: (body: Record<string, unknown>) =>
      request(server()).post('/v1/registration-requests').send(body),
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
