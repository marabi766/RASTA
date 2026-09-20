import { SmtpMailChannel } from '../src/channels/smtp.mail.channel';
import type { MailMessage } from '../src/channels/mail.channel.port';

/**
 * The SMTP adapter against a real server (ADR-054 § 6, `docs/24` Q-37).
 *
 * Mailpit, over a real socket, asserted through Mailpit's own HTTP API rather
 * than through the adapter's return value. That is the whole point of this
 * file: a stubbed transport proves the stub was called, and the failures that
 * matter here — a header that split, a subject that arrived mangled, a second
 * recipient nobody asked for — are all *on the wire*, where only a real server
 * can see them.
 *
 * ## It runs against a server that delivers nothing
 *
 * Mailpit accepts everything and forwards nothing, which is exactly why it is
 * safe to point tests at it and exactly why it must never be mistaken for
 * delivery. The adapter reports `deliversToRealRecipients: false`, and this
 * suite asserts that too — if that flag were ever wrong, these tests would be
 * mailing strangers.
 *
 * ## Why it skips instead of failing
 *
 * `docker-compose.yml` puts Mailpit behind the `tools`/`all` profiles, so
 * `pnpm infra:up` does not start it. A suite that failed without it would be
 * red on a correct default stack. It skips visibly, and says how to start it.
 */

const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const SMTP_HOST = process.env.NOTIFICATION_SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.NOTIFICATION_SMTP_PORT ?? 1025);

function channel(): SmtpMailChannel {
  return new SmtpMailChannel({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    user: null,
    password: null,
    fromAddress: 'notifications@rasta.invalid',
    fromName: 'رستا',
    timeoutMs: 5_000,
    deliversToRealRecipients: false,
  });
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Bcc: { Address: string }[];
  From: { Address: string; Name: string };
}

async function mailpitReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${MAILPIT_API}/api/v1/messages?limit=1`);
    return response.ok;
  } catch {
    return false;
  }
}

/** Every message Mailpit holds whose subject contains the marker. */
async function findBySubject(marker: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(marker)}&limit=50`,
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { messages?: MailpitMessage[] };
  return body.messages ?? [];
}

const marker = () => `NTFQ37${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

describe('the SMTP mail channel against a real server', () => {
  let available = false;

  beforeAll(async () => {
    available = await mailpitReachable();
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(
        `Mailpit is not reachable at ${MAILPIT_API}; skipping. Start it with ` +
          '`docker compose --profile tools up -d mailpit`.',
      );
    }
  }, 30_000);

  afterAll(async () => {
    await channel().onModuleDestroy();
  });

  const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
    to: 'recipient@example.invalid',
    subject: `بیمهٔ خودرو رو به انقضاست ${marker()}`,
    html: '<p dir="rtl" lang="fa-IR">بیمهٔ خودروی شما تا ۷ روز دیگر منقضی می‌شود.</p>',
    text: 'بیمهٔ خودروی شما تا ۷ روز دیگر منقضی می‌شود.',
    ...overrides,
  });

  it('reports itself reachable, and reports that it reaches nobody real', async () => {
    if (!available) return;
    const mail = channel();

    const health = await mail.health();

    expect(health.available).toBe(true);
    expect(health.channel).toBe('smtp');
    // The assertion this whole story rests on. If it ever reads `true` against
    // Mailpit, something has been wired to a relay by mistake.
    expect(health.deliversToRealRecipients).toBe(false);
    expect(health.detail).toBeNull();

    await mail.onModuleDestroy();
  });

  it('delivers a Persian message intact, subject and body', async () => {
    if (!available) return;
    const mail = channel();
    const tag = marker();
    const subject = `بیمهٔ خودرو رو به انقضاست ${tag}`;

    const result = await mail.send(message({ subject }));

    expect(result.outcome).toBe('SENT');
    expect(result.failureReason).toBeNull();
    expect(result.channel).toBe('smtp');

    const [delivered] = await findBySubject(tag);
    expect(delivered).toBeDefined();
    // Asserted on what the server received, not on what we passed in: a
    // subject that is mangled by MIME encoding is mangled for the reader, and
    // Persian subjects are exactly the case that goes wrong silently.
    expect(delivered.Subject).toBe(subject);
    expect(delivered.From.Address).toBe('notifications@rasta.invalid');

    await mail.onModuleDestroy();
  });

  it('strips a header injection out of the subject instead of sending it', async () => {
    if (!available) return;
    const mail = channel();
    const tag = marker();

    const result = await mail.send(
      message({ subject: `اعلان ${tag}\r\nBcc: victim@example.invalid` }),
    );

    expect(result.outcome).toBe('SENT');

    const [delivered] = await findBySubject(tag);
    expect(delivered).toBeDefined();
    // The two claims that matter, and the second is the one a unit test cannot
    // make: the header did not split, so the injected address is not a
    // recipient of anything.
    expect(delivered.Subject).not.toContain('\n');
    expect(delivered.Subject).toContain('Bcc: victim@example.invalid');
    expect(delivered.Bcc ?? []).toHaveLength(0);
    expect(delivered.To.map((address) => address.Address)).toEqual(['recipient@example.invalid']);

    await mail.onModuleDestroy();
  });

  it('refuses an injected recipient before opening a socket', async () => {
    if (!available) return;
    const mail = channel();
    const tag = marker();

    const result = await mail.send(
      message({
        to: 'recipient@example.invalid\r\nBcc: victim@example.invalid',
        subject: `اعلان ${tag}`,
      }),
    );

    expect(result.outcome).toBe('PERMANENT_FAILURE');
    expect(result.failureReason).toBe('INVALID_MESSAGE');
    // Nothing was sent at all — not a stripped version, not a partial one.
    expect(await findBySubject(tag)).toHaveLength(0);

    await mail.onModuleDestroy();
  });

  it('classifies an unreachable server as transient rather than losing the message', async () => {
    const unreachable = new SmtpMailChannel({
      host: '127.0.0.1',
      // A port nothing listens on. The failure has to be "try again", because
      // a server that is down is the textbook case for a retry and treating it
      // as permanent discards a notification nobody decided to discard.
      port: 1,
      secure: false,
      user: null,
      password: null,
      fromAddress: 'notifications@rasta.invalid',
      fromName: 'رستا',
      timeoutMs: 2_000,
      deliversToRealRecipients: false,
    });

    const result = await unreachable.send(message());

    expect(result.outcome).toBe('TRANSIENT_FAILURE');
    expect(result.failureReason).toBe('CONNECTION_FAILED');

    const health = await unreachable.health();
    expect(health.available).toBe(false);
    // A reason code, never the thrown message: that string carries the host
    // and port, and this value reaches a readiness probe.
    expect(health.detail).toBe('CONNECTION_FAILED');

    await unreachable.onModuleDestroy();
  }, 30_000);
});
