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
import { MailWorker } from '../src/channels/mail.worker';
import { SmtpMailChannel } from '../src/channels/smtp.mail.channel';
import { seedEmailTemplates } from '../src/channels/template.seeder';
import { templateReader } from '../src/channels/template.reader';
import { EventPublisher } from '../src/events/publisher';
import type { NotificationEnv } from '../src/config/env';

/**
 * NTF-004 end to end: an event becomes a message a mail server accepted, and
 * the row says so.
 *
 * Everything here is real except the recipient directory: a real PostgreSQL
 * with this service's migrations, the real dispatch transaction, the real
 * claim, the real SMTP adapter, and a real Mailpit that the assertions read
 * through its own HTTP API. That last part is the point. The interesting
 * failures of an email channel are all *on the wire* — a header that split, a
 * subject that arrived mangled, a recipient nobody asked for — and none of
 * them is visible to a test that stubs the transport.
 *
 * ## Why it skips rather than fails without Mailpit
 *
 * `docker-compose.yml` puts Mailpit behind the `tools`/`all` profiles, so
 * `pnpm infra:up` does not start it. A suite that failed without it would be
 * red on a correct default stack.
 */

const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const SMTP_HOST = process.env.NOTIFICATION_SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.NOTIFICATION_SMTP_PORT ?? 1025);

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Bcc: { Address: string }[];
  From: { Address: string };
}

async function mailpitReachable(): Promise<boolean> {
  try {
    return (await fetch(`${MAILPIT_API}/api/v1/messages?limit=1`)).ok;
  } catch {
    return false;
  }
}

