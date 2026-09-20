import { MailWorker, MAIL_ERROR_CLASSES } from './mail.worker';
import { LeaseLostError } from '../notification/notification.repository';
import type {
  NotificationRepository,
  SendableDelivery,
} from '../notification/notification.repository';
import type { EventPublisher } from '../events/publisher';
import type { MailChannel, MailSendResult } from './mail.channel.port';
import type { EmailTemplate } from './email-render';
import type { ScrubbedLogger } from '../logging/scrub';

/**
 * The send path, exercised without a mail server.
 *
 * What is proved here is the decisions this repository makes: which failures
 * are worth another attempt, when a delivery is finally dead, what is
 * published and — as much as it matters — what is *not*. Whether a message
 * arrives is proved against a real Mailpit in `test/email-delivery.int-spec.ts`;
 * a stubbed server would only prove the stub was called.
 */

const TEMPLATE: EmailTemplate = {
  key: 'insurance.expiring.email',
  version: 1,
  locale: 'fa-IR',
  subject: 'بیمهٔ {{assetId}}',
  body: 'دستگاه {{assetId}} تا {{daysRemaining}} روز دیگر.',
  variables: [
    { name: 'assetId', format: 'TEXT' },
    { name: 'daysRemaining', format: 'NUMBER' },
  ],
};

function delivery(overrides: Partial<SendableDelivery> = {}): SendableDelivery {
  return {
    id: 'NTD_1',
    organizationId: 'ORG_A',
    userId: 'USR_1',
    intentId: 'NTI_1',
    templateKey: TEMPLATE.key,
    templateVersion: 1,
    attemptCount: 0,
    maxAttempts: 6,
    claimToken: 'token-1',
    email: 'someone@example.invalid',
    locale: 'fa-IR',
    timezone: 'Asia/Tehran',
    severity: 'WARNING',
    ruleKey: 'insurance.expiring',
    contextData: { assetId: 'AST_1', daysRemaining: 7 },
    correlationId: 'COR_1',
    ...overrides,
  };
}

type Settled = Parameters<NotificationRepository['settleAttempt']>[0];

function fakeRepository(options: { quiet?: boolean; leaseLost?: boolean } = {}) {
  const settled: Settled[] = [];
  const released: { at: Date }[] = [];
  const published: { eventName: string; payload: Record<string, unknown> }[] = [];

  const publisher = {
    enqueue: jest.fn(async (_tx: unknown, input: { eventName: string; payload: unknown }) => {
      published.push({
        eventName: input.eventName,
        payload: input.payload as Record<string, unknown>,
      });
      return 'OBX_1';
    }),
  } as unknown as EventPublisher;

  const repository = {
    claimSendable: jest.fn(async () => []),
    quietWindowFor: jest.fn(async () =>
      options.quiet ? { startMinute: 0, endMinute: 24 * 60 - 1, timezone: 'Asia/Tehran' } : null,
    ),
    releaseUntil: jest.fn(async (_d: unknown, at: Date) => {
      released.push({ at });
      return true;
    }),
    settleAttempt: jest.fn(async (input: Settled) => {
      settled.push(input);
      if (options.leaseLost) throw new LeaseLostError(input.delivery.id);
      // The real one runs `publish` inside its transaction; the fake runs it
      // in the same order so an event the worker never passes stays absent.
      if (input.publish) await input.publish({} as never);
      if (input.outcome === 'SUCCESS') return 'SENT' as const;
      if (input.outcome === 'PERMANENT_FAILURE') return 'FAILED' as const;
      return input.delivery.attemptCount + 1 >= input.delivery.maxAttempts
        ? ('DEAD' as const)
        : ('RETRY' as const);
    }),
  } as unknown as NotificationRepository;

  return { repository, publisher, settled, released, published };
}

