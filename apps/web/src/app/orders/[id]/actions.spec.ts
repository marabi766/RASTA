/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { RECEIPT_NOTE_REFUSAL } from '@/server/orders';

import { IDLE_ORDER_COMMAND_FORM } from './form-state';

/**
 * The one server action behind every order command.
 *
 * Order is the assertion, as in every portal action spec: session, CSRF, the
 * submission id, the form, then the gateway — and each of the first three
 * proves **nothing was called** when it fails. On `orders` that matters more
 * than elsewhere: a call that got through is a command against somebody's
 * money.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const issueOrderCommand = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
// The provider gate is open here: what it refuses, against a fake gateway, is
// `app/money-actions-gate.spec.ts`.
jest.mock('@/server/money-gate', () => ({ mayDispatch: async () => true }));
jest.mock('@/server/orders', () => {
  const actual = jest.requireActual('@/server/orders');
  return { ...actual, issueOrderCommand: (...a: unknown[]) => issueOrderCommand(...a) };
});

const actions =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./actions') as typeof import('./actions');
const submit = (form: FormData) =>
  actions.submitOrderCommand('ORD_1', IDLE_ORDER_COMMAND_FORM, form);

const SESSION = {
  subject: 'USR_1',
  username: 'buyer',
  organizationId: 'ORG_BUYER',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

function formData(
  entries: Array<[string, string]>,
  options: { csrf?: string | null; submission?: string | null } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of entries) form.append(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  return form;
}

const RECEIPT: Array<[string, string]> = [
  ['command', 'CONFIRM_RECEIPT'],
  ['acknowledge', 'yes'],
];

beforeEach(() => {
  jest.clearAllMocks();
  currentSession.mockResolvedValue(SESSION);
  issueOrderCommand.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'ORD_1' },
    correlationId: 'c',
  });
});

describe('what is refused before anything is called', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    await expect(submit(formData(RECEIPT))).resolves.toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    expect(issueOrderCommand).not.toHaveBeenCalled();
  });

  it('refuses a token from another session — the cross-site case', async () => {
    await expect(submit(formData(RECEIPT, { csrf: 'someone-elses' }))).resolves.toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(issueOrderCommand).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint', async () => {
    await expect(submit(formData(RECEIPT, { submission: 'chosen' }))).resolves.toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(issueOrderCommand).not.toHaveBeenCalled();
  });

  it('refuses every id that is not one this server minted for this session, and calls nothing', async () => {
    const notMinted = [
      // Right prefix, right length, right alphabet — and nobody's MAC: what a
      // shape check alone waves through.
      `sub_${'A'.repeat(38)}`,
      `sub_${'Zz9_-'.repeat(8)}ab`,
      // The original, unbound format.
      `sub_${'B'.repeat(20)}`,
      // Somebody else's, and one from an earlier login.
      mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
      mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' }),
    ];
    for (const submission of notMinted) {
      await expect(submit(formData(RECEIPT, { submission }))).resolves.toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    expect(issueOrderCommand).not.toHaveBeenCalled();
  });

  it('refuses a command that is not one of the seven', async () => {
    await expect(submit(formData([['command', 'SETTLE_NOW']]))).resolves.toEqual({
      kind: 'REFUSED',
      reason: 'COMMAND',
    });
    expect(issueOrderCommand).not.toHaveBeenCalled();
  });

  it('will not release money on an unacknowledged receipt confirmation', async () => {
    const state = await submit(formData([['command', 'CONFIRM_RECEIPT']]));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { acknowledge: expect.any(String) },
    });
    expect(issueOrderCommand).not.toHaveBeenCalled();
  });
});

describe('what reaches the service', () => {
  it('sends the command for the bound order and redirects back to it', async () => {
    await expect(submit(formData(RECEIPT))).rejects.toThrow(/NEXT_REDIRECT/);

    expect(issueOrderCommand).toHaveBeenCalledWith(
      SESSION,
      'ORD_1',
      { command: 'CONFIRM_RECEIPT', body: {} },
      expect.any(String),
    );
    expect(redirect).toHaveBeenCalledWith('/orders/ORD_1?done=CONFIRM_RECEIPT');
  });

  it('ignores an order id smuggled into the form — the bound one wins', async () => {
    await expect(submit(formData([...RECEIPT, ['orderId', 'ORD_OTHER']]))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(issueOrderCommand.mock.calls[0]![1]).toBe('ORD_1');
  });

  it('sends the same submission id on a retry, so the service replays rather than repeats', async () => {
    const id = mintSubmissionId(SESSION);
    issueOrderCommand.mockResolvedValue({ kind: 'UNAVAILABLE', status: 503, correlationId: 'c' });
    await submit(formData(RECEIPT, { submission: id }));
    await submit(formData(RECEIPT, { submission: id }));

    const keys = issueOrderCommand.mock.calls.map((call) => call[3]);
    expect(keys).toEqual([id, id]);
  });
});

// Q-110: the service refuses a receipt note, the form no longer offers the
// field, and a post that still carries one must not settle the order with the
// text lost.
describe('a receipt confirmation that still carries a note', () => {
  it('is refused in Persian before anything is sent — not dropped, not settled', async () => {
    const state = await submit(formData([...RECEIPT, ['note', 'کالا سالم رسید']]));

    expect(state).toMatchObject({
      kind: 'INVALID',
      command: 'CONFIRM_RECEIPT',
      fieldErrors: { note: RECEIPT_NOTE_REFUSAL },
    });
    expect(JSON.stringify(state)).not.toContain('Q-110');
    expect(issueOrderCommand).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only note as no note', async () => {
    await expect(submit(formData([...RECEIPT, ['note', ' \n ']]))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(issueOrderCommand).toHaveBeenCalledWith(
      SESSION,
      'ORD_1',
      { command: 'CONFIRM_RECEIPT', body: {} },
      expect.any(String),
    );
  });

  it('keeps every gate in front of it: no session, CSRF, submission and acknowledgement are still checked first', async () => {
    const withNote = [...RECEIPT, ['note', 'x']] as Array<[string, string]>;
    currentSession.mockResolvedValue(null);
    await expect(submit(formData(withNote))).resolves.toMatchObject({ kind: 'REFUSED' });
    currentSession.mockResolvedValue(SESSION);
    await expect(submit(formData(withNote, { csrf: 'other' }))).resolves.toMatchObject({
      reason: 'CSRF',
    });
    await expect(submit(formData(withNote, { submission: 'chosen' }))).resolves.toMatchObject({
      reason: 'SUBMISSION',
    });
    await expect(
      submit(
        formData([
          ['command', 'CONFIRM_RECEIPT'],
          ['note', 'x'],
        ]),
      ),
    ).resolves.toMatchObject({ kind: 'INVALID', fieldErrors: { acknowledge: expect.any(String) } });
    expect(issueOrderCommand).not.toHaveBeenCalled();
  });

  it('a duplicate submit of the same confirmation carries the same idempotency key, so the service replays it and settles once', async () => {
    const id = mintSubmissionId(SESSION);
    await expect(submit(formData(RECEIPT, { submission: id }))).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(submit(formData(RECEIPT, { submission: id }))).rejects.toThrow(/NEXT_REDIRECT/);

    const keys = issueOrderCommand.mock.calls.map((call) => call[3]);
    expect(keys).toEqual([id, id]);
    const bodies = issueOrderCommand.mock.calls.map((call) => call[2]);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('fulfil still sends its note, which the service stores', async () => {
    await expect(
      submit(
        formData([
          ['command', 'FULFILL'],
          ['note', 'ارسال با باربری'],
        ]),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(issueOrderCommand).toHaveBeenCalledWith(
      SESSION,
      'ORD_1',
      { command: 'FULFILL', body: { note: 'ارسال با باربری' } },
      expect.any(String),
    );
  });
});

describe('what the service answers', () => {
  it('keeps a refusal apart from an absence', async () => {
    issueOrderCommand.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'c1' });
    await expect(submit(formData(RECEIPT))).resolves.toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'c1',
    });

    issueOrderCommand.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'c2' });
    await expect(submit(formData(RECEIPT))).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  it('carries the mapped sentence when the other party acted first', async () => {
    issueOrderCommand.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'وضعیت سفارش اجازه‌ی این اقدام را نمی‌دهد',
      correlationId: 'c',
    });
    const state = await submit(formData(RECEIPT));
    expect(state).toMatchObject({ kind: 'INVALID', message: expect.stringContaining('وضعیت') });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each(['UNKNOWN_OUTCOME', 'IN_PROGRESS'])(
    'reads %s as unconfirmed, never as "nothing was saved"',
    async (kind) => {
      issueOrderCommand.mockResolvedValue({ kind, correlationId: 'c', retryAfterSeconds: 1 });
      await expect(submit(formData(RECEIPT))).resolves.toEqual({
        kind: 'UNCONFIRMED',
        correlationId: 'c',
      });
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it('never puts anything token-shaped in the state it returns', async () => {
    issueOrderCommand.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'no',
      correlationId: 'c',
    });
    const serialised = JSON.stringify(await submit(formData(RECEIPT)));
    expect(serialised).not.toContain(SESSION.accessToken);
    expect(serialised).not.toContain(SESSION.refreshToken);
    expect(serialised).not.toContain(SESSION.csrfToken);
  });
});
