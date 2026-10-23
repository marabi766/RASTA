import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { InternalTokenService, RastaError } from '@rasta/nest-common';
import type { ProcurementEnv } from '../config/env';
import {
  SupplierStandingClient,
  inviteeVerdictOf,
  type StandingOfOrganization,
} from './supplier-standing.client';

/**
 * The read of an invitee's standing (ADR-070 § 3, § 7): supplier-service's own answer, now, with a
 * tenant-less internal token in `X-Internal-Token` — and fail closed on anything else.
 */

const SECRET = randomBytes(24).toString('hex');
const ORG = 'ORG_01JABCDEFGHJKMNPQRSTVWXYZ0';
const AT = '2026-10-22T08:00:00.000Z';

const standing = (overrides: Partial<StandingOfOrganization> = {}): StandingOfOrganization => ({
  organizationId: ORG,
  contractingApprovedAt: null,
  goodsSupplyApprovedAt: AT,
  suspensions: [],
  asOf: AT,
  ...overrides,
});

describe('inviteeVerdictOf', () => {
  it('an open suspension wins; then no GOODS_SUPPLY approval; otherwise eligible', () => {
    const open = { suspensionId: 'SUS_1', suspendedAt: AT, reinstatedAt: null };
    const closed = { ...open, reinstatedAt: AT };
    expect(inviteeVerdictOf(standing())).toBe('ELIGIBLE');
    expect(inviteeVerdictOf(standing({ suspensions: [closed] }))).toBe('ELIGIBLE');
    expect(inviteeVerdictOf(standing({ suspensions: [closed, open] }))).toBe('SUSPENDED');
    expect(inviteeVerdictOf(standing({ goodsSupplyApprovedAt: null }))).toBe('NOT_QUALIFIED');
    // A contracting approval is construction's: it qualifies nobody to supply goods.
    expect(
      inviteeVerdictOf(standing({ goodsSupplyApprovedAt: null, contractingApprovedAt: AT })),
    ).toBe('NOT_QUALIFIED');
  });
});

describe('SupplierStandingClient', () => {
  let server: Server;
  let url: string;
  let answer: (request: IncomingMessage, response: ServerResponse) => void;
  const seen: IncomingMessage[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push(request);
      answer(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  const tokens = new InternalTokenService(SECRET, 'rasta-internal', 300);
  const client = (overrides: Partial<ProcurementEnv> = {}) =>
    new SupplierStandingClient(
      {
        SUPPLIER_SERVICE_URL: url,
        PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS: 2000,
        ...overrides,
      } as ProcurementEnv,
      tokens,
    );
  const json =
    (body: unknown, status = 200) =>
    (_: IncomingMessage, response: ServerResponse) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error instanceof RastaError ? error.code : 'OTHER';
    }
    return 'NONE';
  };

  it('asks for one organization with a tenant-less service token in X-Internal-Token, never Authorization', async () => {
    answer = json(standing());

    await expect(client().fetchStanding(ORG)).resolves.toEqual(standing());

    const [request] = seen;
    expect(request?.url).toBe(`/v1/suppliers/standing-snapshot/${ORG}`);
    expect(request?.headers.authorization).toBeUndefined();
    const claims = await tokens.verify(
      String(request?.headers['x-internal-token']),
      'supplier-service',
    );
    expect(claims).toMatchObject({ callerService: 'procurement-service' });
    expect((claims as { organizationId?: string }).organizationId).toBeUndefined();
  });

  it.each([
    ['a status that is not 200', json(standing(), 404)],
    [
      'a body that is not JSON',
      (_: IncomingMessage, response: ServerResponse) => response.end('<html>'),
    ],
    ['a field the contract does not name', json({ ...standing(), reason: 'fraud' })],
    [
      'no GOODS_SUPPLY field (an older supplier-service)',
      json((({ goodsSupplyApprovedAt: _, ...rest }) => rest)(standing())),
    ],
    ['an answer about another organization', json(standing({ organizationId: 'ORG_OTHER' }))],
    ['a body over the size bound', json({ ...standing(), pad: 'x'.repeat(300 * 1024) })],
  ])('fails closed on %s: 503 UPSTREAM_UNAVAILABLE', async (_label, handler) => {
    answer = handler;
    expect(await codeOf(client().fetchStanding(ORG))).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('past its timeout is 504 UPSTREAM_TIMEOUT; unreachable is 503', async () => {
    answer = (_, response) => setTimeout(() => json(standing())(_, response), 1000);
    expect(
      await codeOf(client({ PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS: 100 }).fetchStanding(ORG)),
    ).toBe('UPSTREAM_TIMEOUT');

    expect(
      await codeOf(client({ SUPPLIER_SERVICE_URL: 'http://127.0.0.1:1' }).fetchStanding(ORG)),
    ).toBe('UPSTREAM_UNAVAILABLE');
  });
});
