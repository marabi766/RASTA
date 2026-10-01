import type {
  AuthorizeRequest,
  AuthorizeResult,
  CaptureRequest,
  CaptureResult,
  PaymentProvider,
  ProviderPaymentStatus,
  RefundRequest,
  RefundResult,
  RefundStatusQuery,
  RefundStatusResult,
} from './provider';

/** The closed code a provider call past its deadline fails with. */
export const PROVIDER_TIMEOUT = 'PROVIDER_TIMEOUT';

/** A provider call that did not answer in time: an unknown outcome, never a refusal. */
export class ProviderCallTimeout extends Error {
  readonly code = PROVIDER_TIMEOUT;

  constructor(operation: string, timeoutMs: number) {
    super(`The payment provider did not answer ${operation} within ${timeoutMs}ms`);
    this.name = 'ProviderCallTimeout';
  }
}

/**
 * Puts a deadline on the **refund-side** provider calls (ADR-064 step B2):
 * `refund` and `getRefundStatus`.
 *
 * A call past its deadline is an **unknown** outcome: the provider may still
 * act on it. On the refund side that is recovered — B0's markers hold the
 * money and the reconciler asks what happened — and the grace period has to
 * be longer than the longest call (`ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS`
 * > 2 × `ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS`, checked at boot).
 *
 * `authorize`, `capture` and `getStatus` pass through **without** a deadline
 * (Codex on #164, HIGH 1; PM ruling). A timed-out authorize left the intent
 * CREATED while the provider authorized it anyway, nothing recovered it, and
 * its amount kept reserving the wallet's headroom. They get a deadline when
 * step C builds recovery for stuck top-ups. The timer is cleared as soon as
 * the call settles.
 */
export class TimedPaymentProvider implements PaymentProvider {
  readonly name: string;
  readonly simulated: boolean;
  readonly authoritativeAbsence: boolean;

  constructor(
    private readonly inner: PaymentProvider,
    private readonly timeoutMs: number,
  ) {
    this.name = inner.name;
    this.simulated = inner.simulated;
    this.authoritativeAbsence = inner.authoritativeAbsence;
  }

  /** No deadline until step C can recover a timed-out top-up. */
  authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    return this.inner.authorize(request);
  }

  /** No deadline until step C can recover a timed-out top-up. */
  capture(request: CaptureRequest): Promise<CaptureResult> {
    return this.inner.capture(request);
  }

  refund(request: RefundRequest): Promise<RefundResult> {
    return this.within('refund', () => this.inner.refund(request));
  }

  /** Step C's question; no deadline yet, as nothing asks it. */
  getStatus(providerReference: string): Promise<ProviderPaymentStatus> {
    return this.inner.getStatus(providerReference);
  }

  getRefundStatus(query: RefundStatusQuery): Promise<RefundStatusResult> {
    return this.within('getRefundStatus', () => this.inner.getRefundStatus(query));
  }

  private within<T>(operation: string, call: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ProviderCallTimeout(operation, this.timeoutMs)),
        this.timeoutMs,
      );
    });
    return Promise.race([call(), deadline]).finally(() => clearTimeout(timer));
  }
}