function fakeMail(result: Partial<MailSendResult>) {
  const sent: { to: string; subject: string }[] = [];
  const channel = {
    send: jest.fn(async (message: { to: string; subject: string }) => {
      sent.push({ to: message.to, subject: message.subject });
      return {
        outcome: 'SENT',
        channel: 'smtp',
        providerMessageId: null,
        failureReason: null,
        attemptedAt: new Date(),
        ...result,
      } as MailSendResult;
    }),
    health: jest.fn(),
  } as unknown as MailChannel;
  return { channel, sent };
}

const silent = (): ScrubbedLogger =>
  ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }) as unknown as ScrubbedLogger;

const options = {
  pollIntervalMs: 1_000,
  batchSize: 10,
  leaseSeconds: 120,
  backoffMaxSeconds: 600,
  owner: 'test',
};

function worker(
  repo: ReturnType<typeof fakeRepository>,
  mail: ReturnType<typeof fakeMail>,
  template: EmailTemplate | null = TEMPLATE,
): MailWorker {
  return new MailWorker(
    repo.repository,
    mail.channel,
    repo.publisher,
    async () => template,
    options,
    silent(),
  );
}

describe('a message that is accepted', () => {
  it('records one successful attempt and announces it', async () => {
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'SENT' });

    await worker(repo, mail).sendOne(delivery());

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe('someone@example.invalid');
    expect(repo.settled[0]!.outcome).toBe('SUCCESS');
    expect(repo.settled[0]!.nextAttemptAt).toBeNull();

    expect(repo.published).toHaveLength(1);
    expect(repo.published[0]!.eventName).toBe('NOTIFICATION_SENT');
    expect(repo.published[0]!.payload.renderedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('puts no address and no message text in the event', async () => {
    // `docs/07` § 7.3 — carry an identifier, not personal data. The event log
    // is read by every service that subscribes; a subject line in it spreads a
    // tenant's operational detail further than any consumer needs.
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'SENT' });

    await worker(repo, mail).sendOne(delivery());

    const serialised = JSON.stringify(repo.published[0]!.payload);
    expect(serialised).not.toContain('example.invalid');
    expect(serialised).not.toContain('بیمهٔ');
    expect(serialised).not.toContain('AST_1');
  });
});

describe('which failures are worth another attempt', () => {
  it('schedules a retry on a transient failure and announces nothing', async () => {
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'TRANSIENT_FAILURE', failureReason: 'CONNECTION_FAILED' });
    const started = Date.now();

    await worker(repo, mail).sendOne(delivery({ attemptCount: 0 }));

    expect(repo.settled[0]!.outcome).toBe('TRANSIENT_FAILURE');
    expect(repo.settled[0]!.errorClass).toBe('CONNECTION_FAILED');
    // First rung of the ladder is 1s, jittered to [0.5s, 1s].
    const wait = (repo.settled[0]!.nextAttemptAt as Date).getTime() - started;
    expect(wait).toBeGreaterThanOrEqual(500 - 50);
    expect(wait).toBeLessThanOrEqual(1_000 + 50);
    // A server that is briefly away must not fill the audit log with events
    // about a message that arrives five minutes later.
    expect(repo.published).toHaveLength(0);
  });

  it('climbs the ladder with the attempts', async () => {
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'TRANSIENT_FAILURE', failureReason: 'TIMEOUT' });
    const started = Date.now();

    // Three attempts already spent → the fourth wait is the 2m rung.
    await worker(repo, mail).sendOne(delivery({ attemptCount: 3 }));

    const wait = (repo.settled[0]!.nextAttemptAt as Date).getTime() - started;
    expect(wait).toBeGreaterThanOrEqual(60_000 - 50);
    expect(wait).toBeLessThanOrEqual(120_000 + 50);
  });

  it('stops at the end of the ladder and says so once', async () => {
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'TRANSIENT_FAILURE', failureReason: 'RATE_LIMITED' });

    // Five attempts spent, six allowed: this is the last one.
    await worker(repo, mail).sendOne(delivery({ attemptCount: 5 }));

    expect(repo.settled[0]!.nextAttemptAt).toBeNull();
    expect(repo.published).toHaveLength(1);
    expect(repo.published[0]!.eventName).toBe('NOTIFICATION_FAILED');
    expect(repo.published[0]!.payload.finalStatus).toBe('DEAD');
    expect(repo.published[0]!.payload.attempts).toBe(6);
    expect(repo.published[0]!.payload.errorClass).toBe('RATE_LIMITED');
  });

  it('gives up immediately on a permanent refusal', async () => {
    // 5xx is "not ever". Re-sending turns one rejected message into six, and
    // a mailbox that does not exist will not exist in ten minutes.
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'PERMANENT_FAILURE', failureReason: 'RECIPIENT_REJECTED' });

    await worker(repo, mail).sendOne(delivery({ attemptCount: 0 }));

    expect(repo.settled[0]!.outcome).toBe('PERMANENT_FAILURE');
    expect(repo.settled[0]!.nextAttemptAt).toBeNull();
    expect(repo.published[0]!.payload.finalStatus).toBe('FAILED');
    expect(repo.published[0]!.payload.attempts).toBe(1);
  });
});

