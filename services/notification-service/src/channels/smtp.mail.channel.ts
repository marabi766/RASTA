import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type {
  MailChannel,
  MailChannelHealth,
  MailFailureReason,
  MailMessage,
  MailSendResult,
} from './mail.channel.port';

export interface SmtpMailChannelOptions {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS on connect. False for Mailpit, true for a submission port. */
  readonly secure: boolean;
  readonly user: string | null;
  readonly password: string | null;
  /** The envelope and header sender, as configuration states it. */
  readonly fromAddress: string;
  readonly fromName: string;
  readonly timeoutMs: number;
  /**
   * Whether this deployment's server delivers onward to real mailboxes.
   *
   * Configuration rather than inference. The adapter cannot tell a Mailpit
   * from a relay by looking at it, and guessing wrong in the safe-sounding
   * direction is how a test run reaches somebody's inbox.
   */
  readonly deliversToRealRecipients: boolean;
}

/**
 * SMTP adapter for {@link MailChannel} — Mailpit in development (ADR-054 § 6).
 *
 * The one adapter Q-37's temporary decision allows, and it is generic SMTP on
 * purpose: no provider SDK, no provider name in the code, nothing to unpick
 * when the procurement decision lands. A provider that speaks SMTP needs only
 * configuration; one that does not needs another class bound to the same
 * token.
 *
 * ## Three things this class refuses to do
 *
 *   guess a sender    `fromAddress` is required configuration with no default.
 *                     No sender identity has been chosen (Q-37), so inventing
 *                     one here would be inventing the answer.
 *   trust a subject   `\r\n` is stripped from the subject and refused in the
 *                     recipient, before the socket opens. ADR-054 § 7 puts
 *                     this in the template layer; it is also here because this
 *                     is the last place it can be stopped, and header
 *                     injection is not a defect anybody gets to have twice.
 *   log an address    nothing in this file writes a recipient anywhere. The
 *                     shared redactor does not cover `email` (R-5), so the
 *                     rule here is simply not to produce the string.
 */
@Injectable()
export class SmtpMailChannel implements MailChannel, OnModuleDestroy {
  readonly name = 'smtp';

  private transporter?: Transporter;

  constructor(private readonly options: SmtpMailChannelOptions) {}

  get deliversToRealRecipients(): boolean {
    return this.options.deliversToRealRecipients;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const attemptedAt = new Date();

    const rejection = refuseUnsendable(message);
    if (rejection) return this.failure(rejection, attemptedAt);

    try {
      const info = await this.transport().sendMail({
        from: { name: this.options.fromName, address: this.options.fromAddress },
        to: message.to,
        // Stripped rather than rejected: a newline in a subject is far more
        // often a template that wrapped than an attack, and the safe form of
        // the message is still the message somebody is waiting for. The
        // recipient is the opposite case and is refused above — there is no
        // safe interpretation of a second address nobody asked for.
        subject: stripNewlines(message.subject),
        text: message.text,
        html: message.html,
      });

      return {
        outcome: 'SENT',
        channel: this.name,
        providerMessageId: typeof info.messageId === 'string' ? info.messageId : null,
        failureReason: null,
        attemptedAt,
      };
    } catch (error) {
      const { outcome, reason } = classify(error);
      return {
        outcome,
        channel: this.name,
        providerMessageId: null,
        failureReason: reason,
        attemptedAt,
      };
    }
  }

