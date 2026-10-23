import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ulid } from 'ulid';

/**
 * supplier-service's one route procurement-service asks (plan PR 5,
 * `GET /v1/suppliers/standing-snapshot/{organizationId}`), served from memory on an ephemeral port:
 * the real `SupplierStandingClient` reads it over real HTTP, token, strict parse and all. The body
 * is the owner's shape (supplier-service `standingOf`), so a test cannot pass on an answer the real
 * service would never give; an organization nobody registered answers as supplier-service answers
 * one with no profile — no approval, no episode.
 */

export type Standing =
  /** An approved GOODS_SUPPLY qualification and no open suspension. */
  | 'ELIGIBLE'
  /** Approved, but suspended now. */
  | 'SUSPENDED'
  /** A CONTRACTING approval only: qualified to build, not to supply goods. */
  | 'CONTRACTING_ONLY'
  /** supplier-service failing: 500. */
  | 'DOWN'
  /** An answer about another organization. */
  | 'SOMEONE_ELSE'
  /** An answer only after `slowMs`. */
  | 'SLOW';

export interface SupplierStub {
  readonly url: string;
  /** Every organization asked about, in order, with the token it was asked with. */
  readonly asked: {
    organizationId: string;
    internalToken: string | undefined;
    authorization: string | undefined;
  }[];
  set(organizationId: string, standing: Standing): void;
  /** A fresh organization with this standing. */
  organization(standing?: Standing): string;
  /** Holds the answer for one organization until the returned release is called. */
  park(organizationId: string): { reached: Promise<void>; release: () => void };
  close(): Promise<void>;
}

const AT = '2026-01-01T00:00:00.000Z';

export async function startSupplierStub(options: { slowMs?: number } = {}): Promise<SupplierStub> {
  const standings = new Map<string, Standing>();
  const parked = new Map<string, { arrive: () => void; wait: Promise<void> }>();
  const asked: SupplierStub['asked'] = [];

  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const match = /^\/v1\/suppliers\/standing-snapshot\/([^/?]+)$/.exec(request.url ?? '');
    if (request.method !== 'GET' || !match) {
      response.writeHead(404).end();
      return;
    }
    const organizationId = decodeURIComponent(match[1]!);
    asked.push({
      organizationId,
      internalToken: request.headers['x-internal-token'] as string | undefined,
      authorization: request.headers.authorization,
    });
    const hold = parked.get(organizationId);
    if (hold) {
      hold.arrive();
      await hold.wait;
    }
    const standing = standings.get(organizationId);
    if (standing === 'DOWN') {
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"code":"INTERNAL"}');
      return;
    }
    if (standing === 'SLOW')
      await new Promise((resolve) => setTimeout(resolve, options.slowMs ?? 1000));
    const body = {
      organizationId: standing === 'SOMEONE_ELSE' ? `ORG_${ulid()}` : organizationId,
      contractingApprovedAt: standing === 'CONTRACTING_ONLY' ? AT : null,
      suspensions:
        standing === 'SUSPENDED'
          ? [{ suspensionId: `SUS_${ulid()}`, suspendedAt: AT, reinstatedAt: null }]
          : [],
      goodsSupplyApprovedAt:
        standing === 'ELIGIBLE' || standing === 'SUSPENDED' || standing === 'SLOW' ? AT : null,
      asOf: new Date().toISOString(),
    };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  const server: Server = createServer((request, response) => {
    void answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    asked,
    set: (organizationId, standing) => standings.set(organizationId, standing),
    organization: (standing = 'ELIGIBLE') => {
      const id = `ORG_${ulid()}`;
      standings.set(id, standing);
      return id;
    },
    park: (organizationId) => {
      let arrive!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => (arrive = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      parked.set(organizationId, { arrive, wait });
      return {
        reached,
        release: () => {
          parked.delete(organizationId);
          release();
        },
      };
    },
    close: async () => {
      for (const hold of parked.values()) hold.arrive();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
