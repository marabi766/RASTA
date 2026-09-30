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
 * Puts a deadline on every call to the provider it wraps (ADR-064 step B2).
 *
 * There was none: a provider that hung held the request, and the reconciler's
 * grace period had nothing to be longer than
 * (`ECONOMIC_PAYMENT_RECONCILER_GRACE_SECONDS` > 2 ×
 * `ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS`, checked at boot).
 *
 * A call past its deadline is an **unknown** outcome: the provider may still
 * act on it. The callers already treat a thrown call that way — B0's refund
 * markers, `CAPTURED_REFUND_UNKNOWN` — and the reconciler then asks the
 * provider what happened. The timer is cleared as soon as the call settles.
 */
export class TimedPaymentProvider implements PaymentProvider {
  readonly name: string;
  readonly simulated: boolean;

  constructor(
    private readonly inner: PaymentProvider,
    private readonly timeoutMs: number,
  ) {
    this.name = inner.name;
    this.simulated = inner.simulated;
  }

  authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    return this.within('authorize', () => this.inner.authorize(request));
  }

  capture(request: CaptureRequest): Promise<CaptureResult> {
    return this.within('capture', () => this.inner.capture(request));
  }

  refund(request: RefundRequest): Promise<RefundResult> {
    return this.within('refund', () => this.inner.refund(request));
  }

  getStatus(providerReference: string): Promise<ProviderPaymentStatus> {
    return this.within('getStatus', () => this.inner.getStatus(providerReference));
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
