/**
 * @jest-environment node
 */

/**
 * The provider gate at submission time (Q-14, review of PR 361 r4): every
 * server action whose command `MONEY_EFFECTS` withholds reads the provider
 * again just before it sends, and while it is unknown sends nothing.
 *
 * Each case is the reviewer's trigger: the form's credentials — session, CSRF
 * token, a minted submission id and, for a repair completion, the signed
 * baseline — are obtained while the provider answers; then the read fails, in
 * each way it can, and the retained form is posted. Every module is real but
 * the session lookup and Next's redirect; `fetch` is a fake gateway answering
 * by path, so "nothing was sent" is the gateway never being asked for the
 * write — not a stub left uncalled.
 *
 * And the other side, so the gate is not simply shut: a provider that answers
 * gets the write sent, and a command that moves no money is sent without the
 * provider being asked at all.
 */

import { BASELINE_FIELD } from '@/lib/form-fields';
import { CSRF_FIELD } from '@/server/csrf';
import { sealRepairOrderBaseline } from '@/server/repair-order-commands';
import type { WebSession } from '@/server/session';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import { actingAccessToken } from '@/test/session-token';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = {
  subject: 'user-1',
  username: 'u',
  organizationId: 'ORG-DEH-0001',
  accessToken: actingAccessToken('ORG-DEH-0001'),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

jest.mock('@/server/current-session', () => ({
  currentSession: async () => SESSION,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { submitUsage } = require('./usage/actions') as typeof import('./usage/actions');
const { IDLE_USAGE_FORM } = require('./usage/form-state') as typeof import('./usage/form-state');
const repair =
  require('./maintenance/[id]/repair-actions') as typeof import('./maintenance/[id]/repair-actions');
const { IDLE_COMMAND_FORM } =
  require('./maintenance/[id]/form-state') as typeof import('./maintenance/[id]/form-state');
const { submitOrderCommand } =
  require('./orders/[id]/actions') as typeof import('./orders/[id]/actions');
const { IDLE_ORDER_COMMAND_FORM } =
  require('./orders/[id]/form-state') as typeof import('./orders/[id]/form-state');
const { submitPlaceOrder } =
  require('./marketplace/[productId]/place-order-actions') as typeof import('./marketplace/[productId]/place-order-actions');
const { IDLE_PLACE_ORDER_FORM } =
  require('./marketplace/[productId]/place-order-form-state') as typeof import('./marketplace/[productId]/place-order-form-state');
const { submitTopUp } = require('./wallet/actions') as typeof import('./wallet/actions');
const { IDLE_TOP_UP_FORM } = require('./wallet/form-state') as typeof import('./wallet/form-state');
/* eslint-enable @typescript-eslint/no-require-imports */

const DISCLOSURE = '/v1/wallets/provider/disclosure';
/** The administrators' provider read, which the wallet draws its top-up from. */
const PROVIDER = '/v1/wallets/provider';

/** What the fake gateway answers, by path; anything else is a 404. */
type Answer = { status: number; body?: unknown } | 'THROW' | 'TIMEOUT';
let answers: Record<string, Answer> = {};
/** Every request an action made: method and path. */
let asked: { method: string; path: string }[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  answers = {};
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({ method: init?.method ?? 'GET', path: url.pathname });
    const answer = answers[url.pathname] ?? { status: 404, body: { code: 'NOT_FOUND' } };
    if (answer === 'THROW') throw new TypeError('fetch failed');
    if (answer === 'TIMEOUT') throw new DOMException('The operation timed out.', 'TimeoutError');
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Each way a read can fail — every one of them UNKNOWN. */
const failures = (malformed: unknown): [string, Answer][] => [
  ['refused (403)', { status: 403, body: { code: 'FORBIDDEN' } }],
  ['unavailable (503)', { status: 503 }],
  ['malformed', { status: 200, body: malformed }],
  ['unreachable', 'THROW'],
  ['timed out', 'TIMEOUT'],
];

const REQUEST_ID = 'MNT_01J00000000000000000000000';
const REPAIR_ORDER = 'RPO_01J00000000000000000000000';
const ORDER_ID = 'ORD_1';
const WALLET_ID = 'WLT_1';

/** A form as the page drew it: this session's CSRF token and a submission id minted for it. */
function drawnForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(CSRF_FIELD, SESSION.csrfToken);
  form.set(SUBMISSION_FIELD, mintSubmissionId(SESSION));
  return form;
}

interface GatedAction {
  readonly name: string;
  /** The read the page drew the form from, and that read when it answers. */
  readonly read: string;
  readonly known: Answer;
  readonly malformed: unknown;
  /** Draws the form — while the provider is known. */
  readonly draw: () => FormData;
  readonly submit: (form: FormData) => Promise<unknown>;
  /** The write that must not reach the gateway. */
  readonly write: string;
}

const disclosed = { status: 200, body: { simulated: true } } as const;

const resolveDispute = (outcome: 'SETTLE' | 'REFUND'): GatedAction => ({
  name: `order RESOLVE_DISPUTE (${outcome})`,
  read: DISCLOSURE,
  known: disclosed,
  malformed: { simulated: 'yes' },
  draw: () =>
    drawnForm({
      command: 'RESOLVE_DISPUTE',
      outcome,
      resolution: 'کالا تحویل نشده بود و فروشنده پاسخ نداد.',
      responsibility: 'SUPPLIER',
      acknowledge: 'yes',
    }),
  submit: (form) => submitOrderCommand(ORDER_ID, IDLE_ORDER_COMMAND_FORM, form),
  write: `/v1/orders/${ORDER_ID}/disputes/resolve`,
});

const GATED: readonly GatedAction[] = [
  {
    name: 'usage record (USAGE_RECORDED, a reward trigger)',
    read: DISCLOSURE,
    known: disclosed,
    malformed: { provider: 'mock' },
    draw: () =>
      drawnForm({
        assetId: 'AST_01JASSET000000000000000000',
        periodStart: '2026-09-21T08:00',
        periodEnd: '2026-09-21T16:30',
        hours: '8.5',
      }),
    submit: (form) => submitUsage(IDLE_USAGE_FORM, form),
    write: '/v1/usage-records',
  },
  {
    name: 'repair completion (MAINTENANCE_COMPLETED, a reward trigger)',
    read: DISCLOSURE,
    known: disclosed,
    malformed: { provider: 'mock' },
    draw: () =>
      drawnForm({
        requestId: REQUEST_ID,
        workPerformed: 'شیلنگ تعویض شد',
        [BASELINE_FIELD]: sealRepairOrderBaseline(SESSION, {
          requestId: REQUEST_ID,
          repairOrderId: REPAIR_ORDER,
          command: 'complete',
          totalCostMinor: '750000',
        }),
      }),
    submit: (form) => repair.submitCompleteRepair(IDLE_COMMAND_FORM, form),
    write: `/v1/repair-orders/${REPAIR_ORDER}/complete`,
  },
  {
    name: 'order CONFIRM_RECEIPT (settles)',
    read: DISCLOSURE,
    known: disclosed,
    malformed: { simulated: null },
    draw: () => drawnForm({ command: 'CONFIRM_RECEIPT', acknowledge: 'yes' }),
    submit: (form) => submitOrderCommand(ORDER_ID, IDLE_ORDER_COMMAND_FORM, form),
    write: `/v1/orders/${ORDER_ID}/confirm-receipt`,
  },
  resolveDispute('SETTLE'),
  resolveDispute('REFUND'),
  {
    name: 'order CANCEL (refunds)',
    read: DISCLOSURE,
    known: disclosed,
    malformed: {},
    draw: () => drawnForm({ command: 'CANCEL', reason: 'دیگر لازم نیست', acknowledge: 'yes' }),
    submit: (form) => submitOrderCommand(ORDER_ID, IDLE_ORDER_COMMAND_FORM, form),
    write: `/v1/orders/${ORDER_ID}/cancel`,
  },
  {
    name: 'place order (holds)',
    read: DISCLOSURE,
    known: disclosed,
    malformed: { provider: 'mock' },
    draw: () => drawnForm({ offerId: 'OFR_SEED_AGGREGATE_D2', quantity: '3' }),
    submit: (form) => submitPlaceOrder(IDLE_PLACE_ORDER_FORM, form),
    write: '/v1/orders',
  },
  {
    name: 'wallet top-up (deposits), by the wallet’s own provider read',
    read: PROVIDER,
    known: {
      status: 200,
      body: { provider: 'mock', simulated: true, notice: 'Simulated payment provider.' },
    },
    // The members' disclosure shape: enough for the label, not for the top-up.
    malformed: { simulated: true },
    draw: () => drawnForm({ amountMinor: '1000000' }),
    submit: (form) => submitTopUp(WALLET_ID, IDLE_TOP_UP_FORM, form),
    write: `/v1/wallets/${WALLET_ID}/top-up`,
  },
];

const writes = (path: string) => asked.filter((call) => call.path === path);
const reads = (path: string) => asked.filter((call) => call.path === path).length;

/** Submits, letting a redirect (Next's success) through as a value. */
async function submitted(submit: () => Promise<unknown>): Promise<unknown> {
  try {
    return await submit();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT:')) return error.message;
    throw error;
  }
}

describe.each(GATED)('$name', (action) => {
  it.each(failures(action.malformed))(
    'a form drawn while the provider was known is refused, and nothing is sent, once the read is %s',
    async (_, failure) => {
      answers[action.read] = action.known;
      const form = action.draw();

      answers[action.read] = failure;
      await expect(action.submit(form)).resolves.toEqual({
        kind: 'REFUSED',
        reason: 'PROVIDER_UNKNOWN',
      });

      // The provider was asked at submission time, and nothing else was.
      expect(reads(action.read)).toBe(1);
      expect(asked).toEqual([{ method: 'GET', path: action.read }]);
      expect(writes(action.write)).toEqual([]);
    },
  );

  it.each([
    ['simulated', true],
    ['real', false],
  ])('the same form is sent while the provider is %s', async (_, simulated) => {
    const known = action.known as { status: number; body: Record<string, unknown> };
    answers[action.read] = { status: 200, body: { ...known.body, simulated } };
    const form = action.draw();

    await submitted(() => action.submit(form));

    expect(writes(action.write)).toEqual([{ method: 'POST', path: action.write }]);
    // Read before the write, not after.
    expect(asked.findIndex((call) => call.path === action.read)).toBeLessThan(
      asked.findIndex((call) => call.path === action.write),
    );
  });
});

describe('a retry of an unconfirmed order is the same hold, and is gated too', () => {
  it('is not sent while the provider is unknown, and the original stays unknown', async () => {
    answers[DISCLOSURE] = disclosed;
    const form = drawnForm({ offerId: 'OFR_SEED_AGGREGATE_D2', quantity: '3' });
    const submissionId = String(form.get(SUBMISSION_FIELD));
    const previous = {
      kind: 'UNCONFIRMED',
      correlationId: 'COR_1',
      submissionId,
      values: { offerId: 'OFR_SEED_AGGREGATE_D2', quantity: '3' },
    } as const;

    answers[DISCLOSURE] = { status: 503 };
    const state = await submitPlaceOrder(previous, form);

    expect(state).toEqual({ ...previous, retryRefused: true });
    expect(writes('/v1/orders')).toEqual([]);
  });
});

describe('what moves no money is not held up by a provider outage', () => {
  const NONE_COMMANDS: [string, Record<string, string>, string][] = [
    ['CONFIRM', { command: 'CONFIRM' }, 'confirm'],
    ['FULFILL', { command: 'FULFILL' }, 'fulfill'],
    [
      'RAISE_DISPUTE',
      { command: 'RAISE_DISPUTE', reason: 'کالا با سفارش نمی‌خواند و ناقص رسید.' },
      'disputes',
    ],
    ['REVIEW', { command: 'REVIEW', rating: '4' }, 'reviews'],
  ];

  it.each(NONE_COMMANDS)(
    'order %s is sent without asking the provider',
    async (_, fields, path) => {
      answers[DISCLOSURE] = { status: 503 };

      const form = drawnForm(fields);
      await submitted(() => submitOrderCommand(ORDER_ID, IDLE_ORDER_COMMAND_FORM, form));

      expect(writes(`/v1/orders/${ORDER_ID}/${path}`)).toEqual([
        { method: 'POST', path: `/v1/orders/${ORDER_ID}/${path}` },
      ]);
      expect(reads(DISCLOSURE)).toBe(0);
    },
  );

  it('starting a repair is sent without asking the provider', async () => {
    answers[DISCLOSURE] = { status: 503 };
    const form = drawnForm({
      requestId: REQUEST_ID,
      workSummary: 'تعویض شیلنگ',
      [BASELINE_FIELD]: sealRepairOrderBaseline(SESSION, {
        requestId: REQUEST_ID,
        repairOrderId: REPAIR_ORDER,
        command: 'start',
        totalCostMinor: '750000',
      }),
    });

    await submitted(() => repair.submitStartRepair(IDLE_COMMAND_FORM, form));

    expect(writes(`/v1/repair-orders/${REPAIR_ORDER}/start`)).toHaveLength(1);
    expect(reads(DISCLOSURE)).toBe(0);
  });
});
