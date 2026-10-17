import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InternalTokenService } from '@rasta/nest-common';
import type { StatementFact } from '../src/provenance/source-facts.client';

/**
 * contract-service, as a local HTTP stand-in for `GET /v1/internal/statements/{id}`
 * that holds the real route's lock: an `X-Internal-Token` and no
 * `Authorization`, verified for `contract-service`, minted by
 * `economic-service` as a `SERVICE` token, signed for an organization — and
 * the statement answered only for that organization, its employer; every
 * other organization's token (the contractor's included) gets `404 Statement
 * not found`.
 */
export class StubContractService {
  readonly statements = new Map<string, StatementFact>();
  readonly asked: { statementId: string; organizationId: string }[] = [];
  mode: 'up' | 'down' | 'hang' = 'up';
  url = '';
  private server?: http.Server;
  private readonly held: http.ServerResponse[] = [];

  constructor(private readonly tokens: InternalTokenService) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.answer(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.held) res.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  record(fact: StatementFact): StatementFact {
    this.statements.set(fact.statementId, fact);
    return fact;
  }

  private async answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const match = /^\/v1\/internal\/statements\/([^/?]+)$/.exec(req.url ?? '');
    if (!match) return send(404, { code: 'NOT_FOUND', message: `Cannot GET ${req.url}` });
    const token = req.headers['x-internal-token'];
    if (typeof token !== 'string' || req.headers.authorization !== undefined) {
      return send(401, { code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    let claims;
    try {
      claims = await this.tokens.verify(token, 'contract-service');
    } catch {
      return send(401, { code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    if (claims.callerService !== 'economic-service' || claims.purpose !== 'SERVICE') {
      return send(403, { code: 'FORBIDDEN', message: 'Forbidden' });
    }
    if (!claims.organizationId) {
      return send(403, { code: 'SERVICE_TENANT_CONTEXT_INVALID', message: 'No tenant' });
    }
    const statementId = decodeURIComponent(match[1]!);
    this.asked.push({ statementId, organizationId: claims.organizationId });
    // Down or silent only once the question was asked, with a valid token.
    if (this.mode === 'hang') {
      this.held.push(res);
      return;
    }
    if (this.mode === 'down') return send(503, { code: 'INTERNAL_ERROR', message: 'down' });
    const fact = this.statements.get(statementId);
    if (!fact || fact.payerOrganizationId !== claims.organizationId) {
      return send(404, { code: 'NOT_FOUND', message: 'Statement not found' });
    }
    send(200, fact);
  }
}
