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

/** The interface ADR-024 specifies, unchanged. */
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
}
