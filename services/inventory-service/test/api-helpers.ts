import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AUTH_OPTIONS,
  InternalTokenService,
  OutboxRelay,
  RastaError,
  type AuthGuardOptions,
  type TokenVerifier,
} from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InMemoryEventPublisher, KafkaEventPublisher } from '../src/outbox/kafka.publisher';
import { ReservationSweeper } from '../src/reservation/reservation.sweeper';
import { databaseUrl, newProductId } from './helpers';

/**
 * The HTTP surface, booted from the **real** `AppModule` — the harness contract-service built,
 * copied because services share no source (A-02).
 *
 * Three overrides, none a shortcut: the Kafka publisher (outbox rows are still written in the real
 * transaction), the relay and the sweeper (inert, so they do not touch a broker or expire rows
 * another suite asserts on — the sweeper is driven directly in `expiry.int-spec.ts`), and the
 * token verifier (reads a base64 claims blob; signature checking is `@rasta/nest-common`'s and
 * `tests/e2e`'s job). Everything below the verifier is real: `resolveOrganization`,
 * `X-Organization-Id`, the guards, the tenant guard, the row locks, the database.
 */

export interface ApiHarness {
  app: INestApplication;
  prisma: PrismaService;
  publisher: InMemoryEventPublisher;
  close(): Promise<void>;
}

export interface TestClaims {
  sub: string;
  rastaUserId?: string;
  organizationId?: string;
  organizationIds?: string[];
  roles: string[];
  username?: string;
}

/**
 * Encodes claims into the bearer token this harness's verifier understands. Not a JWT and
 * deliberately not shaped like one: a value that looked like a signed token would invite
 * somebody to believe this suite verifies signatures.
 */
