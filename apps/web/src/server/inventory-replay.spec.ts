/**
 * @jest-environment node
 */
import {
  inventoryReplayWindowSeconds,
  mintInventoryStamp,
  mintInventorySubmission,
  verifyInventoryStamp,
} from './inventory-replay';
import { mintSubmissionId, isBoundSubmissionId } from './submission';
import type { WebSession } from './session';

/**
 * The inventory replay stamp: what it binds a submission to, and until when
 * the same request may be sent — `return-replay.spec.ts`'s cases, for the
 * inventory commands, plus the shipment version a move is bound to.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = {
  subject: 'user-1',
  username: 'operator',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 1_900_000_600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const ENV = { WEB_INVENTORY_IDEMPOTENCY_TTL_HOURS: 1, WEB_INVENTORY_REPLAY_MARGIN_SECONDS: 600 };
const NOW = 1_900_000_000_000;
const SUB = mintSubmissionId(SESSION);
const WAREHOUSES = { kind: 'WAREHOUSES' } as const;
const WAREHOUSE = { kind: 'WAREHOUSE', warehouseId: 'WHS_1' } as const;
const SHIPMENT = { kind: 'SHIPMENT', shipmentId: 'SHP_1' } as const;
const RECEIVE = { command: 'RECEIVE_STOCK', scope: WAREHOUSE, expectedVersion: null } as const;
const DISPATCH = { command: 'DISPATCH_SHIPMENT', scope: SHIPMENT, expectedVersion: 1 } as const;

it('the window is the retention less the margin', () => {
  expect(inventoryReplayWindowSeconds(ENV)).toBe(3000);
});

it('binds a receipt to its warehouse and its command', () => {
  const { token, until } = mintInventoryStamp(SESSION, RECEIVE, SUB, NOW, ENV);
  expect(until).toBe(NOW + 3000 * 1000);
  expect(verifyInventoryStamp(SESSION, token, WAREHOUSE, SUB, NOW + 1000, ENV)).toEqual({
    token,
    until,
    command: 'RECEIVE_STOCK',
    expectedVersion: null,
  });
});

it('a move’s stamp carries the version the page showed, and only there', () => {
  const { token } = mintInventoryStamp(SESSION, DISPATCH, SUB, NOW, ENV);
  expect(verifyInventoryStamp(SESSION, token, SHIPMENT, SUB, NOW, ENV)).toMatchObject({
    command: 'DISPATCH_SHIPMENT',
    expectedVersion: 1,
  });
  // A version-less stamp for a shipment, or a versioned one for a warehouse, is no stamp.
  const bare = mintInventoryStamp(SESSION, { ...DISPATCH, expectedVersion: null }, SUB, NOW, ENV);
  expect(verifyInventoryStamp(SESSION, bare.token, SHIPMENT, SUB, NOW, ENV)).toBeNull();
  const versioned = mintInventoryStamp(SESSION, { ...RECEIVE, expectedVersion: 3 }, SUB, NOW, ENV);
  expect(verifyInventoryStamp(SESSION, versioned.token, WAREHOUSE, SUB, NOW, ENV)).toBeNull();
});

it('a stamp never passes on another kind of slot', () => {
  const warehouse = mintInventoryStamp(SESSION, RECEIVE, SUB, NOW, ENV);
  expect(verifyInventoryStamp(SESSION, warehouse.token, WAREHOUSES, SUB, NOW, ENV)).toBeNull();
  expect(verifyInventoryStamp(SESSION, warehouse.token, SHIPMENT, SUB, NOW, ENV)).toBeNull();
  const created = mintInventoryStamp(
    SESSION,
    { command: 'CREATE_WAREHOUSE', scope: WAREHOUSES, expectedVersion: null },
    SUB,
    NOW,
    ENV,
  );
  expect(verifyInventoryStamp(SESSION, created.token, WAREHOUSES, SUB, NOW, ENV)?.command).toBe(
    'CREATE_WAREHOUSE',
  );
  expect(verifyInventoryStamp(SESSION, created.token, WAREHOUSE, SUB, NOW, ENV)).toBeNull();
});

it.each([
  ['another warehouse', { kind: 'WAREHOUSE', warehouseId: 'WHS_2' } as const, SUB],
  ['another submission id', WAREHOUSE, mintSubmissionId(SESSION)],
])('refuses %s', (_name, scope, submission) => {
  const { token } = mintInventoryStamp(SESSION, RECEIVE, SUB, NOW, ENV);
  expect(verifyInventoryStamp(SESSION, token, scope, submission, NOW, ENV)).toBeNull();
});

it('refuses another login’s stamp', () => {
  const { token } = mintInventoryStamp(SESSION, RECEIVE, SUB, NOW, ENV);
  expect(
    verifyInventoryStamp({ ...SESSION, subject: 'someone-else' }, token, WAREHOUSE, SUB, NOW, ENV),
  ).toBeNull();
});

it('refuses past its deadline, and past a retention shortened since', () => {
  const { token } = mintInventoryStamp(SESSION, RECEIVE, SUB, NOW, ENV);
  expect(verifyInventoryStamp(SESSION, token, WAREHOUSE, SUB, NOW + 3001 * 1000, ENV)).toBeNull();

  const long = { ...ENV, WEB_INVENTORY_IDEMPOTENCY_TTL_HOURS: 24 };
  const issued = mintInventoryStamp(SESSION, RECEIVE, SUB, NOW, long).token;
  const later = NOW + 2 * 60 * 60 * 1000;
  expect(verifyInventoryStamp(SESSION, issued, WAREHOUSE, SUB, later, long)).not.toBeNull();
  expect(verifyInventoryStamp(SESSION, issued, WAREHOUSE, SUB, later, ENV)).toBeNull();
});

it('refuses anything that is not a stamp', () => {
  for (const token of [null, '', 'x.y', 42]) {
    expect(verifyInventoryStamp(SESSION, token, WAREHOUSE, SUB, NOW, ENV)).toBeNull();
  }
});

it('a submission is a bound id with its own stamp', () => {
  const submission = mintInventorySubmission(SESSION, RECEIVE, NOW);
  expect(isBoundSubmissionId(submission.id, SESSION)).toBe(true);
  expect(
    verifyInventoryStamp(SESSION, submission.replay.token, WAREHOUSE, submission.id, NOW),
  ).not.toBeNull();
});