  /**
   * Whether the server is reachable and willing to talk.
   *
   * `verify()` opens a connection and greets; it does not send. Callers must
   * not make this a readiness failure — the development server lives behind a
   * compose profile that `pnpm infra:up` does not start, so a service that
   * refused to be ready without it would be unready on every default stack.
   */
  async health(): Promise<MailChannelHealth> {
    const base = {
      channel: this.name,
      deliversToRealRecipients: this.deliversToRealRecipients,
    };

    try {
      await this.transport().verify();
      return { ...base, available: true, detail: null };
    } catch (error) {
      // The reason code, never the thrown message: that string carries the
      // host, the port and sometimes the credentials.
      return { ...base, available: false, detail: classify(error).reason };
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.transporter?.close();
    this.transporter = undefined;
  }

  private transport(): Transporter {
    this.transporter ??= createTransport({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      auth:
        this.options.user && this.options.password
          ? { user: this.options.user, pass: this.options.password }
          : undefined,
      connectionTimeout: this.options.timeoutMs,
      greetingTimeout: this.options.timeoutMs,
      socketTimeout: this.options.timeoutMs,
    });
    return this.transporter;
  }

  private failure(reason: MailFailureReason, attemptedAt: Date): MailSendResult {
    return {
      outcome: 'PERMANENT_FAILURE',
      channel: this.name,
      providerMessageId: null,
      failureReason: reason,
      attemptedAt,
    };
  }
}

/**
 * CR and LF, the characters a header split is built from.
 *
 * Two constants for one idea, and the split is not cosmetic: a `/g` regular
 * expression carries `lastIndex` across `test()` calls, so one shared with the
 * replace below would answer `true`, then `false`, then `true` for the *same*
 * address. A stateful guard is worse than no guard — it fails on the calls
 * nobody happens to look at.
 */
const NEWLINES_GLOBAL = /[\r\n]+/g;
const HAS_NEWLINE = /[\r\n]/;

export function stripNewlines(value: string): string {
  return value.replace(NEWLINES_GLOBAL, ' ').trim();
}

/**
 * Whether this message must not be handed to a server, and why.
 *
 * Returns the reason rather than throwing, because refusing to send is an
 * outcome the caller records, not an exception it recovers from.
 */
export function refuseUnsendable(message: MailMessage): 'INVALID_MESSAGE' | null {
  const to = message.to.trim();
  if (to.length === 0) return 'INVALID_MESSAGE';
  // A newline in the recipient is a second header. A comma or a semicolon is a
  // second recipient, which this port does not have a delivery row for.
  if (HAS_NEWLINE.test(to) || /[,;]/.test(to)) return 'INVALID_MESSAGE';
  // Not a validator — the address came from a snapshot this service took from
  // identity-service, and re-deciding what an address is here would be a
  // second, disagreeing opinion. This is only the shape a server cannot be
  // asked to parse.
  if (!to.includes('@')) return 'INVALID_MESSAGE';
  if (message.subject.trim().length === 0) return 'INVALID_MESSAGE';
  return null;
}

/**
 * Maps a thrown SMTP error onto the retry decision.
 *
 * `responseCode` is the SMTP reply, which nodemailer surfaces for a server
 * that answered; `code` is its own label for a socket that did not get that
 * far. The default is **transient**, deliberately: treating an unrecognised
 * failure as permanent discards a message nobody decided to discard, while
 * treating it as transient costs a retry and a bounded backoff (ADR-054 § 7).
 */
export function classify(error: unknown): {
  outcome: 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE';
  reason: MailFailureReason;
} {
  const candidate = error as { responseCode?: number; code?: string } | null;
  const status = typeof candidate?.responseCode === 'number' ? candidate.responseCode : null;
  const code = typeof candidate?.code === 'string' ? candidate.code : null;

  if (status !== null) {
    if (status === 421 || status === 450 || status === 451 || status === 452) {
      return { outcome: 'TRANSIENT_FAILURE', reason: 'RATE_LIMITED' };
    }
    if (status === 535 || status === 530) {
      return { outcome: 'PERMANENT_FAILURE', reason: 'AUTHENTICATION_FAILED' };
    }
    if (status === 550 || status === 551 || status === 553) {
      return { outcome: 'PERMANENT_FAILURE', reason: 'RECIPIENT_REJECTED' };
    }
    if (status === 552 || status === 554) {
      return { outcome: 'PERMANENT_FAILURE', reason: 'MESSAGE_REJECTED' };
    }
    if (status >= 500) return { outcome: 'PERMANENT_FAILURE', reason: 'MESSAGE_REJECTED' };
    if (status >= 400) return { outcome: 'TRANSIENT_FAILURE', reason: 'MESSAGE_REJECTED' };
  }

  switch (code) {
    case 'EAUTH':
      return { outcome: 'PERMANENT_FAILURE', reason: 'AUTHENTICATION_FAILED' };
    case 'ETIMEDOUT':
      return { outcome: 'TRANSIENT_FAILURE', reason: 'TIMEOUT' };
    // `ESOCKET` belongs here rather than with the timeout, and the integration
    // suite is what settled it: a refused connection surfaces as `ESOCKET`,
    // not `ECONNREFUSED`, so labelling it `TIMEOUT` told an operator the
    // server was slow when it was absent. Same retry either way; different
    // thing to go and look at.
    case 'ESOCKET':
    case 'ECONNECTION':
    case 'ECONNREFUSED':
    case 'EDNS':
      return { outcome: 'TRANSIENT_FAILURE', reason: 'CONNECTION_FAILED' };
    case 'EENVELOPE':
      return { outcome: 'PERMANENT_FAILURE', reason: 'RECIPIENT_REJECTED' };
    case 'EPROTOCOL':
      return { outcome: 'TRANSIENT_FAILURE', reason: 'PROTOCOL_ERROR' };
    default:
      return { outcome: 'TRANSIENT_FAILURE', reason: 'CONNECTION_FAILED' };
  }
}
