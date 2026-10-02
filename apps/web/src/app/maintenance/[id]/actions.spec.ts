/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { APPROVAL_TOTAL_CHANGED_MESSAGE } from '@/server/maintenance-commands';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_COMMAND_FORM } from './form-state';

/**
 * The three commands on `/maintenance/[id]`. The order is the assertion: each
 * refusal proves nothing was called, and a command acts on the request the
 * form names only when that name is shaped like one.
 */

const currentSession = jest.fn();
const assignWorkshop = jest.fn();
const approveRequest = jest.fn();
const cancelRequest = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/maintenance-commands', () => {
  const actual = jest.requireActual('@/server/maintenance-commands');
  return {
    ...actual,
    assignWorkshop: (...args: unknown[]) => assignWorkshop(...args),
    approveRequest: (...args: unknown[]) => approveRequest(...args),
    cancelRequest: (...args: unknown[]) => cancelRequest(...args),
  };
});

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require('./actions') as typeof import('./actions');

const SESSION = {
  subject: 'user-1',
  username: 'manager',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const REQUEST_ID = 'MNT_01J00000000000000000000000';
const WORKSHOP = 'ORG_01J00000000000000000000001';

interface Command {
  readonly name: string;
  readonly submit: (form: FormData) => Promise<unknown>;
  readonly service: jest.Mock;
  readonly valid: Record<string, string>;
  readonly notice: string;
}

const COMMANDS: readonly Command[] = [
  {
    name: 'assign',
    submit: (form) => actions.submitAssignWorkshop(IDLE_COMMAND_FORM, form),
    service: assignWorkshop,
    valid: { workshopOrganizationId: WORKSHOP, workshopName: 'تعمیرگاه کوثر' },
    notice: 'assigned',
  },
  {
    name: 'approve',
    submit: (form) => actions.submitApproveRequest(IDLE_COMMAND_FORM, form),
    service: approveRequest,
    valid: { expectedTotalCostMinor: '12500000', notes: 'تأیید' },
    notice: 'approved',
  },
  {
    name: 'cancel',
    submit: (form) => actions.submitCancelRequest(IDLE_COMMAND_FORM, form),
    service: cancelRequest,
    valid: { reason: 'ماشین فروخته شد' },
    notice: 'cancelled',
  },
];

function formData(
  fields: Record<string, string>,
  options: {
    csrf?: string | null;
    submission?: string | null;
    requestId?: string | null;
  } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  const requestId = options.requestId === undefined ? REQUEST_ID : options.requestId;
  if (requestId !== null) form.set('requestId', requestId);
  return form;
}

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  for (const command of COMMANDS) {
    command.service.mockReset();
    command.service.mockResolvedValue({
      kind: 'CREATED',
      data: { id: 'X_1' },
      correlationId: 'corr-sample',
    });
  }
  redirect.mockClear();
});

const noneCalled = () =>
  COMMANDS.forEach((command) => expect(command.service).not.toHaveBeenCalled());

