import {
  ALREADY_REFUNDED,
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

  it('answers a repeated refund with the same key as the first time, and moves nothing again', async () => {
    const fresh = new MockPaymentProvider();
    const request = { ...refundRequest, providerReference: 'mock_PAY_DEDUPE' };
    expect(await fresh.refund(request)).toMatchObject({ outcome: 'REFUNDED' });
    expect(await fresh.refund(request)).toMatchObject({ outcome: 'REFUNDED' });
    expect(await fresh.getStatus('mock_PAY_DEDUPE')).toBe('REFUNDED');
  });

  it('refuses a second refund of one reference under another key', async () => {
    const fresh = new MockPaymentProvider();
    const request = { ...refundRequest, providerReference: 'mock_PAY_TWICE' };
    expect((await fresh.refund(request)).outcome).toBe('REFUNDED');
    expect(await fresh.refund({ ...request, idempotencyKey: 'another-key:refund' })).toMatchObject({
      outcome: 'FAILED',
      failureCode: ALREADY_REFUNDED,
    });
  });

  it('replays a refused refund as refused', async () => {
    const fresh = new MockPaymentProvider();
    const request = { ...refundRequest, providerReference: 'mock_PAY_2_fail-refund:NOT_PERMITTED' };
    expect((await fresh.refund(request)).outcome).toBe('FAILED');
    expect(await fresh.refund(request)).toMatchObject({
      outcome: 'FAILED',
      failureCode: 'NOT_PERMITTED',
    });
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

/**
 * The status of one refund attempt (ADR-064 step B2, the § 3 amendment scoped
 * to refunds). What the reconciler asks before it resolves anything.
 *
 * The mock remembers what it did, and says so. What it did *not* see it
 * cannot vouch for: its memory is one process's, lost on restart and not
 * shared between replicas (Codex on #164, HIGH 2). So it declares
 * `authoritativeAbsence: false`, and an attempt it has no record of is
 * `UNKNOWN` — never `NOT_FOUND`.
 */
describe('getRefundStatus', () => {
  const refundKey = (id: string) => `KEY-${id}:refund`;

  async function captured(mock: MockPaymentProvider, id: string, instrument?: string) {
    const auth = await mock.authorize({ ...authorizeRequest, paymentIntentId: id, instrument });
    await mock.capture({
      paymentIntentId: id,
      providerReference: auth.providerReference,
      amountMinor: 1000n,
      currency: 'IRR',
      idempotencyKey: `KEY-${id}`,
    });
    return auth.providerReference;
  }

  const refundOf = (id: string, providerReference: string) => ({
    paymentIntentId: id,
    providerReference,
    amountMinor: 1000n,
    currency: 'IRR',
    idempotencyKey: refundKey(id),
    reason: 'the suite refunds',
  });

  const query = (id: string, providerReference: string, idempotencyKey = refundKey(id)) => ({
    paymentIntentId: id,
    providerReference,
    idempotencyKey,
  });

  it('declares that it cannot vouch for an absence', () => {
    expect(new MockPaymentProvider().authoritativeAbsence).toBe(false);
  });

  it('answers REFUNDED for an attempt it refunded', async () => {
    const mock = new MockPaymentProvider();
    const reference = await captured(mock, 'PAY_RS_DONE');
    await mock.refund(refundOf('PAY_RS_DONE', reference));

    expect(await mock.getRefundStatus(query('PAY_RS_DONE', reference))).toEqual({
      refund: 'REFUNDED',
      authoritative: true,
      simulated: true,
    });
  });

  it('answers DECLINED, with the code, for an attempt it refused', async () => {
    const mock = new MockPaymentProvider();
    const reference = await captured(mock, 'PAY_RS_NO', 'fail-refund:NOT_PERMITTED');
    await mock.refund(refundOf('PAY_RS_NO', reference));

    expect(await mock.getRefundStatus(query('PAY_RS_NO', reference))).toEqual({
      refund: 'DECLINED',
      authoritative: true,
      failureCode: 'NOT_PERMITTED',
      simulated: true,
    });
  });

  it('answers UNKNOWN, never NOT_FOUND, for an attempt it has no record of', async () => {
    const mock = new MockPaymentProvider();
    expect(await mock.getRefundStatus(query('PAY_RS_NEVER', 'mock_PAY_RS_NEVER'))).toEqual({
      refund: 'UNKNOWN',
      authoritative: false,
      simulated: true,
    });
  });

  it('two replicas are two memories: B cannot see the refund A made', async () => {
    const replicaA = new MockPaymentProvider();
    const replicaB = new MockPaymentProvider();
    const reference = await captured(replicaA, 'PAY_RS_REPLICA');
    await replicaA.refund(refundOf('PAY_RS_REPLICA', reference));

    expect(await replicaB.getRefundStatus(query('PAY_RS_REPLICA', reference))).toEqual({
      refund: 'UNKNOWN',
      authoritative: false,
      simulated: true,
    });
  });

  it('knows an attempt only by its own key: another key of the same reference is unknown', async () => {
    const mock = new MockPaymentProvider();
    const reference = await captured(mock, 'PAY_RS_KEY');
    await mock.refund(refundOf('PAY_RS_KEY', reference));

    expect(
      await mock.getRefundStatus(query('PAY_RS_KEY', reference, 'KEY-PAY_RS_KEY:uncredited')),
    ).toEqual({ refund: 'UNKNOWN', authoritative: false, simulated: true });
  });

  describe('directives for the unknown outcomes', () => {
    it('lose-refund: refunds, then loses the answer — the status still tells the truth', async () => {
      const mock = new MockPaymentProvider();
      const reference = await captured(mock, 'PAY_RS_LOSE', 'lose-refund:');
      expect(reference).toContain('lose-refund');

      await expect(mock.refund(refundOf('PAY_RS_LOSE', reference))).rejects.toThrow(
        'simulated lost provider response',
      );
      expect(await mock.getRefundStatus(query('PAY_RS_LOSE', reference))).toEqual({
        refund: 'REFUNDED',
        authoritative: true,
        simulated: true,
      });
    });

    it('hang-refund: never answers and never refunds — for the call timeout', async () => {
      const mock = new MockPaymentProvider();
      const reference = await captured(mock, 'PAY_RS_HANG', 'hang-refund:');

      const outcome = await Promise.race([
        mock.refund(refundOf('PAY_RS_HANG', reference)).then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 30)),
      ]);
      expect(outcome).toBe('still waiting');
      expect(await mock.getRefundStatus(query('PAY_RS_HANG', reference))).toEqual({
        refund: 'UNKNOWN',
        authoritative: false,
        simulated: true,
      });
    });
  });
});
