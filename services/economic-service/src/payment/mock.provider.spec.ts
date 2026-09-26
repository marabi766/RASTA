import {
  MOCK_DIRECTIVE_CODES,
  MockPaymentProvider,
  UNSUPPORTED,
  mockReferenceWithDirective,
} from './mock.provider';
import { failureCodeFrom } from './payment.service';

describe('failureCodeFrom — what a provider code may become in storage, events and logs', () => {
  it('keeps a code-shaped value', () => {
    expect(failureCodeFrom('INSUFFICIENT_FUNDS', 'X')).toBe('INSUFFICIENT_FUNDS');
  });

  it.each([undefined, '', '4111111111111111', 'CARD4111', 'lower_case', 'WITH SPACE'])(
    'replaces anything else with the fallback: %s',
    (code) => {
      expect(failureCodeFrom(code, 'PROVIDER_DECLINED')).toBe('PROVIDER_DECLINED');
    },
  );
});

/**
 * The simulated payment provider (ADR-024).
 *
 * Two properties are being asserted, and both are requirements rather than
 * conveniences:
 *
 *   **It always says it is simulated.** ADR-024 forbids any claim of a real
 *   bank connection, and a result indistinguishable from a real payment *is*
 *   such a claim.
 *
 *   **Failure is provoked, never random.** A provider that failed one call in
 *   twenty would land its failure on a different test each run and prove
 *   nothing. The request asks for the failure, so the compensation paths are
 *   reachable deterministically.
 */

const provider = new MockPaymentProvider();

const authorizeRequest = {
  paymentIntentId: 'PAY_1',
  organizationId: 'ORG-A',
  amountMinor: 10_000_000n,
  currency: 'IRR',
  idempotencyKey: 'idem-key-0001',
};

describe('disclosure', () => {
  it('names itself and admits it is simulated', () => {
    expect(provider.name).toBe('mock');
    expect(provider.simulated).toBe(true);
  });

  it('marks every result simulated, on every path', async () => {
    const authorized = await provider.authorize(authorizeRequest);
    const captured = await provider.capture({
      paymentIntentId: 'PAY_1',
      providerReference: authorized.providerReference,
      amountMinor: 10_000_000n,
      currency: 'IRR',
      idempotencyKey: 'idem-key-0001',
    });
    const failed = await provider.authorize({
      ...authorizeRequest,
      paymentIntentId: 'PAY_2',
      instrument: 'fail:INSUFFICIENT_FUNDS',
    });

    expect(authorized.simulated).toBe(true);
    expect(captured.simulated).toBe(true);
    expect(failed.simulated).toBe(true);
  });
});

