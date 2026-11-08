/**
 * @jest-environment node
 */
import { GatewayRequestError } from './gateway';
import {
  DIRECTORY_BATCH_SIZE,
  fetchOfferSuppliers,
  MAX_BATCHES,
  MAX_PAGES_PER_BATCH,
} from './offer-suppliers';
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

const ORG_A = 'ORG-OFFER-A';
const ORG_B = 'ORG-OFFER-B';
const org = (i: number) => `ORG-OFFER-${String(i).padStart(4, '0')}`;

/** The `organizationId` values one gateway call asked for. */
const pathOf = (call: number): string =>
  String((mockCallGateway.mock.calls[call]?.[0] as { path?: string } | undefined)?.path);
const askedIn = (call: number): string[] =>
  new URL(pathOf(call), 'http://x').searchParams.getAll('organizationId');

describe('fetchOfferSuppliers', () => {
  it('asks the directory for exactly the wanted organizations, once', async () => {
    mockCallGateway.mockResolvedValueOnce(page([ORG_A, ORG_B], null));
    const found = await fetchOfferSuppliers(session, [ORG_A, ORG_B, ORG_A]);
    expect([...found.keys()].sort()).toEqual([ORG_A, ORG_B]);
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(askedIn(0)).toEqual([ORG_A, ORG_B]);
    expect(pathOf(0)).toMatch(/^\/v1\/suppliers\?/);
  });

  it('asks for nothing when there are no offers', async () => {
    expect((await fetchOfferSuppliers(session, [])).size).toBe(0);
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it(`splits more than ${DIRECTORY_BATCH_SIZE} organizations into batches of at most that`, async () => {
    const ids = Array.from({ length: DIRECTORY_BATCH_SIZE + 1 }, (_, i) => org(i));
    mockCallGateway.mockImplementation(({ path }: { path: string }) => {
      const asked = new URL(path, 'http://x').searchParams.getAll('organizationId');
      return Promise.resolve(page(asked, null));
    });
    const found = await fetchOfferSuppliers(session, ids);
    expect(found.size).toBe(ids.length);
    expect(mockCallGateway).toHaveBeenCalledTimes(2);
    expect(askedIn(0)).toHaveLength(DIRECTORY_BATCH_SIZE);
    expect(askedIn(1)).toEqual([org(DIRECTORY_BATCH_SIZE)]);
  });

  it('bounds the number of batches; the rest stays unknown', async () => {
    const ids = Array.from({ length: DIRECTORY_BATCH_SIZE * (MAX_BATCHES + 1) }, (_, i) => org(i));
    mockCallGateway.mockResolvedValue(page([], null));
    await fetchOfferSuppliers(session, ids);
    expect(mockCallGateway).toHaveBeenCalledTimes(MAX_BATCHES);
  });

  it('never sends an id the service would refuse, and leaves it unknown', async () => {
    mockCallGateway.mockResolvedValueOnce(page([ORG_A], null));
    const found = await fetchOfferSuppliers(session, [ORG_A, 'not an org', 'ORG_1']);
    expect([...found.keys()]).toEqual([ORG_A]);
    expect(askedIn(0)).toEqual([ORG_A]);
  });

  it('leaves an unlisted organization out rather than guessing', async () => {
    mockCallGateway.mockResolvedValueOnce(page([ORG_A], null));
    const found = await fetchOfferSuppliers(session, [ORG_A, 'ORG-GONE']);
    expect([...found.keys()]).toEqual([ORG_A]);
  });

  it('ignores an entry for an organization it did not ask for', async () => {
    mockCallGateway.mockResolvedValueOnce(page([ORG_A, ORG_B], null));
    const found = await fetchOfferSuppliers(session, [ORG_A]);
    expect([...found.keys()]).toEqual([ORG_A]);
  });

  it('keeps what one batch found when another fails', async () => {
    const ids = Array.from({ length: DIRECTORY_BATCH_SIZE + 1 }, (_, i) => org(i));
    mockCallGateway
      .mockResolvedValueOnce(page([org(0)], null))
      .mockRejectedValueOnce(new GatewayRequestError(503, 'COR_2'));
    const found = await fetchOfferSuppliers(session, ids);
    expect([...found.keys()]).toEqual([org(0)]);
  });

  it.each([
    ['a refusal', new GatewayRequestError(403, 'COR_3')],
    ['a 400', new GatewayRequestError(400, 'COR_4')],
    ['an unexpected error', new Error('socket hang up')],
  ])('answers nothing (unknown) on %s, never throws', async (_name, error) => {
    mockCallGateway.mockRejectedValueOnce(error);
    expect((await fetchOfferSuppliers(session, [ORG_A])).size).toBe(0);
  });

  it('treats a malformed page as unknown', async () => {
    mockCallGateway.mockResolvedValueOnce({ data: { items: [{ id: 1 }] }, correlationId: 'C' });
    expect((await fetchOfferSuppliers(session, [ORG_A])).size).toBe(0);
  });

  it('follows a batch for a bounded number of pages, with the same ids', async () => {
    mockCallGateway.mockResolvedValue(page([], 'MORE'));
    await fetchOfferSuppliers(session, [ORG_A]);
    expect(mockCallGateway).toHaveBeenCalledTimes(MAX_PAGES_PER_BATCH);
    expect(askedIn(1)).toEqual([ORG_A]);
    expect(pathOf(1)).toContain('cursor=MORE');
  });
});
