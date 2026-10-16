/**
 * @jest-environment node
 */
import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';

import {
  DISPUTE_COMMAND_TABLE,
  DISPUTE_FIELD_MAPPING,
  TRANSACTION_SCHEMA,
  disputeCommandsFor,
  disputeFormValues,
  fetchTransaction,
  issueDisputeCommand,
  parseDisputeCommand,
  type Transaction,
} from './transactions';
import type { WebSession } from './session';

/**
 * One transaction and its dispute commands: the reader refuses an answer that
 * omits what it renders, the form becomes exactly the body each `.strict()` DTO
 * takes, and every way the service can answer lands on a fixed Persian outcome.
 * The copies of the service's rules are pinned in `transactions.contract.spec.ts`.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const TXN = 'TXN_01JABCDEFGHJKMNPQRSTVWXYZ';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function problem(status: number, code: string, message: string, details?: unknown[]) {
  return jsonResponse(status, {
    code,
    message,
    correlationId: 'corr-1',
    ...(details ? { details } : {}),
  });
}

/** What `toTransactionDetailView` sends, every field present. */
const WIRE = {
  id: TXN,
  organizationId: 'ORG-DEH-0001',
  counterpartyOrganizationId: 'ORG-DEH-0002',
  transactionType: 'MAINTENANCE_SERVICE',
  status: 'HELD',
  grossAmountMinor: '90071992547409931234',
  commissionAmountMinor: '0',
  netAmountMinor: '90071992547409931234',
  currency: 'IRR',
  occurredAt: '2026-10-01T08:00:00.000Z',
  sourceType: 'E2E',
  sourceReference: 'ref-1',
  disputedAt: null,
  disputeReason: null,
  settledAt: null,
  failureReason: null,
  createdAt: '2026-10-01T08:00:01.000Z',
  createdBy: 'USR-SEED-DEHYARI-ADMIN',
  legs: [],
  commission: null,
  settlement: null,
};

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function read(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(jsonResponse(status, body));
  return fetchTransaction(SESSION, TXN);
}

describe('reading one transaction', () => {
  it('asks the gateway for exactly this transaction, with the session token', async () => {
    await read(WIRE);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://gateway.test:3000/v1/transactions/${TXN}`);
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer access-token-value',
    );
  });

  it('encodes the id into the path rather than interpolating it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, WIRE));
    await fetchTransaction(SESSION, '../wallets/me');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://gateway.test:3000/v1/transactions/..%2Fwallets%2Fme',
    );
  });

  it('keeps money a decimal string, digit for digit, past 2^53', async () => {
    const result = await read(WIRE);
    expect(result.kind).toBe('OK');
    const data = (result as { data: Transaction }).data;
    expect(data.grossAmountMinor).toBe('90071992547409931234');
    expect(typeof data.netAmountMinor).toBe('string');
  });

  it('drops what nothing renders — the creator, the legs and the commission', async () => {
    const result = await read(WIRE);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('createdBy');
    expect(data).not.toHaveProperty('legs');
    expect(data).not.toHaveProperty('commission');
  });

  const REQUIRED = Object.keys(TRANSACTION_SCHEMA.shape);

  it.each(REQUIRED)(
    'answers MALFORMED when the required field `%s` is omitted, never a default',
    async (field) => {
      const rest: Record<string, unknown> = { ...WIRE };
      delete rest[field];
      expect(await read(rest)).toEqual({ kind: 'MALFORMED', correlationId: expect.any(String) });
    },
  );

  it('accepts an explicit null wherever the service types the field nullable', async () => {
    const result = await read({
      ...WIRE,
      counterpartyOrganizationId: null,
      sourceType: null,
      sourceReference: null,
      disputedAt: null,
      disputeReason: null,
      settledAt: null,
      failureReason: null,
      settlement: null,
    });
    expect(result.kind).toBe('OK');
  });

  it.each([
    ['status', null],
    ['organizationId', null],
    ['grossAmountMinor', 12],
    ['grossAmountMinor', '12.5'],
    ['netAmountMinor', '1e3'],
    ['occurredAt', 'not a date'],
    ['occurredAt', '2026-10-01'],
    ['disputedAt', '2026-10-01T08:00:00'],
    ['settlement', { id: 'SET_1' }],
  ])('answers MALFORMED for `%s` = %j', async (field, value) => {
    expect((await read({ ...WIRE, [field]: value })).kind).toBe('MALFORMED');
  });

  it('reads a dispute exactly as sent', async () => {
    const result = await read({
      ...WIRE,
      status: 'DISPUTED',
      disputedAt: '2026-10-02T09:00:00.000Z',
      disputeReason: 'کالا تحویل نشده و پاسخی هم نیامده است',
    });
    expect(result).toMatchObject({
      kind: 'OK',
      data: {
        status: 'DISPUTED',
        disputedAt: '2026-10-02T09:00:00.000Z',
        disputeReason: 'کالا تحویل نشده و پاسخی هم نیامده است',
      },
    });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ])('reads %i as %s', async (status, kind) => {
    fetchMock.mockResolvedValueOnce(problem(status, 'X', 'Transaction TXN_1 not found'));
    expect((await fetchTransaction(SESSION, TXN)).kind).toBe(kind);
  });

  it('reads an outage as UNAVAILABLE with its status', async () => {
    fetchMock.mockResolvedValueOnce(problem(503, 'UPSTREAM_UNAVAILABLE', 'down'));
    expect(await fetchTransaction(SESSION, TXN)).toMatchObject({
      kind: 'UNAVAILABLE',
      status: 503,
    });
  });
});