export function bearer(claims: TestClaims): string {
  return `test.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;
}

/** A person of one organization (and optionally a member of others), with the roles given. */
export function actor(
  organizationId: string,
  roles: string[],
  options: { memberships?: string[]; rastaUserId?: string | null } = {},
): string {
  return bearer({
    sub: `sub-${ulid()}`,
    ...(options.rastaUserId === null
      ? {}
      : { rastaUserId: options.rastaUserId ?? `USR-APITEST-${ulid().slice(-8)}` }),
    organizationId,
    organizationIds: [organizationId, ...(options.memberships ?? [])],
    roles,
    username: `api-test-${organizationId}`,
  });
}

/** The default operator and reader of an organization (Q-103). */
export const orgAdmin = (organizationId: string): string =>
  actor(organizationId, ['ORGANIZATION_ADMIN']);

const decodeClaims = (token: string): TestClaims => {
  const [prefix, encoded] = token.split('.');
  if (prefix !== 'test' || !encoded) {
    throw RastaError.unauthenticated('Malformed token');
  }
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TestClaims;
};

/** The shared secret for service-to-service tokens, minted per run (AGENTS.md S-01). */
const INTERNAL_SECRET = randomBytes(24).toString('hex');

const SERVICE_NAME = 'inventory-service';

export function internalToken(callerService: string, organizationId?: string): Promise<string> {
  return new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300).issue(
    callerService,
    SERVICE_NAME,
    'SERVICE',
    organizationId,
  );
}

function applyEnvironment(overrides: Record<string, string>): () => void {
  const wanted = { ...overrides };
  const before = new Map(Object.keys(wanted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, wanted);
  process.env.DATABASE_URL = databaseUrl();
  process.env.SERVICE_NAME ??= SERVICE_NAME;
  process.env.PORT ??= '3109';
  process.env.OIDC_ISSUER_URL ??= 'http://apitest.invalid/realms/rasta';
  process.env.OIDC_JWKS_URI ??= 'http://apitest.invalid/realms/rasta/certs';
  process.env.OIDC_AUDIENCE ??= 'rasta-api';
  process.env.INTERNAL_TOKEN_SECRET = INTERNAL_SECRET;
  process.env.KAFKA_BROKERS ??= 'localhost:9092';
  // Nothing built here reaches the broker, so the app may be built without this service's
  // credential: the explicit opt-out, honoured only under NODE_ENV test (RUN-006).
  process.env.KAFKA_ALLOW_PLAINTEXT ??= 'true';
  return () => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const inert = { start: () => undefined, stop: async () => undefined };

export async function startApi(env: Record<string, string> = {}): Promise<ApiHarness> {
  const restoreEnvironment = applyEnvironment(env);
  const publisher = new InMemoryEventPublisher();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KafkaEventPublisher)
    .useValue(publisher)
    .overrideProvider(OutboxRelay)
    .useValue(inert)
    .overrideProvider(ReservationSweeper)
    .useValue(inert)
    .overrideProvider(AUTH_OPTIONS)
    .useFactory({
      factory: (): AuthGuardOptions => ({
        serviceName: SERVICE_NAME,
        // Real: an internal token is an HS256 JWT signed with a shared secret and scoped to one
        // target service, so the Zero Trust path (ADR-020, ADR-035) is exercised for what it is.
        internalTokens: new InternalTokenService(INTERNAL_SECRET, 'rasta-internal', 300),
        tokenVerifier: {
          verifyUserToken: async (token: string) => {
            const claims = decodeClaims(token);
            const organizationIds = [
              ...new Set(
                [claims.organizationId, ...(claims.organizationIds ?? [])].filter(
                  (id): id is string => typeof id === 'string' && id.length > 0,
                ),
              ),
            ];
            return {
              sub: claims.sub,
              rastaUserId: claims.rastaUserId,
              issuer: process.env.OIDC_ISSUER_URL,
              organizationId: claims.organizationId,
              organizationIds,
              // ADR-060: every role the actor holds in each membership.
              organizationRoles: organizationIds.flatMap((organizationId) =>
                claims.roles.map((role) => `${organizationId}:${role}`),
              ),
              roles: claims.roles,
              username: claims.username,
              expiresAt: Date.now() + 60_000,
            };
          },
        } as unknown as TokenVerifier,
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  // Same as main.ts: without it every `@Controller({ version: '1' })` route is mounted at a
  // path no client uses, and the whole suite would 404.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Listening once, on an ephemeral port. Handed a server that is not listening, supertest binds
  // it anew for every request — fifty concurrent requests then race fifty `listen` calls on one
  // server and connections reset, which the concurrency suites would read as a service failure.
  await app.listen(0, '127.0.0.1');

  return {
    app,
    prisma: moduleRef.get(PrismaService),
    publisher,
    close: async () => {
      await app.close();
      restoreEnvironment();
    },
  };
}

/** A fresh Idempotency-Key. */
export const key = (): string => `key-${ulid()}`;

/**
 * Shortcuts over the HTTP API for the suites, as one person of `organizationId`. Each returns the
 * supertest response, so a suite asserts the status itself.
 */
export function client(api: ApiHarness, token: string) {
  const http = () => request(api.app.getHttpServer());
  const post = (path: string, body: object, idempotencyKey = key()) =>
    http()
      .post(path)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', idempotencyKey)
      .send(body);
  const get = (path: string) => http().get(path).set('authorization', `Bearer ${token}`);
  return {
    get,
    post,
    createWarehouse: (body: object = { name: 'Central warehouse' }, k?: string) =>
      post('/v1/warehouses', body, k),
    receive: (warehouseId: string, quantity: number, productId = newProductId(), k?: string) =>
      post('/v1/stock/receipts', { warehouseId, productId, quantity }, k),
    adjust: (stockItemId: string, quantityDelta: number, k?: string) =>
      post('/v1/stock/adjustments', { stockItemId, quantityDelta }, k),
    reserve: (lines: { stockItemId: string; quantity: number }[], extra: object = {}, k?: string) =>
      post('/v1/stock/reservations', { lines, ...extra }, k),
    release: (reservationId: string, k?: string) =>
      post(`/v1/stock/reservations/${reservationId}/release`, {}, k),
    issue: (reservationId: string, k?: string) =>
      post(`/v1/stock/reservations/${reservationId}/issue`, {}, k),
    stockItem: (id: string) => get(`/v1/stock/${id}`),
    createShipment: (
      originWarehouseId: string,
      consigneeOrganizationId: string,
      extra: object = {},
      k?: string,
    ) =>
      post(
        '/v1/shipments',
        {
          originWarehouseId,
          consigneeOrganizationId,
          legs: [{ carrierName: 'Road freight', carrierReference: 'WB-1001' }],
          ...extra,
        },
        k,
      ),
    dispatch: (shipmentId: string, body: object = {}, k?: string) =>
      post(`/v1/shipments/${shipmentId}/dispatch`, body, k),
    deliver: (shipmentId: string, body: object = {}, k?: string) =>
      post(`/v1/shipments/${shipmentId}/deliver`, body, k),
    shipment: (id: string) => get(`/v1/shipments/${id}`),
    tracking: (id: string) => get(`/v1/shipments/${id}/tracking`),
  };
}

/**
 * A warehouse of `owner` and a CREATED shipment out of it to `consignee`, through the API. Returns
 * the ids.
 */
export async function seedShipment(
  api: ApiHarness,
  owner: string,
  consignee: string,
): Promise<{ warehouseId: string; shipmentId: string }> {
  const operator = client(api, orgAdmin(owner));
  const warehouse = await operator.createWarehouse();
  expect(warehouse.status).toBe(201);
  const shipment = await operator.createShipment(warehouse.body.id, consignee);
  expect(shipment.status).toBe(201);
  return { warehouseId: warehouse.body.id as string, shipmentId: shipment.body.id as string };
}

/**
 * A warehouse of `organizationId` with one stock item of `onHand` units, through the API. Returns
 * the ids.
 */
export async function seedStock(
  api: ApiHarness,
  organizationId: string,
  onHand: number,
  options: { warehouseId?: string } = {},
): Promise<{ warehouseId: string; stockItemId: string; productId: string }> {
  const owner = client(api, orgAdmin(organizationId));
  let warehouseId = options.warehouseId;
  if (!warehouseId) {
    const created = await owner.createWarehouse();
    expect(created.status).toBe(201);
    warehouseId = created.body.id as string;
  }
  const productId = newProductId();
  const received = await owner.receive(warehouseId, onHand, productId);
  expect(received.status).toBe(201);
  return { warehouseId, stockItemId: received.body.stockItem.id as string, productId };
}
