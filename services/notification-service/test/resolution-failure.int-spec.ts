import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { RecipientResolutionError } from '../src/recipients/recipient.port';
import { LeaseLostError } from '../src/notification/notification.repository';
import {
  asWorker,
  capturingLogger,
  cleanup,
  deliver,
  insuranceExpiring,
  newOrganizationId,
  newUserId,
  rowsFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * identity-service is unavailable → the intent stays `PENDING`, is retried,
 * and the partition that produced the event was never blocked (ADR-054 § 1).
 *
 * The partition claim is structural: `deliver()` returned before any of this
 * ran. What is proven here is the rest — the row is retained, the attempt
 * count climbs, the retry is scheduled, the lease is released, no delivery is
 * fabricated, and once identity answers the intent completes. Then the lease
 * mechanics: disjoint claims, a stolen lease, a fenced write.
 */
describe('recipient resolution failure and recovery', () => {
  let w: Wiring;
  const organizations: string[] = [];
  const logger = capturingLogger();

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    w = wire(logger);
    await w.prisma.onModuleInit();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  it('retains a PENDING intent, schedules a retry and reports no delivery while identity is away', async () => {
    const organizationId = organization();
    await deliver(
      w,
      insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );

    w.recipients.failWith = new RecipientResolutionError('UNREACHABLE', 'identity is down');
    await expect(w.worker.tick()).resolves.toBe(1);

    let rows = await rowsFor(w.prisma, organizationId);
    let intent = rows.intents[0]!;
    expect(intent.status).toBe('PENDING');
    expect(intent.resolutionAttempts).toBe(1);
    expect(intent.lastResolutionError).toBe('UNREACHABLE');
    expect(intent.nextResolutionAt!.getTime()).toBeGreaterThan(Date.now());
    expect(intent.claimToken).toBeNull();
    expect(intent.claimOwner).toBeNull();
    expect(intent.claimExpiresAt).toBeNull();
    expect(rows.deliveries).toHaveLength(0);
    expect(rows.inApp).toHaveLength(0);

    // Not due yet, so a second tick claims nothing.
    await expect(w.worker.tick()).resolves.toBe(0);

    // Make it due again, with identity still down: the count climbs.
    await runUnscoped('the test makes a deferred intent due immediately', () =>
      w.prisma.client.notificationIntent.updateMany({
        where: { organizationId },
        data: { nextResolutionAt: null },
      }),
    );
    w.recipients.failWith = new RecipientResolutionError('REFUSED', 'identity answered 503');
    await expect(w.worker.tick()).resolves.toBe(1);
    intent = (await rowsFor(w.prisma, organizationId)).intents[0]!;
    expect(intent.resolutionAttempts).toBe(2);
    expect(intent.lastResolutionError).toBe('REFUSED');
    expect(intent.status).toBe('PENDING');

    // identity comes back.
    w.recipients.failWith = undefined;
    const user = newUserId();
    w.recipients.answers.set(organizationId, [{ userId: user, role: 'FLEET_MANAGER' }]);
    await runUnscoped('the test makes a deferred intent due immediately', () =>
      w.prisma.client.notificationIntent.updateMany({
        where: { organizationId },
        data: { nextResolutionAt: null },
      }),
    );
    await expect(w.worker.tick()).resolves.toBe(1);

    rows = await rowsFor(w.prisma, organizationId);
    intent = rows.intents[0]!;
    expect(intent.status).toBe('DISPATCHED');
    expect(intent.resolutionAttempts).toBe(2);
    expect(intent.resolvedAt).not.toBeNull();
    expect(intent.dispatchedAt).not.toBeNull();
    expect(intent.nextResolutionAt).toBeNull();
    expect(rows.resolutions).toEqual([
      expect.objectContaining({
        userId: user,
        resolvedRole: 'FLEET_MANAGER',
        resolutionSource: 'IDENTITY_API',
        emailSnapshot: null,
      }),
    ]);
    expect(rows.deliveries).toEqual([
      expect.objectContaining({
        userId: user,
        channel: 'IN_APP',
        status: 'SENT',
        attemptCount: 1,
        maxAttempts: 1,
      }),
    ]);
    expect(rows.inApp).toEqual([
      expect.objectContaining({ userId: user, readAt: null, dismissedAt: null }),
    ]);
    expect(rows.inApp[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows.inApp[0]!.actionPath).toMatch(/^\/assets\//);
  });

  it('suppresses an intent when identity answers with nobody entitled', async () => {
    const organizationId = organization();
    await deliver(
      w,
      insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    // No answer registered for this organization → empty list.
    await w.worker.tick();

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents[0]).toMatchObject({
      status: 'SUPPRESSED',
      terminalReason: 'NO_ELIGIBLE_RECIPIENT',
      claimToken: null,
    });
    expect(rows.deliveries).toHaveLength(0);
    expect(rows.inApp).toHaveLength(0);
  });

  it('leases disjoint rows to concurrent workers and leaves an expired lease claimable', async () => {
    const organizationId = organization();
    for (let i = 0; i < 6; i += 1) {
      await deliver(
        w,
        insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      );
    }

    const [a, b, c] = await Promise.all([
      w.repository.claimPending('worker-a', 2, 60),
      w.repository.claimPending('worker-b', 2, 60),
      w.repository.claimPending('worker-c', 2, 60),
    ]);
    const ids = [...a, ...b, ...c].map((intent) => intent.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(a.every((intent) => intent.claimOwner === 'worker-a' && intent.claimToken)).toBe(true);

    // Nothing left to claim while every lease is live.
    expect(await w.repository.claimPending('worker-d', 10, 60)).toHaveLength(0);

    // Expire one lease as a crashed worker would leave it; it is claimable again.
    await runUnscoped('the test expires one lease to simulate a crashed worker', () =>
      w.prisma.client.notificationIntent.update({
        where: { id: a[0]!.id },
        data: { claimExpiresAt: new Date(Date.now() - 1_000) },
      }),
    );
    const reclaimed = await w.repository.claimPending('worker-d', 10, 60);
    expect(reclaimed.map((intent) => intent.id)).toEqual([a[0]!.id]);
    expect(reclaimed[0]!.claimToken).not.toBe(a[0]!.claimToken);
  });

  it('refuses a dispatch whose lease was taken over, writing nothing', async () => {
    const organizationId = organization();
    await deliver(
      w,
      insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );

    const [stale] = await w.repository.claimPending('worker-slow', 1, 60);
    // The slow worker's lease expires and a fast one takes it over.
    await runUnscoped('the test expires a lease to stage a takeover', () =>
      w.prisma.client.notificationIntent.update({
        where: { id: stale!.id },
        data: { claimExpiresAt: new Date(Date.now() - 1_000) },
      }),
    );
    const [fresh] = await w.repository.claimPending('worker-fast', 1, 60);
    expect(fresh!.id).toBe(stale!.id);
    expect(fresh!.claimToken).not.toBe(stale!.claimToken);

    const user = newUserId();
    w.recipients.answers.set(organizationId, [{ userId: user, role: 'FLEET_MANAGER' }]);

    // The slow worker finishes its identity call and tries to write.
    await expect(
      asWorker(organizationId, () => w.worker.processIntent(stale!)),
    ).resolves.toBeUndefined();
    let rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents[0]!.status).toBe('PENDING');
    expect(rows.deliveries).toHaveLength(0);
    expect(logger.lines.some((line) => line.includes('taken over'))).toBe(true);

    // The repository-level fence is what did that.
    await expect(
      asWorker(organizationId, () =>
        w.repository.dispatchInApp({
          intent: stale!,
          recipients: [{ userId: user, role: 'FLEET_MANAGER' }],
          rendered: { title: 't', body: 'b', actionPath: null },
          templateVersion: 1,
          inAppTtlDays: 1,
        }),
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);

    // The holder of the live lease succeeds.
    await asWorker(organizationId, () => w.worker.processIntent(fresh!));
    rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents[0]!.status).toBe('DISPATCHED');
    expect(rows.inApp).toHaveLength(1);
    // The unique constraint would have been the last line anyway.
    expect(rows.deliveries).toHaveLength(1);
  });

  it('records a render failure as FAILED deliveries with a PERMANENT_FAILURE attempt and no in-app row', async () => {
    const organizationId = organization();
    await deliver(
      w,
      insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    // Corrupt the stored context so the template cannot render — the shape a
    // template edited after ingest would produce.
    await runUnscoped('the test removes a required context key to stage a render failure', () =>
      w.prisma.client.notificationIntent.updateMany({
        where: { organizationId },
        data: { contextData: { assetId: 'AST_ONLY' } },
      }),
    );
    w.recipients.answers.set(organizationId, [{ userId: newUserId(), role: 'FLEET_MANAGER' }]);

    await w.worker.tick();

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents[0]!.status).toBe('DISPATCHED');
    expect(rows.deliveries).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        lastErrorClass: 'RENDER_FAILED',
        sentAt: null,
        attemptCount: 1,
      }),
    ]);
    expect(rows.attempts).toEqual([
      expect.objectContaining({ outcome: 'PERMANENT_FAILURE', errorClass: 'RENDER_FAILED' }),
    ]);
    expect(rows.inApp).toHaveLength(0);
  });

  it("never lets an address reach this service's log lines", () => {
    // Every line the suites above produced went through the scrubber. None
    // should carry anything address-shaped — and the fake port never had one
    // to give, which is the stronger property.
    expect(logger.lines.length).toBeGreaterThan(0);
    for (const line of logger.lines) {
      expect(line).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
  });
});
