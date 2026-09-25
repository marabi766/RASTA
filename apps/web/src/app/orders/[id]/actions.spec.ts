/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

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

const currentSession = jest.fn();
const issueOrderCommand = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
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
  const submission = options.submission === undefined ? newSubmissionId() : options.submission;
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
    const id = newSubmissionId();
    issueOrderCommand.mockResolvedValue({ kind: 'UNAVAILABLE', status: 503, correlationId: 'c' });
    await submit(formData(RECEIPT, { submission: id }));
    await submit(formData(RECEIPT, { submission: id }));

    const keys = issueOrderCommand.mock.calls.map((call) => call[3]);
    expect(keys).toEqual([id, id]);
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

  it('carries the service sentence when the other party acted first', async () => {
    issueOrderCommand.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'Order ORD_1 cannot move from DISPUTED to RECEIPT_CONFIRMED',
      correlationId: 'c',
    });
    const state = await submit(formData(RECEIPT));
    expect(state).toMatchObject({ kind: 'INVALID', message: expect.stringContaining('DISPUTED') });
    expect(redirect).not.toHaveBeenCalled();
  });

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