describe('what is refused before a socket is opened', () => {
  it('fails permanently when the template cannot render', async () => {
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'SENT' });

    // `daysRemaining` is declared and absent: a blank would travel to a person.
    await worker(repo, mail).sendOne(delivery({ contextData: { assetId: 'AST_1' } }));

    expect(mail.sent).toHaveLength(0);
    expect(repo.settled[0]!.outcome).toBe('PERMANENT_FAILURE');
    expect(repo.settled[0]!.errorClass).toBe(MAIL_ERROR_CLASSES.RENDER_FAILED);
  });

  it('fails permanently when no published version exists', async () => {
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'SENT' });

    await worker(repo, mail, null).sendOne(delivery());

    expect(mail.sent).toHaveLength(0);
    expect(repo.settled[0]!.errorClass).toBe(MAIL_ERROR_CLASSES.TEMPLATE_MISSING);
  });

  it('fails permanently when the snapshot has no address', async () => {
    const repo = fakeRepository();
    const mail = fakeMail({ outcome: 'SENT' });

    await worker(repo, mail).sendOne(delivery({ email: null }));

    expect(mail.sent).toHaveLength(0);
    expect(repo.settled[0]!.errorClass).toBe(MAIL_ERROR_CLASSES.NO_ADDRESS);
  });
});

describe('quiet hours are re-checked at the moment of sending', () => {
  it('defers without recording an attempt', async () => {
    // A deferral is not a failure. Recording one would spend a rung of the
    // retry ladder on somebody being asleep, and six nights would kill a
    // delivery nobody ever tried to send.
    const repo = fakeRepository({ quiet: true });
    const mail = fakeMail({ outcome: 'SENT' });

    await worker(repo, mail).sendOne(delivery());

    expect(mail.sent).toHaveLength(0);
    expect(repo.settled).toHaveLength(0);
    expect(repo.released).toHaveLength(1);
  });

  it('sends a CRITICAL notification inside the window anyway', async () => {
    const repo = fakeRepository({ quiet: true });
    const mail = fakeMail({ outcome: 'SENT' });

    await worker(repo, mail).sendOne(delivery({ severity: 'CRITICAL' }));

    expect(mail.sent).toHaveLength(1);
    expect(repo.released).toHaveLength(0);
  });
});

describe('a lease taken over mid-send', () => {
  it("is somebody else's work, not an error", async () => {
    // The message may well have been sent. The attempt is still not recorded:
    // an attempt written by a worker that no longer owns the row is a second
    // opinion in an append-only table.
    const repo = fakeRepository({ leaseLost: true });
    const mail = fakeMail({ outcome: 'SENT' });

    await expect(worker(repo, mail).sendOne(delivery())).resolves.toBeUndefined();
  });
});
