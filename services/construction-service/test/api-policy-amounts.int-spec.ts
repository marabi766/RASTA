import { inspect } from 'node:util';
import request from 'supertest';
import { ulid } from 'ulid';
import { EXCEPTION_FILTER_LOGGER, runUnscoped } from '@rasta/nest-common';
import { actor, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup } from './helpers';

/**
 * Task 011 (#385 r2 F1): with both bounds present, the step's range refinement ran after one had
 * failed its pattern — zod runs an object's refinement on a dirty value — and `BigInt` threw out
 * of the validation pipe: `POST /v1/approval-policies` answered 500, and the filter logged the
 * client's text (`policy.controller.ts` → `approval/dto.ts` → pipe → `exception.filter.ts`).
 * Through the real application, as the union administrator above the organization, so the
 * request reaches the validator.
 */
describe('POST /v1/approval-policies with a malformed amount bound', () => {
  const SENTINEL = 'private-invoice-reference-123';
  const PATTERN = 'An amount is a non-negative integer string in rial minor units';

  let api: ApiHarness;
  const organizations: string[] = [];
  const tenant = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };
  const http = () => request(api.app.getHttpServer());
  const setter = (org: string) => actor(org, ['UNION_ADMIN']);

  beforeAll(async () => {
    api = await startApi();
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });

  function governed(): { org: string; union: string } {
    const org = tenant('POLICY-AMOUNT');
    const union = tenant('POLICY-AMOUNT-UNION');
    api.hierarchy.adopt(union, org);
    return { org, union };
  }

  const body = (org: string, bounds: Record<string, string>) => ({
    organizationId: org,
    workflowKey: 'project.execution',
    label: 'Council approval',
    rationale: 'Resolution recorded by the council',
    steps: [
      {
        approvalType: 'Council approval',
        authorityOrganizationId: org,
        authorityRole: 'ORGANIZATION_ADMIN',
        authorityLabel: 'Village council',
        ...bounds,
      },
    ],
  });

  const policiesOf = (organizationId: string) =>
    runUnscoped('the suite counts the policies a refusal must not write', () =>
      api.prisma.client.approvalPolicy.count({ where: { organizationId } }),
    );
  const keysOf = (key: string) =>
    runUnscoped('the suite looks for the key a refusal must not reserve', () =>
      api.prisma.client.idempotencyKey.count({ where: { key } }),
    );

  /** Every line the application could write: the filter's logger and the streams. */
  function captureLogs(): { text: () => string; restore: () => void } {
    const logger = api.app.get<Record<string, unknown>>(EXCEPTION_FILTER_LOGGER);
    const spies = [
      ...['fatal', 'error', 'warn', 'info', 'debug', 'trace']
        .filter((level) => typeof logger[level] === 'function')
        .map((level) => jest.spyOn(logger as Record<string, () => void>, level)),
      jest.spyOn(process.stdout, 'write'),
      jest.spyOn(process.stderr, 'write'),
    ];
    return {
      text: () =>
        inspect(
          spies.flatMap((spy): unknown[][] => spy.mock.calls),
          { depth: null, maxStringLength: null },
        ),
      restore: () => spies.forEach((spy) => spy.mockRestore()),
    };
  }

  it.each([
    ['a fractional minimum', { minAmountMinor: '1.5', maxAmountMinor: '100' }, ['minAmountMinor']],
    ['a minimum in letters', { minAmountMinor: 'abc', maxAmountMinor: '100' }, ['minAmountMinor']],
    ['an empty minimum', { minAmountMinor: '', maxAmountMinor: '100' }, ['minAmountMinor']],
    [
      'a free-text minimum',
      { minAmountMinor: SENTINEL, maxAmountMinor: '100' },
      ['minAmountMinor'],
    ],
    ['a fractional maximum', { minAmountMinor: '5', maxAmountMinor: '1.5' }, ['maxAmountMinor']],
    ['a maximum in letters', { minAmountMinor: '5', maxAmountMinor: 'abc' }, ['maxAmountMinor']],
    ['an empty maximum', { minAmountMinor: '5', maxAmountMinor: '' }, ['maxAmountMinor']],
    ['a free-text maximum', { minAmountMinor: '5', maxAmountMinor: SENTINEL }, ['maxAmountMinor']],
    [
      'two free-text bounds',
      { minAmountMinor: SENTINEL, maxAmountMinor: SENTINEL },
      ['minAmountMinor', 'maxAmountMinor'],
    ],
  ])(
    'refuses %s with the standard 400 — nothing written, the text in no log line',
    async (_label, bounds, fields) => {
      const { org, union } = governed();
      const key = `policy-amount-${ulid()}`;
      const logs = captureLogs();

      let response: request.Response;
      try {
        response = await http()
          .post('/v1/approval-policies')
          .set('authorization', `Bearer ${setter(union)}`)
          .set('idempotency-key', key)
          .send(body(org, bounds))
          .expect(400);
        expect(logs.text()).not.toContain(SENTINEL);
      } finally {
        logs.restore();
      }

      expect(response.body).toEqual({
        code: 'VALIDATION_FAILED',
        message: expect.any(String),
        details: fields.map((field) => ({
          path: `steps[0].${field}`,
          code: 'invalid_string',
          message: PATTERN,
        })),
        correlationId: expect.any(String),
        timestamp: expect.any(String),
        path: '/v1/approval-policies',
      });
      expect(JSON.stringify(response.body)).not.toContain(SENTINEL);
      expect(await policiesOf(org)).toBe(0);
      expect(await keysOf(key)).toBe(0);
    },
  );

  it('writes the corrected policy under the same key once, and replays it', async () => {
    const { org, union } = governed();
    const key = `policy-amount-${ulid()}`;
    // One user throughout: a replay is the same requester's (another's is IDEMPOTENCY_KEY_REUSED).
    const token = setter(union);
    const post = (bounds: Record<string, string>) =>
      http()
        .post('/v1/approval-policies')
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', key)
        .send(body(org, bounds));

    await post({ minAmountMinor: '1.5', maxAmountMinor: '100' }).expect(400);
    const first = await post({ minAmountMinor: '0', maxAmountMinor: '100' }).expect(201);
    const replay = await post({ minAmountMinor: '0', maxAmountMinor: '100' }).expect(201);

    expect(replay.body.id).toBe(first.body.id);
    expect(await policiesOf(org)).toBe(1);
  });

  it('keeps its own rules: "0" and the BIGINT maximum pass, "00" and one past it do not', async () => {
    const { org, union } = governed();
    const post = (bounds: Record<string, string>) =>
      http()
        .post('/v1/approval-policies')
        .set('authorization', `Bearer ${setter(union)}`)
        .send(body(org, bounds));

    await post({ minAmountMinor: '0', maxAmountMinor: '9223372036854775807' }).expect(201);
    const zeros = await post({ minAmountMinor: '00', maxAmountMinor: '100' }).expect(400);
    expect(zeros.body.details).toEqual([
      { path: 'steps[0].minAmountMinor', code: 'invalid_string', message: PATTERN },
    ]);
    const past = await post({ maxAmountMinor: '9223372036854775808' }).expect(400);
    expect(past.body.details).toEqual([
      {
        path: 'steps[0].maxAmountMinor',
        code: 'custom',
        message: 'The amount exceeds the largest storable value',
      },
    ]);
  });

  it('still refuses a union that is not above the organization, with good bounds', async () => {
    const { org } = governed();
    const stranger = tenant('POLICY-AMOUNT-STRANGER');

    const response = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${setter(stranger)}`)
      .send(body(org, { minAmountMinor: '0', maxAmountMinor: '100' }))
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN');
    expect(await policiesOf(org)).toBe(0);
  });
});
