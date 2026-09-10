import { ApiFailure, CLIENT_ERROR_CODES } from '../api/errors';
import type { GatewayClient, GatewayRequest, GatewayResult } from '../api/client';

/**
 * The presentation data source.
 *
 * Implements the same one-method interface as `ApiClient`, so every adapter and
 * every screen above it is unchanged and unaware. What it does *not* have is
 * the interesting part:
 *
 *  - **No `fetch`.** Not a stubbed one, not an injected one — the class has no
 *    reference to the network at all, so a fixture session cannot reach a
 *    backend even by mistake.
 *  - **No token.** It needs no credential because it makes no request, which is
 *    why a fixture session has nothing to leak, persist or renew.
 *  - **No writes.** Anything but `GET` is refused before a fixture is even
 *    looked up. A read-only source that quietly accepted a `POST` and returned
 *    a cheerful result would be teaching an audience that a mutation succeeded.
 *
 * ## Why responses go through the caller's schema
 *
 * The same `schema` the adapter would have used against the live gateway. That
 * turns the fixtures into contract tests of themselves: a fixture that drifts
 * from the service's real DTO fails loudly at the point of use rather than
 * rendering something plausible and wrong. It is also why the fixtures had to
 * be written from the same shapes the adapters were — there is no second,
 * looser definition for them to satisfy.
 */
export class FixtureGatewayClient implements GatewayClient {
  private sequence = 0;

  constructor(private readonly responses: Readonly<Record<string, unknown>>) {}

  async request<T>(request: GatewayRequest<T>): Promise<GatewayResult<T>> {
    const method = request.method ?? 'GET';

    if (method !== 'GET') {
      // Refused here rather than by a missing fixture, so the message says what
      // actually happened. This is also the assertion a test can make about the
      // whole mode: no mutation leaves this client, ever.
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.FIXTURE_WRITE_REFUSED,
        status: null,
        correlationId: this.nextCorrelationId(),
      });
    }

    if (request.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const correlationId = this.nextCorrelationId();
    const body = this.responses[request.path];

    if (body === undefined) {
      // A screen reading a route the dataset does not cover is a gap in the
      // demo, not an empty result. Reporting it as `NOT_FOUND` would be
      // indistinguishable from the service legitimately having no such record.
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.FIXTURE_MISSING,
        status: null,
        correlationId,
        details: [{ path: request.path, message: 'No fixture is defined for this route.' }],
      });
    }

    const parsed = request.schema.safeParse(body);

    if (!parsed.success) {
      throw new ApiFailure({
        code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
        status: null,
        correlationId,
        details: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return { data: parsed.data, correlationId, status: 200 };
  }

  /**
   * Deterministic, and obviously not a real correlation id.
   *
   * A real one is a ULID the gateway minted and every service logged against.
   * Handing a presenter something that looked like one would invite them to
   * quote it to support for a request that never existed.
   */
  private nextCorrelationId(): string {
    this.sequence += 1;
    return `fixture-${String(this.sequence).padStart(4, '0')}`;
  }
}

/**
 * Builds the fixture client, loading the dataset on demand.
 *
 * Dynamic because a live build must not carry it. The fixtures are a few
 * kilobytes of gzip that a live deployment can never use, and ADR-003's 200 KiB
 * budget does not have room to spend on data that is switched off.
 */
export async function createFixtureClient(): Promise<GatewayClient> {
  const { FIXTURE_RESPONSES } = await import('./fixtures');
  return new FixtureGatewayClient(FIXTURE_RESPONSES);
}
