import { ZONE_SWITCHES, inSessionZone } from '@rasta/testing';
import { captureOutboxProvenance } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { asActor, newPrisma } from './helpers';

/**
 * Written from their DEFAULT by raw INSERTs, and compared in UTC: under a bare
 * CURRENT_TIMESTAMP a registration received in a session east of UTC was not due for
 * its offset (FU-188, PR-881 r1 F1 instance 1).
 */
describe('registration intake and provisioning intent in any session zone', () => {
  const prisma = newPrisma();

  afterAll(() => prisma.stop());

  it.each(ZONE_SWITCHES)('a registration received in %s and read in %s', async (first, second) => {
    await inSessionZone(prisma, async ({ db, zone, secondsFromNow }) => {
      const repository = new IdentityRepository(db);
      const id = ulid();
      const row = 'registration_intake WHERE id = $1';

      await zone(first);
      await asActor({ organizationId: id }, () =>
        repository.receiveRegistration(id, {} as never, captureOutboxProvenance()),
      );
      expect(Math.abs(await secondsFromNow('next_attempt_at', row, id))).toBeLessThan(0.002);
      expect(Math.abs(await secondsFromNow('received_at', row, id))).toBeLessThan(0.002);

      // Parked in the other zone, for exactly its backoff, and not due in the first.
      await zone(second);
      await repository.deferRegistrationIntake(id, 300, 1);
      const parked = await secondsFromNow('next_attempt_at', row, id);
      expect(Math.abs(parked - 300)).toBeLessThan(1);
      await zone(first);
      expect(await repository.findDueRegistrationIntakes(1_000_000)).not.toContain(id);
    });
  });

  it.each(['Asia/Tehran', 'America/Los_Angeles', 'UTC'])(
    'a provisioning intent claimed in %s is stamped in UTC',
    async (name) => {
      await inSessionZone(prisma, async ({ db, tx, zone, secondsFromNow }) => {
        const repository = new IdentityRepository(db);
        const id = ulid();
        await zone(name);
        await repository.claimProvisioningIntent(
          tx as never,
          {
            actorId: id,
            idempotencyKey: id,
            actingOrganizationId: null,
            requestHash: 'a'.repeat(64),
            userId: id,
            membershipId: id,
          } as never,
        );
        const at = await secondsFromNow(
          'created_at',
          'user_provisioning_intent WHERE actor_id = $1',
          id,
        );
        expect(Math.abs(at)).toBeLessThan(0.002);
      });
    },
  );
});
