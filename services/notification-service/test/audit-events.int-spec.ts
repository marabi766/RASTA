import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { cleanup, newOrganizationId, newUserId } from './helpers';
import { seedNotification, startApi, userToken, type ApiHarness } from './api-helpers';

/**
 * `NTF-002` — reading a notification now reaches the audit trail.
 *
 * `ADR-054 § 3` refused to accept `NTF-002` while these events did not exist,
 * and was explicit that the refusal was not about scope:
 *
 *   > **این یک انحراف از قاعدهٔ الزام‌آور است، نه یک انتخاب دامنه.**
 *
 * `AGENTS.md` S-06 requires an audit record for every state-changing action.
 * Reading, dismissing and clearing an inbox are state changes. A structured log
 * line, a metric and a write-once column are each useful and none of them is an
 * audit record in the sense that rule means, because `audit-service` cannot
 * read any of them — its only input is the event log.
 *
 * ## What needs a real database to prove
 *
 * Three things, and none of them can be shown with a mock:
 *
 *   1. The event and the row it announces **commit together**. A mock can show
 *      that a method was called; only a transaction can show that a rollback
 *      takes both.
 *   2. An action that changed nothing announces nothing. The conditional
 *      `UPDATE` is what makes these endpoints idempotent, and the row count it
 *      returns is the only honest answer to "did this call change the world".
 *      A second read of an already-read notification must be silent.
 *   3. The whole thing runs through the real HTTP application with the real
 *      tenant guard, so the exemption the outbox needs is exercised rather than
 *      assumed.
 */