describe('which commands are offered', () => {
  const PAYER = 'ORG-DEH-0001';
  const PAYEE = 'ORG-DEH-0002';
  const tx = (status: string) => ({ status, organizationId: PAYER });

  it('offers the payer’s administrator a dispute from HELD and PENDING_SETTLEMENT only', () => {
    const viewer = { roles: ['ORGANIZATION_ADMIN'], organizationId: PAYER };
    expect(disputeCommandsFor(tx('HELD'), viewer)).toEqual(['DISPUTE']);
    expect(disputeCommandsFor(tx('PENDING_SETTLEMENT'), viewer)).toEqual(['DISPUTE']);
    for (const status of ['CREATED', 'DISPUTED', 'SETTLED', 'REFUNDED', 'CANCELLED', 'FAILED']) {
      expect(disputeCommandsFor(tx(status), viewer)).toEqual([]);
    }
  });

  it('never offers the payee’s administrator a dispute — the service refuses it 403', () => {
    const viewer = { roles: ['ORGANIZATION_ADMIN'], organizationId: PAYEE };
    expect(disputeCommandsFor(tx('HELD'), viewer)).toEqual([]);
  });

  it('never offers an organization administrator the resolution', () => {
    const viewer = { roles: ['ORGANIZATION_ADMIN'], organizationId: PAYER };
    expect(disputeCommandsFor(tx('DISPUTED'), viewer)).toEqual([]);
  });

  it.each(['SYSTEM_ADMIN', 'UNION_ADMIN'])(
    'offers %s the resolution of a disputed transaction, and a dispute of anyone’s',
    (role) => {
      const viewer = { roles: [role], organizationId: 'ORG-UNION-YAZD' };
      expect(disputeCommandsFor(tx('DISPUTED'), viewer)).toEqual(['RESOLVE_DISPUTE']);
      expect(disputeCommandsFor(tx('HELD'), viewer)).toEqual(['DISPUTE']);
    },
  );

  it.each(['PROCUREMENT_USER', 'FLEET_MANAGER', 'SUPPLIER', 'OPERATOR', 'DRIVER'])(
    'offers %s nothing — the route’s @Roles does not admit it',
    (role) => {
      const viewer = { roles: [role], organizationId: PAYER };
      expect(disputeCommandsFor(tx('HELD'), viewer)).toEqual([]);
      expect(disputeCommandsFor(tx('DISPUTED'), viewer)).toEqual([]);
    },
  );

  it('offers AUDITOR nothing, even alongside an admin role', () => {
    for (const role of ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN', 'UNION_ADMIN']) {
      const viewer = { roles: ['AUDITOR', role], organizationId: PAYER };
      expect(disputeCommandsFor(tx('HELD'), viewer)).toEqual([]);
      expect(disputeCommandsFor(tx('DISPUTED'), viewer)).toEqual([]);
    }
  });

  it('offers nothing when the roles could not be read', () => {
    expect(disputeCommandsFor(tx('HELD'), { roles: null, organizationId: PAYER })).toEqual([]);
  });
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe('parsing a command', () => {
  const REASON = 'کالا تحویل نشده و پاسخی هم نیامده است';

  it('builds the dispute body with the reason alone', () => {
    const parsed = parseDisputeCommand(
      disputeFormValues(form({ command: 'DISPUTE', reason: REASON, resolution: 'x'.repeat(20) })),
    );
    expect(parsed).toEqual({ ok: true, request: { command: 'DISPUTE', body: { reason: REASON } } });
  });

  it('builds the resolution body with the resolution alone', () => {
    const parsed = parseDisputeCommand(
      disputeFormValues(form({ command: 'RESOLVE_DISPUTE', resolution: REASON, reason: 'y' })),
    );
    expect(parsed).toEqual({
      ok: true,
      request: { command: 'RESOLVE_DISPUTE', body: { resolution: REASON } },
    });
  });

  it('normalises Arabic letters and whitespace the way every portal text field does', () => {
    const parsed = parseDisputeCommand(
      disputeFormValues(form({ command: 'DISPUTE', reason: '  كالا   تحويل نشده است  ' })),
    );
    expect(parsed).toEqual({
      ok: true,
      request: { command: 'DISPUTE', body: { reason: 'کالا تحویل نشده است' } },
    });
  });

  it.each([
    ['', 'دست‌کم در ۱۰ نویسه'],
    ['کوتاه', 'دست‌کم در ۱۰ نویسه'],
    ['ا'.repeat(1001), 'بیش از ۱۰۰۰ نویسه'],
  ])('refuses a reason of length %#, in Persian digits', (reason, message) => {
    const parsed = parseDisputeCommand(disputeFormValues(form({ command: 'DISPUTE', reason })));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.fieldErrors.reason).toContain(message);
  });

  it('accepts exactly the limits the service accepts', () => {
    for (const reason of ['ا'.repeat(10), 'ا'.repeat(1000)]) {
      expect(parseDisputeCommand(disputeFormValues(form({ command: 'DISPUTE', reason }))).ok).toBe(
        true,
      );
    }
  });

  it('refuses a command the portal does not know, naming none', () => {
    expect(parseDisputeCommand({ command: 'REFUND', values: EMPTY_DISPUTE_FORM })).toEqual({
      ok: false,
      command: null,
      fieldErrors: {},
    });
  });
});

describe('issuing a command', () => {
  const DISPUTE = { command: 'DISPUTE' as const, body: { reason: 'ده نویسهٔ کامل اینجا' } };
  const RESOLVE = {
    command: 'RESOLVE_DISPUTE' as const,
    body: { resolution: 'تحویل تأیید شد و اعتراض برطرف شد' },
  };

  const send = (fetchImpl: jest.Mock, request: typeof DISPUTE | typeof RESOLVE = DISPUTE) =>
    issueDisputeCommand(SESSION, TXN, request, SUBMISSION, fetchImpl as unknown as typeof fetch);

  it('has a path for every command', () => {
    expect(DISPUTE_COMMAND_TABLE).toEqual([
      { command: 'DISPUTE', path: 'dispute' },
      { command: 'RESOLVE_DISPUTE', path: 'resolve-dispute' },
    ]);
  });

  it.each([
    [DISPUTE, 'dispute', 'DISPUTED'],
    [RESOLVE, 'resolve-dispute', 'PENDING_SETTLEMENT'],
  ])(
    'posts %j to its path with the submission id as the Idempotency-Key',
    async (request, path, target) => {
      const fetchImpl = jest.fn(async () => jsonResponse(200, { ...WIRE, status: target }));
      const result = await send(fetchImpl, request);
      expect(result).toMatchObject({ kind: 'CREATED', data: { id: TXN, status: target } });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`http://gateway.test:3000/v1/transactions/${TXN}/${path}`);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['idempotency-key']).toBe(SUBMISSION);
      expect(JSON.parse(init.body as string)).toEqual(request.body);
    },
  );

  it('sends the same key again on a retry, so the service replays rather than acting twice', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { ...WIRE, status: 'DISPUTED' }));
    await send(fetchImpl);
    await send(fetchImpl);
    const keys = fetchImpl.mock.calls.map(
      (args) =>
        (((args as unknown[])[1] as RequestInit).headers as Record<string, string>)[
          'idempotency-key'
        ],
    );
    expect(keys).toEqual([SUBMISSION, SUBMISSION]);
  });

  it.each([
    ['another transaction', { ...WIRE, id: 'TXN_OTHER', status: 'DISPUTED' }],
    ['the wrong state', { ...WIRE, status: 'HELD' }],
    ['not a transaction', { nope: true }],
  ])('reads a 2xx showing %s as unconfirmed, never as done', async (_name, body) => {
    expect(await send(jest.fn(async () => jsonResponse(200, body)))).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
  });

  it('says a state that moved meanwhile in fixed Persian, never the service’s sentence', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(409, 'INVALID_STATE_TRANSITION', 'A DISPUTED transaction cannot be disputed'),
      ),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      message: DISPUTE_FIELD_MAPPING.byCode?.INVALID_STATE_TRANSITION,
    });
    expect(JSON.stringify(result)).not.toMatch(/DISPUTED|cannot/);
  });

  it('puts a validation problem on the field, in fixed Persian', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(400, 'VALIDATION_FAILED', 'Request validation failed', [
          { path: 'reason', code: 'too_small', message: 'String must contain at least 10' },
        ]),
      ),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { reason: DISPUTE_FIELD_MAPPING.byCode?.VALIDATION_FAILED },
    });
    expect(JSON.stringify(result)).not.toContain('String must');
  });

  it('never echoes service text for a code it has no sentence for (a bidi control)', async () => {
    const result = await send(
      jest.fn(async () =>
        problem(422, 'SOMETHING_NEW', 'raw ‮ text', [{ path: 'elsewhere', message: 'bad ‮ x' }]),
      ),
    );
    expect(result.kind).toBe('INVALID');
    const rendered = JSON.stringify(result, (key, value: unknown) =>
      key === 'correlationId' ? undefined : value,
    );
    expect(rendered).not.toMatch(/‮|raw|bad/i);
    expect(rendered).toContain(DISPUTE_FIELD_MAPPING.fallback);
  });

  it.each(['IDEMPOTENCY_KEY_REUSED', 'OPTIMISTIC_LOCK_FAILED', 'CONFLICT'])(
    'says %s in fixed Persian',
    async (code) => {
      const result = await send(jest.fn(async () => problem(409, code, 'English')));
      expect(result).toMatchObject({
        kind: 'INVALID',
        message: DISPUTE_FIELD_MAPPING.byCode?.[code],
      });
    },
  );

  it('reads a 409 with Retry-After as still in progress', async () => {
    const result = await send(
      jest.fn(async () =>
        jsonResponse(
          409,
          { code: 'CONFLICT', message: 'in flight', correlationId: 'corr-1' },
          { 'retry-after': '1' },
        ),
      ),
    );
    expect(result).toMatchObject({ kind: 'IN_PROGRESS' });
  });

  it.each([
    [403, 'TENANT_MISMATCH', 'FORBIDDEN'],
    [403, 'INSUFFICIENT_ROLE', 'FORBIDDEN'],
    [404, 'NOT_FOUND', 'NOT_FOUND'],
  ])('reads %i %s as %s', async (status, code, kind) => {
    expect(await send(jest.fn(async () => problem(status, code, 'x')))).toMatchObject({ kind });
  });

  it.each([500, 502, 503, 504])(
    'reads a %i as unconfirmed — the command may have committed before it',
    async (status) => {
      expect(
        await send(jest.fn(async () => problem(status, 'INTERNAL_ERROR', 'down'))),
      ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    },
  );

  it('reads a failure with no problem body, or a dropped connection, as unconfirmed', async () => {
    expect(await send(jest.fn(async () => new Response('<html>', { status: 502 })))).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
    expect(
      await send(
        jest.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      ),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });
});
