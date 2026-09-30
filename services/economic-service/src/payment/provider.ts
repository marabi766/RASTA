/**
 * The payment provider boundary (ADR-024, docs/10 § 10.6).
 *
 * **CONSTRAINT, quoted from the product document:** "اجرای واقعی کیف پول،
 * پرداخت الکترونیکی، نگهداری وجوه یا تسویه مالی، مشروط به بررسی و تأیید
 * الزامات بانکی، پرداختی، مالیاتی و مقرراتی مربوط است."
 *
 * So this file describes a boundary the domain talks to, and the only
 * implementation behind it in this MVP is simulated. The domain core knows
 * this interface and nothing else: adding a real provider is a new class and a
 * configuration value, with no change to the ledger, the wallet or the
 * transaction lifecycle.
 *
 * ## What `simulated` is doing on every result
 *
 * It is not a debug flag. ADR-024 forbids any claim of a real bank connection
 * "در کد، UI، مستند، Demo یا ارائه", and silence is a claim: a response that
 * looks exactly like a real payment *is* an implicit assertion that it was
 * one. Carrying the fact explicitly — through the result, onto the row, onto
 * the event, and out of the API — makes the honest statement the default and
 * the dishonest one impossible to reach by accident.
 */

export interface AuthorizeRequest {
  /** The payment intent this attempt belongs to. */
  paymentIntentId: string;
  organizationId: string;
  amountMinor: bigint;
  currency: string;
  /** Passed through to the provider for its own deduplication. */
  idempotencyKey: string;
  /**
   * Opaque instruction to the provider.
   *
   * The mock reads a small set of test directives from it (see
   * `mock.provider.ts`). A real provider would carry a tokenised instrument
   * reference here — **never** a card number or an account number, which must
   * not enter this process at all (AGENTS.md S-09).
   */
  instrument?: string;
}

export interface AuthorizeResult {
  outcome: 'AUTHORIZED' | 'FAILED';
  /** The provider's own reference. Opaque to the domain. */
  providerReference: string;
  /**
   * A provider failure *code*, never a provider message.
   *
   * A message can carry a masked instrument or an account reference, and this
   * value is stored, logged and published.
   */
  failureCode?: string;
  simulated: boolean;
}

export interface CaptureRequest {
  paymentIntentId: string;
  providerReference: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
}

export interface CaptureResult {
  outcome: 'CAPTURED' | 'FAILED';
  providerReference: string;
  failureCode?: string;
  simulated: boolean;
}

export interface RefundRequest {
  paymentIntentId: string;
  providerReference: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
  reason: string;
}

export interface RefundResult {
  outcome: 'REFUNDED' | 'FAILED';
  providerReference: string;
  failureCode?: string;
  simulated: boolean;
}

export type ProviderPaymentStatus =
  'UNKNOWN' | 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED';

/**
 * Which refund attempt the reconciler is asking about (ADR-064 step B2).
 *
 * An attempt is a (reference, idempotency key) pair: `<key>:refund` for an
 * operator refund, `<key>:uncredited` for the refund of a capture the ledger
 * could not credit. Two keys of one reference are two attempts.
 */
export interface RefundStatusQuery {
  paymentIntentId: string;
  providerReference: string;
  idempotencyKey: string;
  /**
   * When this platform asked for the refund, where it knows: the refund
   * hold's `placed_at`, or the intent's `authorized_at` for an uncredited
   * capture. A real adapter ignores it; the mock uses it to decide whether it
   * can vouch for having never seen the attempt.
   */
  requestedAt?: Date;
}

/**
 * The provider's own record of one refund attempt.
 *
 * `NOT_FOUND` means the provider never received the attempt. It is acted on
 * **only** when `authoritative` is true — the provider vouches for it — and is
 * otherwise no better than `UNKNOWN`. Never assume.
 */
export interface RefundStatusResult {
  refund: 'REFUNDED' | 'DECLINED' | 'NOT_FOUND' | 'UNKNOWN';
  authoritative: boolean;
  /** For `DECLINED`: a code, never a message (S-09). */
  failureCode?: string;
  simulated: boolean;
}

/**
 * The interface ADR-024 specifies, with one addition: `getRefundStatus`
 * (ADR-064 § 3, scoped to refunds), which the reconciler asks before it
 * resolves an unknown refund.
 */
export interface PaymentProvider {
  readonly name: string;
  /**
   * Whether this provider moves real money.
   *
   * Part of the interface rather than a property of one implementation,
   * because every caller must be able to answer the question without knowing
   * which implementation it holds.
   */
  readonly simulated: boolean;

  authorize(request: AuthorizeRequest): Promise<AuthorizeResult>;
  capture(request: CaptureRequest): Promise<CaptureResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
  getStatus(providerReference: string): Promise<ProviderPaymentStatus>;
  getRefundStatus(query: RefundStatusQuery): Promise<RefundStatusResult>;
}
