import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InternalTokenService } from '@rasta/nest-common';
import { ulid } from 'ulid';

/**
 * marketplace-service as inventory-service meets it: the two internal return routes
 * (`GET /v1/internal/returns/{id}`, `POST /v1/internal/returns/{id}/dispatch-reservation`), on a
 * real port, answering exactly as the real ones do (marketplace's `dispatch-source.ts`) — and
 * verifying the real internal token, so the suites prove which service asked, for which
 * organization, signed with the shared secret (ADR-035). Only the request store is in memory.
 *
 * The real routes are proved against marketplace's own database in its
 * `api-return-dispatch.int-spec.ts`; this stands in for them so inventory's suites need no
 * marketplace.
 */

export interface FakeReturnRequest {
  returnRequestId: string;
  orderId: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  status: string;
  lines: { orderLineId: string; productId: string; quantity: number }[];
  /** `RDR_<ULID>`, as marketplace mints one per reservation (Q-133 (9)(a)). */
  dispatchReservationId: string | null;
  dispatchReservedAt: string | null;
}

/** How the fake misbehaves, for the fail-closed suites. */
export type FakeMode = 'normal' | 'unavailable' | 'route-missing' | 'silent' | 'forbidden';

export interface FakeCall {
  method: string;
  path: string;
  callerService: string | null;
  organizationId: string | null;
}

export interface MarketplaceFake {
  readonly url: string;
  readonly requests: Map<string, FakeReturnRequest>;
  readonly calls: FakeCall[];
  mode: FakeMode;
  partialDispatchAllowed: boolean;
  /** Runs once a reservation request is authenticated, before it is judged (a cancellation, say). */
  beforeReserve: ((id: string) => void) | null;
  /**
   * Runs once a reservation is taken, before it is answered — while the dispatch that asked waits
   * for the answer. A reconciliation that withdraws it here is a dispatch delayed past it.
   */
  afterReserve: ((request: FakeReturnRequest) => Promise<void>) | null;
  /** Stores an AUTHORIZED request (unless told otherwise) and returns it. */
  register(
    request: Omit<FakeReturnRequest, 'status' | 'dispatchReservedAt' | 'dispatchReservationId'> & {
      status?: string;
      dispatchReservationId?: string | null;
    },
  ): FakeReturnRequest;
  /** What marketplace's reconciliation does once inventory withdrew the reservation: clears it. */
  release(id: string): void;
  reset(): void;
  close(): Promise<void>;
}

const TARGET = 'marketplace-service';
const CALLER = 'inventory-service';

export async function startMarketplaceFake(secret: string): Promise<MarketplaceFake> {
  const tokens = new InternalTokenService(secret, 'rasta-internal', 300);
  const requests = new Map<string, FakeReturnRequest>();
  const calls: FakeCall[] = [];

  const fake = {
    url: '',
    requests,
    calls,
    mode: 'normal' as FakeMode,
    partialDispatchAllowed: false,
    beforeReserve: null as ((id: string) => void) | null,
    afterReserve: null as ((request: FakeReturnRequest) => Promise<void>) | null,
    register(
      request: Omit<
        FakeReturnRequest,
        'status' | 'dispatchReservedAt' | 'dispatchReservationId'
      > & { status?: string; dispatchReservationId?: string | null },
    ) {
      const reservationId = request.dispatchReservationId ?? null;
      const stored: FakeReturnRequest = {
        ...request,
        status: request.status ?? 'AUTHORIZED',
        dispatchReservationId: reservationId,
        dispatchReservedAt: reservationId === null ? null : new Date().toISOString(),
      };
      requests.set(stored.returnRequestId, stored);
      return stored;
    },
    release(id: string) {
      const request = requests.get(id);
      if (request) {
        request.dispatchReservationId = null;
        request.dispatchReservedAt = null;
      }
    },
    reset() {
      requests.clear();
      calls.length = 0;
      fake.mode = 'normal';
      fake.partialDispatchAllowed = false;
      fake.beforeReserve = null;
      fake.afterReserve = null;
    },
    close: async (): Promise<void> => undefined,
  };

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const error = (code: string, message: string) => ({
    code,
    message,
    correlationId: 'fake',
    timestamp: new Date().toISOString(),
  });
  const view = (request: FakeReturnRequest) => ({
    ...request,
    partialDispatchAllowed: fake.partialDispatchAllowed,
  });

  const handle = async (incoming: IncomingMessage, response: ServerResponse) => {
    const path = incoming.url ?? '';
    const header = incoming.headers['x-internal-token'];
    let claims: { callerService: string; organizationId?: string } | null = null;
    if (typeof header === 'string') {
      claims = await tokens.verify(header, TARGET).catch(() => null);
    }
    calls.push({
      method: incoming.method ?? '',
      path,
      callerService: claims?.callerService ?? null,
      organizationId: claims?.organizationId ?? null,
    });

    if (fake.mode === 'silent') return; // never answers: the caller's deadline decides
    if (fake.mode === 'unavailable') {
      return send(response, 503, error('UPSTREAM_UNAVAILABLE', 'unavailable'));
    }
    const match = /^\/v1\/internal\/returns\/([^/]+)(\/dispatch-reservation)?$/.exec(path);
    if (fake.mode === 'route-missing' || !match) {
      return send(response, 404, error('NOT_FOUND', `Cannot ${incoming.method} ${path}`));
    }
    if (!claims) return send(response, 401, error('UNAUTHENTICATED', 'no token'));
    if (fake.mode === 'forbidden' || claims.callerService !== CALLER || !claims.organizationId) {
      return send(response, 403, error('FORBIDDEN', 'forbidden'));
    }

    const id = decodeURIComponent(match[1] as string);
    const reserving = match[2] !== undefined;
    if (reserving !== (incoming.method === 'POST') || (!reserving && incoming.method !== 'GET')) {
      return send(response, 404, error('NOT_FOUND', `Cannot ${incoming.method} ${path}`));
    }
    if (reserving) fake.beforeReserve?.(id);

    const request = requests.get(id);
    // A request of any other supplier is not found, exactly as one that does not exist.
    if (!request || request.supplierOrganizationId !== claims.organizationId) {
      return send(response, 404, error('NOT_FOUND', 'ReturnRequest not found'));
    }
    if (reserving) {
      if (request.status !== 'AUTHORIZED') {
        return send(response, 422, error('BUSINESS_RULE_VIOLATION', 'not AUTHORIZED'));
      }
      // Idempotent, as the real route: a reservation standing is answered as it stands.
      if (request.dispatchReservationId === null) {
        request.dispatchReservationId = `RDR_${ulid()}`;
        request.dispatchReservedAt = new Date().toISOString();
      }
      await fake.afterReserve?.(request);
    }
    return send(response, 200, view(request));
  };

  const server: Server = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => {
      void handle(incoming, response).catch(() =>
        send(response, 500, error('INTERNAL_ERROR', 'x')),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