describe('in-app transitions reach the audit trail', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    api = await startApi();
  }, 120_000);

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  }, 120_000);

  const post = (path: string, token: string) =>
    request(api.server).post(path).set('authorization', `Bearer ${token}`);

  /**
   * The outbox rows for one organization, oldest first.
   *
   * `runUnscoped` for the same reason the publisher uses it: the outbox is
   * exempt from the tenant guard because the relay that drains it has no
   * request context. The `where` still names the organization, so the test
   * reads only its own run's rows.
   */
  async function eventsFor(organizationId: string) {
    const rows = await runUnscoped('a test reading the outbox the way the relay does', () =>
      api.prisma.client.outboxMessage.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      row,
      payload: (row.payload as { payload: Record<string, unknown> }).payload,
    }));
  }

  it('publishes NOTIFICATION_READ when a read actually moves the row', async () => {
    const org = organization();
    const me = newUserId();
    const seeded = await seedNotification(api.prisma, { organizationId: org, userId: me });

    await post(`/v1/notifications/${seeded.id}/read`, userToken(me, org)).expect(200);

    const events = await eventsFor(org);
    expect(events).toHaveLength(1);
    expect(events[0].row.eventName).toBe('NOTIFICATION_READ');
    expect(events[0].payload).toMatchObject({
      notificationId: seeded.id,
      organizationId: org,
      userId: me,
    });
  });

  // The property that makes the audit trail readable. Without it, a client that
  // retries a read — or a user who clicks twice — puts a second record of the
  // same event into a log that is supposed to be evidence.
  it('publishes nothing when the same notification is read again', async () => {
    const org = organization();
    const me = newUserId();
    const seeded = await seedNotification(api.prisma, { organizationId: org, userId: me });
    const token = userToken(me, org);

    await post(`/v1/notifications/${seeded.id}/read`, token).expect(200);
    await post(`/v1/notifications/${seeded.id}/read`, token).expect(200);
    await post(`/v1/notifications/${seeded.id}/read`, token).expect(200);

    expect(await eventsFor(org)).toHaveLength(1);
  });

  it('publishes one NOTIFICATION_DISMISSED, saying it also marked the row read', async () => {
    const org = organization();
    const me = newUserId();
    const seeded = await seedNotification(api.prisma, { organizationId: org, userId: me });

    await post(`/v1/notifications/${seeded.id}/dismiss`, userToken(me, org)).expect(200);

    const events = await eventsFor(org);
    // One event for one action. A dismissal that also marked the row read is a
    // single thing a person did, not two decisions.
    expect(events).toHaveLength(1);
    expect(events[0].row.eventName).toBe('NOTIFICATION_DISMISSED');
    expect(events[0].payload).toMatchObject({
      notificationId: seeded.id,
      markedReadByDismissal: true,
    });
  });

  it('says so when the dismissal did not also mark the row read', async () => {
    const org = organization();
    const me = newUserId();
    const seeded = await seedNotification(api.prisma, { organizationId: org, userId: me });
    const token = userToken(me, org);

    await post(`/v1/notifications/${seeded.id}/read`, token).expect(200);
    await post(`/v1/notifications/${seeded.id}/dismiss`, token).expect(200);

    const events = await eventsFor(org);
    expect(events.map((event) => event.row.eventName)).toEqual([
      'NOTIFICATION_READ',
      'NOTIFICATION_DISMISSED',
    ]);
    expect(events[1].payload).toMatchObject({ markedReadByDismissal: false });
  });

  it('publishes one NOTIFICATION_ALL_READ carrying the count, not one event per row', async () => {
    const org = organization();
    const me = newUserId();
    for (let i = 0; i < 4; i += 1) {
      await seedNotification(api.prisma, { organizationId: org, userId: me });
    }

    await post('/v1/notifications/read-all', userToken(me, org)).expect(200);

    const events = await eventsFor(org);
    expect(events).toHaveLength(1);
    expect(events[0].row.eventName).toBe('NOTIFICATION_ALL_READ');
    expect(events[0].payload).toMatchObject({ count: 4, userId: me });
  });

  it('publishes nothing when read-all had nothing to read', async () => {
    const org = organization();
    const me = newUserId();

    await post('/v1/notifications/read-all', userToken(me, org)).expect(200);

    expect(await eventsFor(org)).toEqual([]);
  });

  // One person's read and dismiss of the same notification have to arrive in
  // the order they happened, and Kafka orders within a partition and nowhere
  // else. Keying by the notification would scatter one inbox across partitions.
  it('keys every event by the recipient, so one inbox stays one ordered stream', async () => {
    const org = organization();
    const me = newUserId();
    const seeded = await seedNotification(api.prisma, { organizationId: org, userId: me });
    const token = userToken(me, org);

    await post(`/v1/notifications/${seeded.id}/read`, token).expect(200);
    await post(`/v1/notifications/${seeded.id}/dismiss`, token).expect(200);
    await post('/v1/notifications/read-all', token).expect(200);

    const events = await eventsFor(org);
    for (const event of events) {
      expect(event.row.partitionKey).toBe(me);
      expect(event.row.topic).toBe('rasta.notification.v1');
    }

    // Allocated inside the writing transaction, so allocation order equals
    // commit order on this stream.
    const sequences = events.map((event) => Number(event.row.streamSeq));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('carries the tenant on the row, so the relay can filter without reading the payload', async () => {
    const org = organization();
    const me = newUserId();
    const seeded = await seedNotification(api.prisma, { organizationId: org, userId: me });

    await post(`/v1/notifications/${seeded.id}/read`, userToken(me, org)).expect(200);

    const [event] = await eventsFor(org);
    expect(event.row.organizationId).toBe(org);
    expect(event.row.publishedAt).toBeNull();
  });

  // The payload carries identifiers and not content. An event log is read and
  // retained by every service; the title and body of somebody's notification
  // have no consumer there and every reason not to be copied into it.
  it('carries no notification content', async () => {
    const org = organization();
    const me = newUserId();
    const seeded = await seedNotification(api.prisma, {
      organizationId: org,
      userId: me,
      title: 'SENTINEL-TITLE',
      body: 'SENTINEL-BODY',
    });

    await post(`/v1/notifications/${seeded.id}/read`, userToken(me, org)).expect(200);

    const [event] = await eventsFor(org);
    const text = JSON.stringify(event.row.payload);
    expect(text).not.toContain('SENTINEL-TITLE');
    expect(text).not.toContain('SENTINEL-BODY');
  });

  /**
   * The invariant, and the reason this file needs a database.
   *
   * A notification belonging to someone else is a 404, and the transaction
   * behind it must leave nothing: no row moved, and no event announcing a move
   * that did not happen. An event with no state change is worse than a missing
   * one — a false record is harder to detect than an absent one.
   */
  it('writes no event when the caller does not own the notification', async () => {
    const org = organization();
    const owner = newUserId();
    const stranger = newUserId();
    const seeded = await seedNotification(api.prisma, { organizationId: org, userId: owner });

    await post(`/v1/notifications/${seeded.id}/read`, userToken(stranger, org)).expect(404);

    expect(await eventsFor(org)).toEqual([]);
  });
});
