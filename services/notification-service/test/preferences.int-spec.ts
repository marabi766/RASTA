import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  cleanup,
  deliver,
  insuranceExpiring,
  newOrganizationId,
  newUserId,
  wire,
  type Wiring,
} from './helpers';

/**
 * `NTF-003` — a preference actually suppresses a delivery.
 *
 * The ladder itself is exercised rung by rung in `precedence.spec.ts`, where it
 * is a pure function and every combination is cheap. What needs a real database
 * is the other half: that a stored row is read inside the dispatch transaction,
 * that the suppressed delivery satisfies `ck_delivery_suppressed_shape` — zero
 * attempts, a bounded reason, and no row the person can see — and that
 * silencing one recipient leaves the others untouched.
 *
 * That last one is the point of the whole story. A preference that quietly
 * silenced everybody would be a bug nobody notices until an organization stops
 * being told its insurance is expiring.
 */
describe('preferences decide who is told', () => {
  let w: Wiring;
  const organizations: string[] = [];

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  }, 120_000);

  /** Writes a preference the way the API will, and unscoped for the same reason a seed is. */
  async function storePreference(input: {
    organizationId: string;
    userId: string;
    scope: 'GLOBAL' | 'CATEGORY' | 'RULE';
    scopeKey: string | null;
    enabled: boolean;
    /** Defaults to `IN_APP`, which is what every test written before NTF-004 meant. */
    channel?: 'IN_APP' | 'EMAIL';
  }): Promise<void> {
    await runUnscoped('a test seeding a preference the way the API writes it', () =>
      w.prisma.client.notificationPreference.create({
        data: {
          id: `NPF_${ulid()}`,
          organizationId: input.organizationId,
          userId: input.userId,
          scope: input.scope,
          scopeKey: input.scopeKey,
          channel: input.channel ?? 'IN_APP',
          enabled: input.enabled,
          updatedBy: input.userId,
        },
      }),
    );
  }

  /** One notification for one organization, from event to dispatched rows. */
  async function notify(organizationId: string, recipients: readonly string[]): Promise<void> {
    w.recipients.answers.set(
      organizationId,
      recipients.map((userId) => ({ userId, role: 'FLEET_MANAGER' })),
    );
    await deliver(
      w,
      insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    await w.worker.tick();
  }

  /**
   * The in-app rows only.
   *
   * Narrowed when NTF-004 gave every recipient a second delivery. Every
   * assertion below is about an `IN_APP` preference deciding an `IN_APP`
   * delivery, and counting both channels here would make each expected number
   * twice what the test is actually about. The email channel has its own
   * assertions at the end of this file.
   */
  const deliveriesFor = (organizationId: string) =>
    runUnscoped('a test reading its own run rows', () =>
      w.prisma.client.notificationDelivery.findMany({
        where: { organizationId, channel: 'IN_APP' },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const emailDeliveriesFor = (organizationId: string) =>
    runUnscoped('a test reading its own run rows', () =>
      w.prisma.client.notificationDelivery.findMany({
        where: { organizationId, channel: 'EMAIL' },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const inAppFor = (organizationId: string) =>
    runUnscoped('a test reading its own run rows', () =>
      w.prisma.client.inAppNotification.findMany({ where: { organizationId } }),
    );

  it('delivers to everybody when nobody has stored a preference', async () => {
    const org = organization();
    const [first, second] = [newUserId(), newUserId()];

    await notify(org, [first, second]);

    const deliveries = await deliveriesFor(org);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((row) => row.status === 'SENT')).toBe(true);
    expect(await inAppFor(org)).toHaveLength(2);
  });

  // The whole story in one test.
  it('suppresses only the person who opted out', async () => {
    const org = organization();
    const [quiet, loud] = [newUserId(), newUserId()];
    await storePreference({
      organizationId: org,
      userId: quiet,
      scope: 'GLOBAL',
      scopeKey: null,
      enabled: false,
    });

    await notify(org, [quiet, loud]);

    const deliveries = await deliveriesFor(org);
    expect(deliveries).toHaveLength(2);

    expect(deliveries.find((row) => row.userId === quiet)).toMatchObject({
      status: 'SUPPRESSED',
      suppressionReason: 'PREFERENCE_OPT_OUT',
      // Suppression is a decision, not a failure, so it carries no attempts.
      attemptCount: 0,
      sentAt: null,
    });
    expect(deliveries.find((row) => row.userId === loud)).toMatchObject({ status: 'SENT' });

    const rows = await inAppFor(org);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(loud);
  });

  it('records the entitlement even for the person who opted out', async () => {
    const org = organization();
    const quiet = newUserId();
    await storePreference({
      organizationId: org,
      userId: quiet,
      scope: 'GLOBAL',
      scopeKey: null,
      enabled: false,
    });

    await notify(org, [quiet]);

    // The resolution records that this person *was* entitled, which stays true
    // even though they asked not to be told. Without it the suppressed delivery
    // would have no explanation of why it existed at all.
    const resolutions = await runUnscoped('a test reading its own run rows', () =>
      w.prisma.client.recipientResolution.findMany({ where: { organizationId: org } }),
    );
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.userId).toBe(quiet);
  });

  it('lets a narrower yes beat a broader no', async () => {
    const org = organization();
    const user = newUserId();
    await storePreference({
      organizationId: org,
      userId: user,
      scope: 'GLOBAL',
      scopeKey: null,
      enabled: false,
    });
    await storePreference({
      organizationId: org,
      userId: user,
      scope: 'RULE',
      scopeKey: 'insurance.expiring',
      enabled: true,
    });

    await notify(org, [user]);

    expect((await deliveriesFor(org))[0]).toMatchObject({ status: 'SENT' });
  });

  it('lets a category-level no cover every rule in that category', async () => {
    const org = organization();
    const user = newUserId();
    await storePreference({
      organizationId: org,
      userId: user,
      scope: 'CATEGORY',
      scopeKey: 'EXPIRY',
      enabled: false,
    });

    await notify(org, [user]);

    expect((await deliveriesFor(org))[0]).toMatchObject({
      status: 'SUPPRESSED',
      suppressionReason: 'PREFERENCE_OPT_OUT',
    });
  });

  /**
   * Preferences are per tenant, and ADR-054 § 5 says why in one sentence: one
   * human administering three dehyaris is one user with three memberships, and
   * has to be able to silence one without silencing the others.
   */
  it('silences one organization without silencing another', async () => {
    const quietOrg = organization();
    const loudOrg = organization();
    const user = newUserId();

    await storePreference({
      organizationId: quietOrg,
      userId: user,
      scope: 'GLOBAL',
      scopeKey: null,
      enabled: false,
    });

    await notify(quietOrg, [user]);
    await notify(loudOrg, [user]);

    expect((await deliveriesFor(quietOrg))[0]).toMatchObject({ status: 'SUPPRESSED' });
    expect((await deliveriesFor(loudOrg))[0]).toMatchObject({ status: 'SENT' });
  });

  describe('the shapes the database refuses', () => {
    it('refuses a GLOBAL row that carries a scope key', async () => {
      await expect(
        storePreference({
          organizationId: organization(),
          userId: newUserId(),
          scope: 'GLOBAL',
          scopeKey: 'EXPIRY',
          enabled: false,
        }),
      ).rejects.toThrow();
    });

    it('refuses a RULE row with no scope key', async () => {
      await expect(
        storePreference({
          organizationId: organization(),
          userId: newUserId(),
          scope: 'RULE',
          scopeKey: null,
          enabled: false,
        }),
      ).rejects.toThrow();
    });

    /**
     * PostgreSQL treats NULLs as distinct in a unique index, so the composite
     * key alone would let two GLOBAL rows exist for one channel — and the
     * winning layer would then depend on row order.
     * `ux_preference_global_channel` is the partial index that closes it, and
     * this is what proves it is really there.
     */
    it('refuses a second GLOBAL row for the same person and channel', async () => {
      const org = organization();
      const user = newUserId();
      await storePreference({
        organizationId: org,
        userId: user,
        scope: 'GLOBAL',
        scopeKey: null,
        enabled: true,
      });

      await expect(
        storePreference({
          organizationId: org,
          userId: user,
          scope: 'GLOBAL',
          scopeKey: null,
          enabled: false,
        }),
      ).rejects.toThrow();
    });
  });
  /**
   * NTF-004 — the second channel, and the three ways it can decline to write.
   *
   * The ladder is the same one; what is new is that an email delivery can be
   * suppressed for reasons that have nothing to do with a preference, and each
   * of those has to be distinguishable from somebody having opted out. An
   * operator looking at a tenant that receives no email needs to know whether
   * people turned it off, whether identity holds no addresses, or whether a
   * rule was added without email text.
   */
  describe('the email channel writes its own row, with its own reason', () => {
    it('queues an email beside the in-app delivery when nobody has said otherwise', async () => {
      const org = organization();
      const user = newUserId();

      await notify(org, [user]);

      const email = await emailDeliveriesFor(org);
      expect(email).toHaveLength(1);
      expect(email[0]).toMatchObject({
        status: 'QUEUED',
        attemptCount: 0,
        maxAttempts: 6,
        suppressionReason: null,
        sentAt: null,
        // Queued is not sent. Nothing left this platform inside the dispatch
        // transaction, and the row says so.
        renderedHash: null,
      });
      expect(email[0]!.nextAttemptAt).not.toBeNull();
      // The in-app half is untouched by any of it.
      expect(await deliveriesFor(org)).toHaveLength(1);
    });

    it('suppresses the email and keeps the in-app row when the person opted out of email', async () => {
      const org = organization();
      const user = newUserId();
      await storePreference({
        organizationId: org,
        userId: user,
        scope: 'GLOBAL',
        scopeKey: null,
        enabled: false,
        channel: 'EMAIL',
      });

      await notify(org, [user]);

      expect((await emailDeliveriesFor(org))[0]).toMatchObject({
        status: 'SUPPRESSED',
        suppressionReason: 'PREFERENCE_OPT_OUT',
        attemptCount: 0,
      });
      // Turning off email must not turn off the inbox. They are separate
      // rungs of separate ladders, and conflating them would silence a person
      // who asked for one thing.
      expect((await deliveriesFor(org))[0]).toMatchObject({ status: 'SENT' });
    });

    it('suppresses with NO_ADDRESS when identity holds none, and still notifies in-app', async () => {
      const org = organization();
      const user = newUserId();
      w.recipients.answers.set(org, [{ userId: user, role: 'FLEET_MANAGER', email: null }]);
      await deliver(
        w,
        insuranceExpiring({ organizationId: org, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      );
      await w.worker.tick();

      expect((await emailDeliveriesFor(org))[0]).toMatchObject({
        status: 'SUPPRESSED',
        suppressionReason: 'NO_ADDRESS',
      });
      expect((await deliveriesFor(org))[0]).toMatchObject({ status: 'SENT' });
    });

    it('snapshots the address on the resolution, so the row can answer where it wrote', async () => {
      const org = organization();
      const user = newUserId();
      w.recipients.answers.set(org, [
        { userId: user, role: 'FLEET_MANAGER', email: 'someone@example.invalid' },
      ]);
      await deliver(
        w,
        insuranceExpiring({ organizationId: org, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      );
      await w.worker.tick();

      const resolutions = await runUnscoped('a test reading its own run rows', () =>
        w.prisma.client.recipientResolution.findMany({ where: { organizationId: org } }),
      );
      expect(resolutions[0]!.emailSnapshot).toBe('someone@example.invalid');
    });
  });
});
