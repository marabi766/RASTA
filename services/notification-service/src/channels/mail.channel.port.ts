/**
 * The email boundary (ADR-054 § 6, `docs/24` Q-37).
 *
 * Q-37 — "which production email provider, which sender identity, which
 * domain?" — is **not** answered by this file, and cannot be: it is a
 * procurement and data-residency decision, not an engineering one. What this
 * port does is make the question stop blocking engineering. The domain learns
 * this interface and nothing else about email, so choosing a provider later is
 * another class bound to this token, not another lifecycle.
 *
 * Same shape, and the same reason, as `PaymentProvider` (ADR-024) and
 * `MalwareScanner` (ADR-049).
 *
 * ## Why `deliversToRealRecipients` is on the interface
 *
 * Because the honest answer today is `false`, and that has to be something a
 * caller, an operator and a readiness probe can read without knowing which
 * adapter is bound. `PaymentProvider.simulated` exists for the same reason and
 * `MalwareScanner.inspectsContent` for a sharper one: the failure it prevents
 * is a system reporting that it told somebody something when it did not.
 *
 * A development adapter pointed at Mailpit accepts every message and delivers
 * none of them to a human. That is a useful thing to build against and a
 * catastrophic thing to mistake for delivery.
 */

/**
 * What became of one message.
 *
 * Three outcomes rather than a boolean, because the retry decision lives here
 * and nowhere else. ADR-054 § 7 draws the line: SMTP 4xx is the remote side
 * saying "not now", SMTP 5xx is it saying "not ever", and re-sending the
 * second is a way to turn one rejected message into five.
 */
export type MailOutcome = 'SENT' | 'TRANSIENT_FAILURE' | 'PERMANENT_FAILURE';

/**
 * Why a message did not go.
 *
 * A closed set of codes, never provider text. Three reasons, and the last is
 * the one that is easy to forget: a provider message can echo the recipient
 * address, this value is written to `delivery_attempt`, exported as a metric
 * label and shown to an operator, and a metric label drawn from free text is
 * unbounded cardinality by construction (ADR-054 § 10, R-5).
 */
export const MAIL_FAILURE_REASONS = [
  /** The server could not be reached at all. */
  'CONNECTION_FAILED',
  /** The exchange did not finish inside the configured deadline. */
  'TIMEOUT',
  /** The server refused these credentials. */
  'AUTHENTICATION_FAILED',
  /** The server refused this recipient. */
  'RECIPIENT_REJECTED',
  /** The server refused the configured sender identity. */
  'SENDER_REJECTED',
  /** The server accepted the envelope and refused the message. */
  'MESSAGE_REJECTED',
  /** The server asked for less traffic. */
  'RATE_LIMITED',
  /** The server answered, but not in the protocol it claims to speak. */
  'PROTOCOL_ERROR',
  /**
   * This service built a message the adapter will not send.
   *
   * Refused before the socket opens rather than after — a header-injection
   * attempt must never reach a server that might honour it.
   */
  'INVALID_MESSAGE',
] as const;

export type MailFailureReason = (typeof MAIL_FAILURE_REASONS)[number];

export interface MailSendResult {
  readonly outcome: MailOutcome;
  /** The adapter that produced it, so the claim is attributable. */
  readonly channel: string;
  /**
   * The server's id for the accepted message, where it gave one.
   *
   * Recorded so a delivery can be traced into somebody else's logs later.
   * Never parsed and never depended on: not every server returns one.
   */
  readonly providerMessageId: string | null;
  /** Set exactly when the outcome is not `SENT`. */
  readonly failureReason: MailFailureReason | null;
  readonly attemptedAt: Date;
}

/** One message, for one recipient. */
export interface MailMessage {
  /**
   * Exactly one address.
   *
   * Not a list, and that is deliberate. A delivery in this service is one row
   * per recipient, so a list would have no row to belong to — and a list is
   * how one template bug turns into every recipient learning who else was
   * notified.
   */
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /**
   * The plain-text alternative.
   *
   * Required rather than optional: a message with no text part is the one that
   * arrives blank in a client that will not render HTML, and "required" is the
   * only way to keep that from being an oversight in one template.
   */
  readonly text: string;
}

/**
 * What the channel reports about itself.
 *
 * Separate from sending because "the mail server is down" and "this message
 * failed" are different operational facts, and the first has to be answerable
 * before any message exists.
 */
export interface MailChannelHealth {
  readonly available: boolean;
  readonly channel: string;
  /** Restated here so a probe response carries it without a second lookup. */
  readonly deliversToRealRecipients: boolean;
  /**
   * A short, safe description when something is wrong.
   *
   * Never an exception message: those carry host names, socket paths and
   * occasionally credentials, and this value reaches a readiness probe.
   */
  readonly detail: string | null;
}

export interface MailChannel {
  readonly name: string;
  /**
   * Whether a message sent through this channel can reach a human.
   *
   * `false` for every adapter in this repository today. The one that makes it
   * `true` is the one that needs Q-37 answered first.
   */
  readonly deliversToRealRecipients: boolean;

  send(message: MailMessage): Promise<MailSendResult>;

  /** For the readiness probe. Never throws. */
  health(): Promise<MailChannelHealth>;
}
