import { Injectable } from '@nestjs/common';
import type {
  AuthorizeRequest,
  AuthorizeResult,
  CaptureRequest,
  CaptureResult,
  PaymentProvider,
  ProviderPaymentStatus,
  RefundRequest,
  RefundResult,
} from './provider';

/**
 * The only payment provider this platform has (ADR-024).
 *
 * **It moves no money.** There is no bank, no PSP, no acquirer and no custody
 * of funds. Every result it returns carries `simulated: true`, every row it
 * produces carries `simulated = true`, and every event it causes says so on
 * the wire. Nothing in this file should ever be described as a payment
 * integration.
 *
 * What it *is* is a deterministic stand-in with three properties the
 * documentation asks for (docs/10 § 10.6): deterministic success, failure that
 * a test can provoke on demand, and simulated latency.
 *
 * ## Failure is provoked, never random
 *
 * A provider that failed one call in twenty would make a test suite flaky and
 * would prove nothing: the failure would arrive on a different test each run.
 * Instead the *request* asks for the failure, through the `instrument` field:
 *
 *   `fail:INSUFFICIENT_FUNDS`   authorize returns FAILED with that code
 *   `fail-capture:<code>`       authorize succeeds, capture fails
 *   `fail-refund:<code>`        authorize and capture succeed, refund fails
 *
 * `<code>` is one of {@link MOCK_DIRECTIVE_CODES}, or empty for
 * `PROVIDER_DECLINED`. Any other code fails the authorisation as
 * `UNSUPPORTED_DIRECTIVE` and is neither stored nor echoed.
 *
 * so a test can reach the compensation path deliberately, and the same request
 * behaves the same way every time it is replayed.
 *
 * The directive is *not* a back door into production behaviour: this class is
 * only ever bound when `ECONOMIC_PAYMENT_PROVIDER` is `mock`, and a real
 * provider would ignore the field entirely.
 *
 * ## Latency is fixed, never random
 *
 * `ECONOMIC_MOCK_PAYMENT_LATENCY_MS` is a constant delay, zero by default. A
 * random delay would make a demo look realistic and a test suite unreliable —
 * a trade nobody should take.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly simulated = true;

  /**
   * Provider references issued so far, and the state each reached.
   *
   * In-memory on purpose: it is what a real provider's own records would be,
   * and this one has none. `getStatus` therefore answers `UNKNOWN` for a
   * reference issued before a restart — which is the honest answer, and which
   * is also how a caller learns not to depend on this provider for
   * reconciliation. The durable record of every payment is `payment_intent` in
   * this service's own database.
   */
  private readonly states = new Map<string, ProviderPaymentStatus>();

  constructor(private readonly latencyMs = 0) {}

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    await this.delay();

    // A directive naming a code outside the closed set is refused whole: the
    // instrument is caller-controlled, and a code copied from it would reach
    // the stored reference, `failure_reason`, `PAYMENT_FAILED` and the log —
    // `fail-capture:4111111111111111` would carry a card number into all four
    // (S-09; Codex review of PR #121, finding 4). The reference issued for it
    // carries nothing from the instrument.
    const directives = ['fail', ...CARRIED_DIRECTIVES] as const;
    if (directives.some((prefix) => directive(request.instrument, prefix) === UNSUPPORTED)) {
      const plain = this.reference(request.paymentIntentId, undefined);
      this.states.set(plain, 'FAILED');
      return {
        outcome: 'FAILED',
        providerReference: plain,
        failureCode: UNSUPPORTED,
        simulated: true,
      };
    }

    const reference = this.reference(request.paymentIntentId, request.instrument);
    const failure = directive(request.instrument, 'fail');

    if (failure) {
      this.states.set(reference, 'FAILED');
      return {
        outcome: 'FAILED',
        providerReference: reference,
        failureCode: failure,
        simulated: true,
      };
    }

    this.states.set(reference, 'AUTHORIZED');
    return { outcome: 'AUTHORIZED', providerReference: reference, simulated: true };
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    await this.delay();

    // The directive travelled on the authorize call, so it is recovered from
    // the reference the mock issued. Keeping the two calls' behaviour
    // consistent is what lets a test drive a capture failure without having to
    // thread a flag through the domain.
    const failure = directive(request.providerReference, 'fail-capture');
    if (failure) {
      this.states.set(request.providerReference, 'FAILED');
      return {
        outcome: 'FAILED',
        providerReference: request.providerReference,
        failureCode: failure,
        simulated: true,
      };
    }

    this.states.set(request.providerReference, 'CAPTURED');
    return { outcome: 'CAPTURED', providerReference: request.providerReference, simulated: true };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    await this.delay();

    const failure = directive(request.providerReference, 'fail-refund');
    if (failure) {
      return {
        outcome: 'FAILED',
        providerReference: request.providerReference,
        failureCode: failure,
        simulated: true,
      };
    }

    this.states.set(request.providerReference, 'REFUNDED');
    return { outcome: 'REFUNDED', providerReference: request.providerReference, simulated: true };
  }

  async getStatus(providerReference: string): Promise<ProviderPaymentStatus> {
    await this.delay();
    return this.states.get(providerReference) ?? 'UNKNOWN';
  }

  /**
   * A reference that carries the intent id and any capture/refund directive.
   *
   * Encoding the directive into the reference is what makes a capture or
   * refund failure reachable: `capture` and `refund` are called with the
   * reference, not with the original instrument, and a real provider's
   * reference is opaque anyway. The refund one is only reachable this way — a
   * refund runs later, from the reference stored on the intent. Until global
   * audit L7-20 the directive was dropped here, so a `fail-refund:` top-up
   * refunded normally and the refusal path was untestable from the API.
   */
  private reference(paymentIntentId: string, instrument: string | undefined): string {
    const carried = CARRIED_DIRECTIVES.flatMap((prefix) => {
      const code = directive(instrument, prefix);
      return code === undefined ? [] : [`${prefix}:${code}`];
    });
    return carried.length === 0
      ? `mock_${paymentIntentId}`
      : mockReferenceWithDirective(paymentIntentId, carried.join(','));
  }

  private async delay(): Promise<void> {
    if (this.latencyMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

/**
 * The directives that act after authorisation, and so must travel inside the
 * reference. Comma-separated there, because `directive` ends a code at a comma
 * and a code may itself contain underscores.
 */
const CARRIED_DIRECTIVES = ['fail-capture', 'fail-refund'] as const;

/**
 * Reads `<prefix>:<CODE>` out of a directive string.
 *
 * Returns undefined for anything else, so an ordinary instrument reference —
 * or none at all — takes the success path. A code outside
 * {@link MOCK_DIRECTIVE_CODES} comes back as `UNSUPPORTED_DIRECTIVE`, never as
 * itself.
 */
function directive(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  const marker = `${prefix}:`;
  const index = value.indexOf(marker);
  if (index === -1) return undefined;
  const code = value.slice(index + marker.length).split(/[\s,]/)[0];
  const named = code && code.length > 0 ? code : 'PROVIDER_DECLINED';
  return (MOCK_DIRECTIVE_CODES as readonly string[]).includes(named) ? named : UNSUPPORTED;
}

/**
 * The only failure codes a directive may name. A closed set, because the
 * code is copied into the provider reference and from there into what this
 * service stores, publishes and logs (Codex review of PR #121, finding 4).
 */
export const MOCK_DIRECTIVE_CODES = [
  'PROVIDER_DECLINED',
  'INSUFFICIENT_FUNDS',
  'ISSUER_TIMEOUT',
  'NOT_PERMITTED',
  'PROVIDER_UNAVAILABLE',
] as const;

/** The code a directive outside the closed set fails with, in place of its own. */
export const UNSUPPORTED = 'UNSUPPORTED_DIRECTIVE';

/**
 * Builds the reference a mock authorize would issue for an intent, with a
 * capture- or refund-failure directive attached.
 *
 * Exported for the integration tests, which need to reach the compensation
 * paths without reimplementing this encoding — and which would otherwise be
 * asserting against a string literal that could drift.
 */
export function mockReferenceWithDirective(paymentIntentId: string, directiveText: string): string {
  return `mock_${paymentIntentId}_${directiveText}`;
}
