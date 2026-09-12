import { ApiFailure, CLIENT_ERROR_CODES } from '../api/errors';
import type { GatewayClient, GatewayRequest, GatewayResult } from '../api/client';
import { FIXTURE_ENTRY_POINTS } from './entry-points';

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
/**
 * A canonical `path?sorted=query` string for a request, or the bare path when
 * it carries no query at all.
 *
 * Sorted so the key does not depend on the order an adapter happened to list
 * its query object's keys in. Every existing fixture is keyed by the bare
 * path and stays reachable through the `this.responses[request.path]`
 * fallback in `request()` — this function only adds a *more specific* lookup
 * that a route may opt into by also registering the exact-query key.
 */
function queryAwareKey(request: GatewayRequest<unknown>): string {
  const entries = Object.entries(request.query ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) return request.path;

  const query = entries.map(([key, value]) => `${key}=${String(value)}`).join('&');
  return `${request.path}?${query}`;
}

/**
 * A fixture entry is either the response itself, or a function that computes
 * it fresh on every call.
 *
 * The function form is how `createFixtureClient` below wires a handful of
 * routes to the interactive scenario engine (`./scenario/`): the closure
 * re-reads the current scenario snapshot on every request, so a dispatched
 * action is visible on the very next `GET` rather than only after the client
 * is rebuilt. Every route this application had before the scenario engine
 * existed keeps the plain value form and is completely unaffected.
 */
export type FixtureResponseEntry = unknown | (() => unknown);

export class FixtureGatewayClient implements GatewayClient {
  private sequence = 0;

  constructor(private readonly responses: Readonly<Record<string, FixtureResponseEntry>>) {}

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
    const key = queryAwareKey(request);
    // A query-specific fixture wins when one is registered — today only
    // `/v1/audit-events/verify` needs that, to tell its four outcomes apart
    // from one path. Every other route has no such entry and falls back to
    // the bare path exactly as before, so this is additive, not a behaviour
    // change for the rest of the dataset.
    const entry = key in this.responses ? this.responses[key] : this.responses[request.path];
    const body = typeof entry === 'function' ? entry() : entry;

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
 * Builds the fixture client, loading the dataset — and the interactive
 * scenario engine — on demand.
 *
 * Dynamic because a live build must not carry either. The static dataset and
 * the scenario engine (state model, reducer, invariants, persistence,
 * read-model) are kilobytes of gzip a live deployment can never use, and
 * ADR-003's 200 KiB budget does not have room to spend on code that is
 * switched off.
 *
 * ## The state-aware routes, and why it is only these five
 *
 * Every route the scenario engine can actually change something about:
 * the maintenance request (estimate approval), the order (placement and
 * payment), the wallet (payment's effect on balances), the document list
 * (attachment and scan result) and the audit-event list (every action
 * appends one entry). Every other route — assets, fleet, the marketplace
 * catalogue, suppliers, the audit chain-verification presets — has no
 * scenario action that touches it, so it stays the plain static value it
 * always was. Wiring a route here does not change what the scenario engine
 * does; it only lets a route that does change re-read it.
 */
export async function createFixtureClient(): Promise<GatewayClient> {
  const { FIXTURE_RESPONSES } = await import('./fixtures');
  const { getScenarioStore } = await import('./scenario/store');
  const readModel = await import('./scenario/read-model');

  const getSnapshot = () => getScenarioStore().getState();
  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

  const maintenanceDetailKey = `/v1/maintenance-requests/${FIXTURE_ENTRY_POINTS.maintenanceRequestId}`;
  const orderDetailKey = `/v1/orders/${FIXTURE_ENTRY_POINTS.orderId}`;

  const responses: Record<string, FixtureResponseEntry> = {
    ...FIXTURE_RESPONSES,
    [maintenanceDetailKey]: () =>
      readModel.projectMaintenanceRequestDetail(
        asRecord(FIXTURE_RESPONSES[maintenanceDetailKey]),
        getSnapshot(),
      ),
    [orderDetailKey]: () =>
      readModel.projectOrder(asRecord(FIXTURE_RESPONSES[orderDetailKey]), getSnapshot()),
    '/v1/orders': () =>
      readModel.projectOrdersPage(asRecord(FIXTURE_RESPONSES['/v1/orders']), getSnapshot()),
    '/v1/wallets/me': () =>
      readModel.projectWallet(asRecord(FIXTURE_RESPONSES['/v1/wallets/me']), getSnapshot()),
    '/v1/documents': () =>
      readModel.projectDocumentsPage(asRecord(FIXTURE_RESPONSES['/v1/documents']), getSnapshot()),
    '/v1/audit-events': () =>
      readModel.projectAuditEventsPage(
        asRecord(FIXTURE_RESPONSES['/v1/audit-events']),
        getSnapshot(),
      ),
  };

  return new FixtureGatewayClient(responses);
}
