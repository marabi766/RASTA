import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InternalTokenService } from '@rasta/nest-common';

/**
 * inventory-service as marketplace-service meets it: the two internal routes of its dispatch fence
 * (`GET /v1/internal/return-requests/{id}/return-shipment`,
 * `POST /v1/internal/return-requests/{id}/dispatch-withdrawal`), on a real port, answering as the
 * real ones do (inventory's `dispatch-fence.ts`) — and verifying the real internal token, so the
 * suites prove which service asked, for which organization (ADR-035). Only the books are in memory.
 *
 * The real routes, their lock and their triggers are proved against inventory's own database in
 * its `return-dispatch-fence.int-spec.ts`; this stands in for them so marketplace's suites need no
 * inventory.
 */

export interface FakeShipment {
  id: string;
  status: string;
}

/** How the fake misbehaves, for the fail-closed suites. */
export type InventoryFakeMode =
  'normal' | 'unavailable' | 'route-missing' | 'silent' | 'malformed' | 'forbidden';

export interface InventoryFakeCall {
  method: string;
  path: string;
  callerService: string | null;
  organizationId: string | null;
  body: unknown;
}

export interface InventoryFake {
  readonly url: string;
  /** Shipments by return request, in the books of the supplier named. */
  readonly shipments: Map<string, FakeShipment & { organizationId: string }>;
  /** Withdrawn reservations: reservation id → when, and of which request. */
  readonly withdrawals: Map<string, { returnRequestId: string; withdrawnAt: string }>;
  readonly calls: InventoryFakeCall[];
  mode: InventoryFakeMode;
  reset(): void;
  close(): Promise<void>;
}

const TARGET = 'inventory-service';
const CALLER = 'marketplace-service';

export async function startInventoryFake(secret: string): Promise<InventoryFake> {
  const tokens = new InternalTokenService(secret, 'rasta-internal', 300);
  const fake = {
    url: '',
    shipments: new Map<string, FakeShipment & { organizationId: string }>(),
    withdrawals: new Map<string, { returnRequestId: string; withdrawnAt: string }>(),
    calls: [] as InventoryFakeCall[],
    mode: 'normal' as InventoryFakeMode,
    reset() {
      fake.shipments.clear();
      fake.withdrawals.clear();
      fake.calls.length = 0;
      fake.mode = 'normal';
    },
    close: async (): Promise<void> => undefined,
  };

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const error = (code: string, message: string) => ({ code, message, correlationId: 'fake' });

  const handle = async (incoming: IncomingMessage, text: string, response: ServerResponse) => {
    const path = incoming.url ?? '';
    const header = incoming.headers['x-internal-token'];
    let claims: { callerService: string; organizationId?: string } | null = null;
    if (typeof header === 'string') {
      claims = await tokens.verify(header, TARGET).catch(() => null);
    }
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    fake.calls.push({
      method: incoming.method ?? '',
      path,
      callerService: claims?.callerService ?? null,
      organizationId: claims?.organizationId ?? null,
      body,
    });

    if (fake.mode === 'silent') return; // never answers: the caller's deadline decides
    if (fake.mode === 'unavailable') return send(response, 503, error('INTERNAL_ERROR', 'down'));
    const match =
      /^\/v1\/internal\/return-requests\/([^/]+)\/(return-shipment|dispatch-withdrawal)$/.exec(
        path,
      );
    if (fake.mode === 'route-missing' || !match) {
      return send(response, 404, error('NOT_FOUND', `Cannot ${incoming.method} ${path}`));
    }
    if (!claims) return send(response, 401, error('UNAUTHENTICATED', 'no token'));
    if (fake.mode === 'forbidden' || claims.callerService !== CALLER || !claims.organizationId) {
      return send(response, 403, error('FORBIDDEN', 'forbidden'));
    }
    const id = decodeURIComponent(match[1] as string);
    const held = fake.shipments.get(id);
    // Only the books of the organization signed for.
    const shipment =
      held && held.organizationId === claims.organizationId
        ? { id: held.id, status: held.status }
        : null;
    if (fake.mode === 'malformed') return send(response, 200, { returnRequestId: id });

    if (match[2] === 'return-shipment' && incoming.method === 'GET') {
      return send(response, 200, { returnRequestId: id, returnShipment: shipment });
    }
    if (match[2] === 'dispatch-withdrawal' && incoming.method === 'POST') {
      const reservationId = (body as { reservationId?: string } | null)?.reservationId ?? '';
      if (shipment) {
        return send(response, 200, {
          outcome: 'DISPATCHED',
          returnRequestId: id,
          reservationId,
          withdrawnAt: null,
          returnShipment: shipment,
        });
      }
      const withdrawal = fake.withdrawals.get(reservationId) ?? {
        returnRequestId: id,
        withdrawnAt: new Date().toISOString(),
      };
      fake.withdrawals.set(reservationId, withdrawal);
      return send(response, 200, {
        outcome: 'WITHDRAWN',
        returnRequestId: id,
        reservationId,
        withdrawnAt: withdrawal.withdrawnAt,
        returnShipment: null,
      });
    }
    return send(response, 404, error('NOT_FOUND', `Cannot ${incoming.method} ${path}`));
  };

  const server: Server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      void handle(incoming, Buffer.concat(chunks).toString('utf8'), response).catch(() =>
        send(response, 500, error('INTERNAL_ERROR', 'x')),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}