describe('authorize', () => {
  it('succeeds deterministically', async () => {
    const first = await provider.authorize(authorizeRequest);
    const second = await provider.authorize(authorizeRequest);

    expect(first.outcome).toBe('AUTHORIZED');
    expect(second.outcome).toBe('AUTHORIZED');
    expect(first.providerReference).toBe(second.providerReference);
  });

  it('fails when the request asks it to, with the code it asked for', async () => {
    const result = await provider.authorize({
      ...authorizeRequest,
      instrument: 'fail:INSUFFICIENT_FUNDS',
    });

    expect(result.outcome).toBe('FAILED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('supplies a generic code when the directive names none', async () => {
    const result = await provider.authorize({ ...authorizeRequest, instrument: 'fail:' });
    expect(result).toMatchObject({ outcome: 'FAILED', failureCode: 'PROVIDER_DECLINED' });
  });

  it('takes the success path for an ordinary instrument reference', async () => {
    const result = await provider.authorize({ ...authorizeRequest, instrument: 'tok_abc123' });
    expect(result.outcome).toBe('AUTHORIZED');
  });
});

describe('capture', () => {
  const captureRequest = {
    paymentIntentId: 'PAY_1',
    providerReference: 'mock_PAY_1',
    amountMinor: 10_000_000n,
    currency: 'IRR',
    idempotencyKey: 'idem-key-0001',
  };

  it('captures an authorised payment', async () => {
    const result = await provider.capture(captureRequest);
    expect(result.outcome).toBe('CAPTURED');
  });

  it('fails when the reference carries a capture directive', async () => {
    // The path that matters: an authorisation that succeeds and a capture that
    // does not is exactly the case where crediting on authorise would have put
    // money in a wallet that has to be clawed back.
    const result = await provider.capture({
      ...captureRequest,
      providerReference: 'mock_PAY_1_fail-capture:ISSUER_TIMEOUT',
    });

    expect(result).toMatchObject({ outcome: 'FAILED', failureCode: 'ISSUER_TIMEOUT' });
  });
});

describe('refund', () => {
  const refundRequest = {
    paymentIntentId: 'PAY_1',
    providerReference: 'mock_PAY_1',
    amountMinor: 10_000_000n,
    currency: 'IRR',
    idempotencyKey: 'idem-key-0001:refund',
    reason: 'cancelled',
  };

  it('refunds a captured payment', async () => {
    const result = await provider.refund(refundRequest);
    expect(result.outcome).toBe('REFUNDED');
  });

  it('fails when the reference carries a refund directive', async () => {
    const result = await provider.refund({
      ...refundRequest,
      providerReference: 'mock_PAY_1_fail-refund:NOT_PERMITTED',
    });
    expect(result).toMatchObject({ outcome: 'FAILED', failureCode: 'NOT_PERMITTED' });
  });
});

describe('the reference carries the directives that act after authorisation (L7-20)', () => {
  const capture = (providerReference: string) =>
    provider.capture({
      paymentIntentId: 'PAY_9',
      providerReference,
      amountMinor: 1_000n,
      currency: 'IRR',
      idempotencyKey: 'idem-key-0009',
    });
  const refund = (providerReference: string) =>
    provider.refund({
      paymentIntentId: 'PAY_9',
      providerReference,
      amountMinor: 1_000n,
      currency: 'IRR',
      idempotencyKey: 'idem-key-0009:refund',
      reason: 'cancelled',
    });

  it('keeps a refund directive from the instrument, so the refund later fails', async () => {
    const authorized = await provider.authorize({
      ...authorizeRequest,
      paymentIntentId: 'PAY_9',
      instrument: 'fail-refund:NOT_PERMITTED',
    });
    expect(authorized.outcome).toBe('AUTHORIZED');
    expect(authorized.providerReference).toBe(
      mockReferenceWithDirective('PAY_9', 'fail-refund:NOT_PERMITTED'),
    );

    expect((await capture(authorized.providerReference)).outcome).toBe('CAPTURED');
    expect(await refund(authorized.providerReference)).toMatchObject({
      outcome: 'FAILED',
      failureCode: 'NOT_PERMITTED',
    });
  });

  it('keeps both directives, codes with underscores intact', async () => {
    const authorized = await provider.authorize({
      ...authorizeRequest,
      paymentIntentId: 'PAY_9',
      instrument: 'fail-refund:NOT_PERMITTED fail-capture:ISSUER_TIMEOUT',
    });
    expect(await capture(authorized.providerReference)).toMatchObject({
      outcome: 'FAILED',
      failureCode: 'ISSUER_TIMEOUT',
    });
    expect(await refund(authorized.providerReference)).toMatchObject({
      outcome: 'FAILED',
      failureCode: 'NOT_PERMITTED',
    });
  });

  it.each(['fail:4111111111111111', 'fail-capture:4111111111111111', 'fail-refund:DROP TABLE'])(
    'refuses a code outside the closed set, and carries none of it: %s',
    async (instrument) => {
      // Codex review of PR #121, finding 4.
      const authorized = await provider.authorize({
        ...authorizeRequest,
        paymentIntentId: 'PAY_9',
        instrument,
      });
      expect(authorized).toMatchObject({
        outcome: 'FAILED',
        failureCode: UNSUPPORTED,
        providerReference: 'mock_PAY_9',
      });
    },
  );

  it('accepts every code in the closed set', async () => {
    for (const code of MOCK_DIRECTIVE_CODES) {
      const result = await provider.authorize({ ...authorizeRequest, instrument: `fail:${code}` });
      expect(result).toMatchObject({ outcome: 'FAILED', failureCode: code });
    }
  });

  it('issues a plain reference for an ordinary instrument, which carries no instrument data', async () => {
    const authorized = await provider.authorize({
      ...authorizeRequest,
      paymentIntentId: 'PAY_9',
      instrument: 'tok_abc123',
    });
    expect(authorized.providerReference).toBe('mock_PAY_9');
  });
});

describe('getStatus', () => {
  it('reports what it last did with a reference', async () => {
    const fresh = new MockPaymentProvider();
    await fresh.authorize({ ...authorizeRequest, paymentIntentId: 'PAY_STATUS' });
    expect(await fresh.getStatus('mock_PAY_STATUS')).toBe('AUTHORIZED');
  });

  it('answers UNKNOWN for a reference it never issued', async () => {
    // The honest answer, and the reason nothing reconciles against this
    // provider: it keeps no durable records, because it is not a real one. The
    // durable record is `payment_intent` in this service's own database.
    expect(await new MockPaymentProvider().getStatus('mock_SOMETHING_ELSE')).toBe('UNKNOWN');
  });
});

describe('simulated latency', () => {
  it('is zero by default, so tests are fast', async () => {
    const started = Date.now();
    await provider.authorize({ ...authorizeRequest, paymentIntentId: 'PAY_FAST' });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('is a fixed delay when configured, never a random one', async () => {
    // A random delay makes a demo look realistic and a test suite unreliable.
    const slow = new MockPaymentProvider(40);
    const started = Date.now();
    await slow.authorize({ ...authorizeRequest, paymentIntentId: 'PAY_SLOW' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });
});