async function findMessage(to: string): Promise<MailpitSummary | undefined> {
  const response = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(to)}`);
  if (!response.ok) return undefined;
  const body = (await response.json()) as { messages?: MailpitSummary[] };
  return body.messages?.[0];
}

async function bodyOf(id: string): Promise<{ html: string; text: string }> {
  const response = await fetch(`${MAILPIT_API}/api/v1/message/${id}`);
  const body = (await response.json()) as { HTML?: string; Text?: string };
  return { html: body.HTML ?? '', text: body.Text ?? '' };
}

function channelAt(port: number): SmtpMailChannel {
  return new SmtpMailChannel({
    host: SMTP_HOST,
    port,
    secure: false,
    user: null,
    password: null,
    fromAddress: 'notifications@rasta.invalid',
    fromName: 'رستا',
    timeoutMs: 5_000,
    deliversToRealRecipients: false,
  });
}

const mailOptions = {
  pollIntervalMs: 60_000,
  batchSize: 10,
  leaseSeconds: 60,
  backoffMaxSeconds: 600,
  owner: 'notification-service@itest-mail',
};

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe('an email that actually leaves the platform', () => {
  let w: Wiring;
  let available = false;
  const organizations: string[] = [];

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();
    // The catalogue has to be published before anything can render from it —
    // the same call `AppModule.onModuleInit` makes, for the same reason.
    await seedEmailTemplates(w.prisma.client);
    available = await mailpitReachable();
    if (!available) {
      console.warn(
        `Mailpit is not reachable at ${MAILPIT_API}; skipping. ` +
          'Start it with: docker compose --profile tools up -d mailpit',
      );
    }
  }, 120_000);

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  }, 120_000);

  function mailWorker(port = SMTP_PORT): MailWorker {
    const publisher = new EventPublisher({ SERVICE_VERSION: '0.1.0' } as NotificationEnv);
    return new MailWorker(
      w.repository,
      channelAt(port),
      publisher,
      templateReader(w.prisma),
      mailOptions,
      silent as never,
    );
  }

  /** One notification, resolved and dispatched, leaving a queued email behind. */
  async function queueOne(
    organizationId: string,
    recipient: { userId: string; email: string | null },
  ): Promise<void> {
    w.recipients.answers.set(organizationId, [
      { userId: recipient.userId, role: 'FLEET_MANAGER', email: recipient.email },
    ]);
    await deliver(
      w,
      insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 7 }),
    );
    await w.worker.tick();
  }

  const deliveriesFor = (organizationId: string, channel: 'EMAIL' | 'IN_APP') =>
    runUnscoped('a test reading its own run rows', () =>
      w.prisma.client.notificationDelivery.findMany({
        where: { organizationId, channel },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const attemptsFor = (organizationId: string) =>
    runUnscoped('a test reading its own run rows', () =>
      w.prisma.client.deliveryAttempt.findMany({
        where: { organizationId },
        orderBy: { attemptNo: 'asc' },
      }),
    );

  const outboxFor = (organizationId: string) =>
    runUnscoped('a test reading the outbox it just caused', () =>
      w.prisma.client.outboxMessage.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('sends the queued message, records it, and announces it once', async () => {
    if (!available) return;
    const org = organization();
    const user = newUserId();
    const address = `${user.toLowerCase()}@example.invalid`;

    await queueOne(org, { userId: user, email: address });
    expect((await deliveriesFor(org, 'EMAIL'))[0]).toMatchObject({ status: 'QUEUED' });

    await expect(mailWorker().tick()).resolves.toBe(1);

    // 1 — the row.
    const [delivery] = await deliveriesFor(org, 'EMAIL');
    expect(delivery).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
      lastErrorClass: null,
      nextAttemptAt: null,
      claimToken: null,
    });
    expect(delivery!.sentAt).not.toBeNull();
    // What was sent is answerable, without the message being kept.
    expect(delivery!.renderedHash).toMatch(/^[0-9a-f]{64}$/);

    // 2 — the attempt, appended and never rewritten.
    const attempts = (await attemptsFor(org)).filter((row) => row.deliveryId === delivery!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, outcome: 'SUCCESS', errorClass: null });

    // 3 — the event, in the same transaction as the row.
    const events = (await outboxFor(org)).filter((row) => row.eventName === 'NOTIFICATION_SENT');
    expect(events).toHaveLength(1);
    expect(events[0]!.partitionKey).toBe(user);
    // The column holds the whole envelope; the domain payload is inside it,
    // the same way `audit-events.int-spec.ts` reads one.
    const payload = (events[0]!.payload as { payload: Record<string, unknown> }).payload;
    expect(payload.deliveryId).toBe(delivery!.id);
    expect(payload.renderedHash).toBe(delivery!.renderedHash);
    // The address is not in the log every service reads.
    expect(JSON.stringify(payload)).not.toContain('@example.invalid');

    // 4 — and a server really took it.
    const message = await findMessage(address);
    expect(message).toBeDefined();
    expect(message!.To.map((entry) => entry.Address)).toEqual([address]);
    expect(message!.Bcc).toHaveLength(0);
    expect(message!.From.Address).toBe('notifications@rasta.invalid');
  }, 120_000);

  it('arrives Persian, right-to-left, with Persian digits and a Jalali date', async () => {
    if (!available) return;
    const org = organization();
    const user = newUserId();
    const address = `${user.toLowerCase()}@example.invalid`;

    await queueOne(org, { userId: user, email: address });
    await mailWorker().tick();

    const message = await findMessage(address);
    expect(message).toBeDefined();
    // The subject survives the wire byte for byte, Persian digits included.
    expect(message!.Subject).toContain('بیمه‌نامهٔ دستگاه');
    expect(message!.Subject).toContain('۷');
    expect(message!.Subject).not.toMatch(/\b7\b/);

    const { html, text } = await bodyOf(message!.ID);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa-IR"');
    // A date is shown on the calendar the recipient reads.
    expect(text).toMatch(/[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/);
    // And the identifier is not converted: it is read back to a human.
    expect(text).toContain('AST_');
  }, 120_000);

  it('retries a server that is not there, and says nothing until it gives up', async () => {
    if (!available) return;
    const org = organization();
    const user = newUserId();

    await queueOne(org, { userId: user, email: `${user.toLowerCase()}@example.invalid` });
    // Port 1 is reserved and nothing listens on it: a real connection failure,
    // not a simulated one.
    await mailWorker(1).tick();

    const [delivery] = await deliveriesFor(org, 'EMAIL');
    expect(delivery).toMatchObject({
      status: 'QUEUED',
      attemptCount: 1,
      lastErrorClass: 'CONNECTION_FAILED',
    });
    expect(delivery!.nextAttemptAt).not.toBeNull();
    expect(delivery!.sentAt).toBeNull();

    const attempts = (await attemptsFor(org)).filter((row) => row.deliveryId === delivery!.id);
    expect(attempts[0]).toMatchObject({
      outcome: 'TRANSIENT_FAILURE',
      errorClass: 'CONNECTION_FAILED',
    });

    // Nothing is announced while a retry is still owed.
    const events = (await outboxFor(org)).filter((row) =>
      row.eventName.startsWith('NOTIFICATION_'),
    );
    expect(events).toHaveLength(0);
  }, 120_000);

  it('declares a delivery dead once the ladder is spent, and announces that once', async () => {
    if (!available) return;
    const org = organization();
    const user = newUserId();

    await queueOne(org, { userId: user, email: `${user.toLowerCase()}@example.invalid` });
    // Stand the row at its last attempt rather than waiting out five backoffs.
    await runUnscoped('the test advances a delivery to its final attempt', () =>
      w.prisma.client.notificationDelivery.updateMany({
        where: { organizationId: org, channel: 'EMAIL' },
        data: { attemptCount: 5 },
      }),
    );

    await mailWorker(1).tick();

    const [delivery] = await deliveriesFor(org, 'EMAIL');
    expect(delivery).toMatchObject({
      status: 'DEAD',
      attemptCount: 6,
      lastErrorClass: 'CONNECTION_FAILED',
      nextAttemptAt: null,
    });

    const events = (await outboxFor(org)).filter((row) => row.eventName === 'NOTIFICATION_FAILED');
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { payload: Record<string, unknown> }).payload).toMatchObject({
      finalStatus: 'DEAD',
      attempts: 6,
      errorClass: 'CONNECTION_FAILED',
    });
  }, 120_000);

  it('holds a message inside a quiet window and sends nothing', async () => {
    if (!available) return;
    const org = organization();
    const user = newUserId();
    const address = `${user.toLowerCase()}@example.invalid`;

    await queueOne(org, { userId: user, email: address });
    // A window covering the whole day, so the test does not depend on when it
    // runs. Written directly, the way the API writes it.
    await runUnscoped('the test stores a quiet window the way the API does', () =>
      w.prisma.client.notificationQuietHours.create({
        data: {
          organizationId: org,
          userId: user,
          startMinute: 0,
          endMinute: 1439,
          timezone: 'Asia/Tehran',
          updatedBy: user,
        },
      }),
    );

    await mailWorker().tick();

    const [delivery] = await deliveriesFor(org, 'EMAIL');
    // Deferred, not attempted: a night must not spend a rung of the retry
    // ladder.
    expect(delivery).toMatchObject({ status: 'QUEUED', attemptCount: 0 });
    expect(delivery!.scheduledFor).not.toBeNull();
    expect((await attemptsFor(org)).filter((row) => row.deliveryId === delivery!.id)).toHaveLength(
      0,
    );
    expect(await findMessage(address)).toBeUndefined();
  }, 120_000);

  it('refuses to publish a template version whose text changed under its number', async () => {
    if (!available) return;
    // The failure the seeder exists to cause. A delivery cites
    // `(templateKey, version)`; two texts under one number make every past
    // delivery unanswerable, silently and permanently.
    await expect(
      seedEmailTemplates(w.prisma.client, [
        {
          key: 'insurance.expiring.email',
          version: 1,
          locale: 'fa-IR',
          subject: 'something else entirely',
          body: 'and a different body',
          variables: [{ name: 'assetId', format: 'TEXT' }],
        },
      ]),
    ).rejects.toThrow(/immutable|already published/i);
  }, 120_000);
});
