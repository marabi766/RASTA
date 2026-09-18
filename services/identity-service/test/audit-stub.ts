import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyInternalToken } from './api-helpers';

/**
 * A stand-in for audit-service's internal correction-target lookup, for
 * identity's own integration suites (AUD-003 correction).
 *
 * Why a stand-in and not audit-service: AGENTS.md A-02 forbids an identity test
 * from importing audit-service's source, and these suites prove identity's side
 * of the boundary — what it asks, how it authenticates, and what it does with
 * each answer. audit-service's own suites prove the real endpoint, and the
 * black-box Playwright scenario proves the two agree over a real network.
 *
 * It is not a permissive fake. It answers only a request that carries a genuine
 * internal token minted by the booted identity-service **for audit-service**,
 * with purpose `SERVICE` and no tenant claim — a request that does not is
 * refused `401`, exactly as the real guard would — and it answers only the
 * exact `(id, occurredAt)` it was told about.
 */

export interface StubTarget {
  id: string;
  organizationId: string | null;
  occurredAt: string;
}

export interface ObservedLookup {
  id: string;
  occurredAt: string | null;
  headers: IncomingMessage['headers'];
  callerService?: string;
  purpose?: string;
  organizationId?: string;
}

export interface AuditStub {
  url: string;
  targets: Map<string, StubTarget>;
  lookups: ObservedLookup[];
  /** When set, every lookup answers this status with an opaque body. */
  failWith: number | null;
  /** When set, the stub answers every lookup with this instant instead. */
  answerAt: string | null;
  close(): Promise<void>;
}

const ROUTE = /^\/v1\/internal\/audit-events\/([^/?]+)$/;

export async function startAuditStub(): Promise<AuditStub> {
  const stub: Omit<AuditStub, 'url' | 'close'> = {
    targets: new Map(),
    lookups: [],
    failWith: null,
    answerAt: null,
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://stub.invalid');
      const match = ROUTE.exec(url.pathname);
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.method !== 'GET' || !match) return send(404, { code: 'NOT_FOUND' });

      const id = decodeURIComponent(match[1]!);
      const observed: ObservedLookup = {
        id,
        occurredAt: url.searchParams.get('occurredAt'),
        headers: request.headers,
      };
      stub.lookups.push(observed);

      const token = request.headers['x-internal-token'];
      if (typeof token !== 'string') return send(401, { code: 'UNAUTHENTICATED' });
      try {
        const claims = await verifyInternalToken(token, 'audit-service');
        observed.callerService = claims.callerService;
        observed.purpose = claims.purpose;
        observed.organizationId = claims.organizationId;
      } catch {
        return send(401, { code: 'UNAUTHENTICATED' });
      }
      if (observed.callerService !== 'identity-service' || observed.purpose !== 'SERVICE') {
        return send(403, { code: 'FORBIDDEN' });
      }

      if (stub.failWith !== null) {
        return send(stub.failWith, { code: 'INTERNAL_ERROR', detail: 'stub-internal-detail' });
      }

      const target = stub.targets.get(id);
      if (!target || target.occurredAt !== observed.occurredAt) {
        return send(404, { code: 'NOT_FOUND' });
      }
      return send(200, { ...target, occurredAt: stub.answerAt ?? target.occurredAt });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(stub, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  });
}
