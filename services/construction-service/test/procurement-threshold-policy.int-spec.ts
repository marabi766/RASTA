import { createServer, type Server } from 'node:http';
import { InternalTokenService } from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { ProcurementThresholdPolicy } from '../src/organization/procurement-threshold-policy';
import { asAdmin, testEnv } from './helpers';

const ORGANIZATION = 'ORG-threshold-contract';
const range = { minAmountMinor: '0', maxAmountMinor: null, mode: 'WARN' };
const value = { FORMAL_TENDER: range, INQUIRY: range, RFP: range, MARKETPLACE_DEAL: range };

describe('organization procurement threshold policy consumer contract', () => {
  let server: Server;
  let client: ProcurementThresholdPolicy;
  let tokens: InternalTokenService;
  let body: unknown;
  let status: number;
  let contentLength: string | undefined;
  let path: string | undefined;
  let token: string | undefined;
  let stallBody = false;

  beforeAll(async () => {
    tokens = new InternalTokenService(randomBytes(32).toString('hex'), 'rasta-internal', 300);
    server = createServer((request, response) => {
      path = request.url;
      token = request.headers['x-internal-token'] as string | undefined;
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      if (stallBody) {
        response.flushHeaders();
        return;
      }
      if (contentLength) response.setHeader('content-length', contentLength);
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    client = new ProcurementThresholdPolicy(
      testEnv({
        ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${address.port}`,
        CONSTRUCTION_ORGANIZATION_REQUEST_TIMEOUT_MS: '1000',
      }),
      tokens,
    );
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    status = 200;
    body = { organizationId: ORGANIZATION, policy: { id: 'POL-1', value } };
    contentLength = undefined;
    stallBody = false;
  });

  it('accepts the effective table and signs a request for exactly the acting tenant', async () => {
    expect(await asAdmin(ORGANIZATION, () => client.get(ORGANIZATION))).toEqual({
      id: 'POL-1',
      value,
    });
    expect(path).toBe(`/v1/organizations/${ORGANIZATION}/procurement-thresholds`);
    expect(token).toBeDefined();
    // The existing InternalTokenService verifies the signature/audience in provider API tests.
    const claims = JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims.org_id).toBe(ORGANIZATION);
  });
  it('only an explicit null policy means no table', async () => {
    body = { organizationId: ORGANIZATION, policy: null };
    expect(await asAdmin(ORGANIZATION, () => client.get(ORGANIZATION))).toBeNull();
  });
  it.each([403, 404, 500, 503])('fails closed on HTTP %s', async (code) => {
    status = code;
    await expect(asAdmin(ORGANIZATION, () => client.get(ORGANIZATION))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
  it.each([
    {},
    { organizationId: 'OTHER', policy: null },
    { organizationId: ORGANIZATION, policy: { id: 'POL-1', value: {} } },
    {
      organizationId: ORGANIZATION,
      policy: { id: 'POL-1', value: { ...value, RFP: { ...range, mode: 'ALLOW' } } },
    },
    'not json',
  ])('fails closed on malformed or wrong-tenant configuration %#', async (bad) => {
    body = bad;
    await expect(asAdmin(ORGANIZATION, () => client.get(ORGANIZATION))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
  it('caps the complete response body', async () => {
    body = 'x'.repeat(33_000);
    await expect(asAdmin(ORGANIZATION, () => client.get(ORGANIZATION))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
  it('bounds a stalled response body with the same request deadline', async () => {
    stallBody = true;
    await expect(asAdmin(ORGANIZATION, () => client.get(ORGANIZATION))).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});
