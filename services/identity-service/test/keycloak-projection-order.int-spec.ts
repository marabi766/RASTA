import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import type { PlatformAttributes } from '../src/keycloak/platform-attributes';
import type { PrismaService } from '../src/prisma/prisma.service';
import { id, newPrisma, tenants, waitFor } from './helpers';

/**
 * ADR-060 § 5 — two projections of one user never leave Keycloak on the older
 * snapshot, against a real database.
 *
 * The interleaving that used to be possible: projection 1 reads the rows,
 * the rows change, projection 2 reads and writes the new state, and then
 * projection 1 — slow on its Keycloak call — writes the old state last. No
 * event is left to correct it, so the token stays wrong until a reconcile.
 *
 * Driven deterministically: projection 1's Keycloak write is held open on a
 * gate while the roles change and projection 2 starts. With the per-user lock,
 * projection 2 is seen waiting on it in `pg_locks`; without it, projection 2
 * simply finishes. Either way the gate then opens, and the assertion is on
 * what Keycloak holds last.
 */
describe('Keycloak projection ordering (ADR-060 § 5)', () => {
  const org = tenants();
  const userId = id('USR-ORD');
  const membershipId = id('MBR-ORD');
  let prisma: PrismaService;
  let projector: KeycloakProjector;
  const written: string[][] = [];
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');
    const repository = new IdentityRepository(prisma);

    let calls = 0;
    const keycloak = {
      enabled: true,
      replacePlatformAttributes: jest.fn(async (_id: string, attributes: PlatformAttributes) => {
        calls += 1;
        // Only the first write is held; it is the slow one.
        if (calls === 1) await gate;
        written.push(attributes.organization_roles);
      }),
    } as unknown as KeycloakAdminClient;
    projector = new KeycloakProjector(repository, keycloak);

    await runUnscoped('test fixture', async () => {
      await prisma.client.user.create({
        data: {
          id: userId,
          keycloakId: `kc-${userId}`,
          username: `ord-${userId.slice(-10)}`.toLowerCase(),
          email: `ord-${userId.slice(-10)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'ترتیب',
          status: 'ACTIVE',
          activeOrganizationId: org.a,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
      await prisma.client.membership.create({
        data: {
          id: membershipId,
          userId,
          organizationId: org.a,
          roles: ['ORGANIZATION_ADMIN'],
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
    });
  });

  afterAll(async () => {
    openGate();
    await prisma.onModuleDestroy();
  });

  const waitingOnProjectionLock = async () => {
    const rows = await prisma.client.$queryRawUnsafe<{ waiting: bigint }[]>(
      `SELECT count(*) AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
    );
    return Number(rows[0]?.waiting ?? 0) > 0;
  };

  it('writes the newest snapshot last, however the two projections interleave', async () => {
    // Projection 1 reads ORGANIZATION_ADMIN and stalls on its Keycloak write.
    const first = projector.project(userId, 'event');
    await waitFor('the first projection to reach Keycloak', async () =>
      (projector as unknown as { keycloak: { replacePlatformAttributes: jest.Mock } }).keycloak
        .replacePlatformAttributes.mock.calls.length > 0
        ? true
        : null,
    );

    // The demotion commits while projection 1 is still in flight.
    await runUnscoped('test fixture', () =>
      prisma.client.membership.update({
        where: { id: membershipId },
        data: { roles: ['OPERATOR'], updatedBy: 'ITEST' },
      }),
    );

    // Projection 2 either waits on the per-user lock, or — without one —
    // runs to completion ahead of projection 1.
    let secondDone = false;
    const second = projector.project(userId, 'request').then((outcome) => {
      secondDone = true;
      return outcome;
    });
    await waitFor('the second projection to wait or finish', async () =>
      secondDone || (await waitingOnProjectionLock()) ? true : null,
    );

    openGate();
    await Promise.all([first, second]);

    // The demotion is what Keycloak holds, not the stale administrator role.
    expect(written.at(-1)).toEqual([`${org.a}:OPERATOR`]);
    expect(written).toEqual([[`${org.a}:ORGANIZATION_ADMIN`], [`${org.a}:OPERATOR`]]);
  });
});