describe.each(COMMANDS)('$name — what is refused before anything is called', (command) => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    expect(await command.submit(formData(command.valid))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    noneCalled();
  });

  it('refuses a post with no CSRF token, and one from another session', async () => {
    for (const csrf of [null, 'someone-elses']) {
      expect(await command.submit(formData(command.valid, { csrf }))).toEqual({
        kind: 'REFUSED',
        reason: 'CSRF',
      });
    }
    noneCalled();
  });

  it('refuses a submission id the client chose, one nobody minted, and one minted for somebody else', async () => {
    const theirs = mintSubmissionId({ ...SESSION, subject: 'someone-else' });
    const earlier = mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' });
    for (const submission of [
      null,
      'chosen-by-the-client',
      `sub_${'A'.repeat(38)}`,
      theirs,
      earlier,
    ]) {
      expect(await command.submit(formData(command.valid, { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    noneCalled();
  });

  it('answers a request id that cannot be a request’s as a missing one, and calls nothing', async () => {
    for (const requestId of [null, '', 'x', 'AST_01J00000000000000000000000', 'MNT/../x']) {
      expect(await command.submit(formData(command.valid, { requestId }))).toEqual({
        kind: 'NOT_FOUND',
        correlationId: null,
      });
    }
    noneCalled();
  });
});

describe.each(COMMANDS)('$name — what reaches the service', (command) => {
  it('acts on the request the form names, under the session, with the submission id', async () => {
    const submission = mintSubmissionId(SESSION);
    await expect(command.submit(formData(command.valid, { submission }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );

    expect(command.service).toHaveBeenCalledTimes(1);
    const [session, requestId, body, submissionId] = command.service.mock.calls[0];
    expect(session).toBe(SESSION);
    expect(requestId).toBe(REQUEST_ID);
    expect(body).not.toHaveProperty('requestId');
    expect(submissionId).toBe(submission);
  });

  it('redirects to a fresh read of the request with a flash the server signed for it', async () => {
    await expect(command.submit(formData(command.valid))).rejects.toThrow(/NEXT_REDIRECT/);

    const url = redirect.mock.calls[0][0] as string;
    expect(url.startsWith(`/maintenance/${REQUEST_ID}?flash=`)).toBe(true);
    const flash = new URLSearchParams(url.split('?')[1]).get('flash');
    expect(readFlash(SESSION, flash, REQUEST_ID, [command.notice])).toBe(command.notice);
    // Nothing a person could type into the URL produces the same page.
    expect(url).not.toContain('done=');
  });

  it('does not send a form the form schema refuses', async () => {
    const state = await command.submit(formData({}));
    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: expect.any(Object) });
    expect(command.service).not.toHaveBeenCalled();
  });

  it('returns the service’s refusal with what was typed still in hand', async () => {
    command.service.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'A sentence',
      correlationId: 'corr-sample',
    });

    expect(await command.submit(formData(command.valid))).toMatchObject({
      kind: 'INVALID',
      message: 'A sentence',
      values: expect.any(Object),
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('answers a request that is not visible with its own state, never saying which', async () => {
    command.service.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-sample' });
    expect(await command.submit(formData(command.valid))).toEqual({
      kind: 'NOT_FOUND',
      correlationId: 'corr-sample',
    });
  });

  it('reports a forbidden write with its correlation id', async () => {
    command.service.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-sample' });
    expect(await command.submit(formData(command.valid))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'corr-sample',
    });
  });

  it('reports a sent-but-unconfirmed write as UNCONFIRMED, never as a failure or a success', async () => {
    command.service.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-sample' });
    expect(await command.submit(formData(command.valid))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('reports "still being processed" as UNCONFIRMED too: nothing here may say it did not happen', async () => {
    command.service.mockResolvedValue({
      kind: 'IN_PROGRESS',
      retryAfterSeconds: 1,
      correlationId: 'corr-sample',
    });
    expect(await command.submit(formData(command.valid))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('reports an outage with its status, and never puts a token in what the page renders', async () => {
    command.service.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    const state = await command.submit(formData(command.valid));
    expect(state).toEqual({ kind: 'FAILED', status: 503, correlationId: 'corr-sample' });
    const text = JSON.stringify(state);
    for (const secret of [SESSION.accessToken, SESSION.refreshToken, SESSION.csrfToken]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('approve — a total that moved', () => {
  const approve = COMMANDS[1];

  it('sends the person to a page that shows the new figure, with a signed notice', async () => {
    approve.service.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: APPROVAL_TOTAL_CHANGED_MESSAGE,
      correlationId: 'corr-sample',
    });

    await expect(approve.submit(formData(approve.valid))).rejects.toThrow(/NEXT_REDIRECT/);

    const url = redirect.mock.calls[0][0] as string;
    expect(url.startsWith(`/maintenance/${REQUEST_ID}?flash=`)).toBe(true);
    const flash = new URLSearchParams(url.split('?')[1]).get('flash');
    expect(readFlash(SESSION, flash, REQUEST_ID, ['costChanged'])).toBe('costChanged');
  });

  it('does not treat another refusal as a moved total', async () => {
    approve.service.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'something else',
      correlationId: 'corr-sample',
    });
    expect(await approve.submit(formData(approve.valid))).toMatchObject({ kind: 'INVALID' });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('sends the echoed total as posted: it is what the person was shown, validated as digits', async () => {
    await expect(
      approve.submit(formData({ expectedTotalCostMinor: '99', notes: '' })),
    ).rejects.toThrow();
    expect(approve.service.mock.calls[0][2]).toEqual({ expectedTotalCostMinor: '99' });

    approve.service.mockClear();
    expect(
      await approve.submit(formData({ expectedTotalCostMinor: '1e3', notes: '' })),
    ).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { expectedTotalCostMinor: expect.any(String) },
    });
    expect(approve.service).not.toHaveBeenCalled();
  });
});
