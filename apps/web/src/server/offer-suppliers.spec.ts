/**
 * @jest-environment node
 */
import { GatewayRequestError } from './gateway';
import { fetchOfferSuppliers, MAX_DIRECTORY_PAGES } from './offer-suppliers';
import type { WebSession } from './session';
import { actingAccessToken } from '@/test/session-token';

const mockCallGateway = jest.fn();
jest.mock('./gateway', () => ({
  ...jest.requireActual('./gateway'),
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
}));

const session: WebSession = {
  subject: 'USR_1',
  username: 'buyer',
  organizationId: 'ORG_BUYER',
  accessToken: actingAccessToken('ORG_BUYER'),
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

const entry = (organizationId: string) => ({
  id: `SUP_${organizationId}`,
  organizationId,
  displayName: `نام ${organizationId}`,
  status: 'ACTIVE',
  capabilities: ['GOODS_SUPPLY'],
  qualifiedFor: ['GOODS_SUPPLY'],
  registeredAt: '2026-08-01T08:00:00.000Z',
});

const page = (ids: string[], nextCursor: string | null) => ({
  data: { items: ids.map(entry), nextCursor, hasMore: nextCursor !== null },
  correlationId: 'COR_1',
});

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
  mockCallGateway.mockReset();
});

describe('fetchOfferSuppliers', () => {
  it('finds the wanted organizations across pages and stops once all are found', async () => {
    mockCallGateway
      .mockResolvedValueOnce(page(['ORG_A', 'ORG_X'], 'C1'))
      .mockResolvedValueOnce(page(['ORG_B'], 'C2'));
    const found = await fetchOfferSuppliers(session, ['ORG_A', 'ORG_B']);
    expect([...found.keys()].sort()).toEqual(['ORG_A', 'ORG_B']);
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
  });

  it('asks for nothing when there are no offers', async () => {
    expect((await fetchOfferSuppliers(session, [])).size).toBe(0);
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it('leaves an unlisted organization out rather than guessing', async () => {
    mockCallGateway.mockResolvedValueOnce(page(['ORG_A'], null));
    const found = await fetchOfferSuppliers(session, ['ORG_A', 'ORG_GONE']);
    expect([...found.keys()]).toEqual(['ORG_A']);
  });

  it('keeps what an earlier page found when a later page fails', async () => {
    mockCallGateway
      .mockResolvedValueOnce(page(['ORG_A'], 'C1'))
      .mockRejectedValueOnce(new GatewayRequestError(503, 'COR_2'));
    const found = await fetchOfferSuppliers(session, ['ORG_A', 'ORG_B']);
    expect([...found.keys()]).toEqual(['ORG_A']);
  });

  it.each([
    ['a refusal', new GatewayRequestError(403, 'COR_3')],
    ['an unexpected error', new Error('socket hang up')],
  ])('answers nothing (unknown) on %s, never throws', async (_name, error) => {
    mockCallGateway.mockRejectedValueOnce(error);
    expect((await fetchOfferSuppliers(session, ['ORG_A'])).size).toBe(0);
  });

  it('treats a malformed page as unknown', async () => {
    mockCallGateway.mockResolvedValueOnce({ data: { items: [{ id: 1 }] }, correlationId: 'C' });
    expect((await fetchOfferSuppliers(session, ['ORG_A'])).size).toBe(0);
  });

  it('walks a bounded number of pages', async () => {
    mockCallGateway.mockResolvedValue(page(['ORG_X'], 'MORE'));
    await fetchOfferSuppliers(session, ['ORG_A']);
    expect(mockCallGateway).toHaveBeenCalledTimes(MAX_DIRECTORY_PAGES);
  });
});
