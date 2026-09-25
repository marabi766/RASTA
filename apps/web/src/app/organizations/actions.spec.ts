/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import {
  IDLE_REVOKE_MEMBERSHIP_FORM,
  IDLE_UPDATE_MEMBER_ROLES_FORM,
  IDLE_UPDATE_ORGANIZATION_FORM,
} from './form-state';

/**
 * The three `/organizations` write paths, from a posted form to a call.
 *
 * The order is the assertion, as in `usage/actions.spec.ts` and
 * `drivers/actions.spec.ts`: session, then CSRF, then the submission id, then
 * the form, then the gateway. Each of the first three has a test proving
 * **nothing was called** when it fails — a refusal that still reaches the
 * gateway is not a refusal — and all three actions share one gate, so each is
 * checked rather than one being assumed to stand for the others.
 */

const currentSession = jest.fn();
const updateOrganization = jest.fn();
const updateMemberRoles = jest.fn();
const revokeMembership = jest.fn();
const redirect = jest.fn((url: string) => {
  // Next's `redirect` throws to unwind; the real one is indistinguishable
  // from an exception to the code under test, so the stub throws too.
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/organizations', () => {
  const actual = jest.requireActual('@/server/organizations');
  return { ...actual, updateOrganization: (...a: unknown[]) => updateOrganization(...a) };
});
jest.mock('@/server/members', () => {
  const actual = jest.requireActual('@/server/members');
  return {
    ...actual,
    updateMemberRoles: (...a: unknown[]) => updateMemberRoles(...a),
    revokeMembership: (...a: unknown[]) => revokeMembership(...a),
  };
});

// Imported after the mocks so the module under test picks them up.
const actions =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./actions') as typeof import('./actions');
const { submitUpdateOrganization, submitUpdateMemberRoles, submitRevokeMembership } = actions;

const SESSION = {
  subject: 'USR_1',
  username: 'admin',
  organizationId: 'ORG_1',
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

const ORG_FORM: Array<[string, string]> = [
  ['organizationId', 'ORG_1'],
  ['name', 'نام تازه'],
  ['shortName', ''],
  ['externalCode', ''],
];

const ROLES_FORM: Array<[string, string]> = [
  ['membershipId', 'MBR_2'],
  ['roles', 'FLEET_MANAGER'],
  ['roles', 'DRIVER'],
  ['reason', 'جابه‌جایی مسئولیت'],
];

const REVOKE_FORM: Array<[string, string]> = [
  ['membershipId', 'MBR_2'],
  ['reason', 'پایان همکاری'],
];

beforeEach(() => {
  jest.clearAllMocks();
  currentSession.mockResolvedValue(SESSION);
  updateOrganization.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'ORG_1' },
    correlationId: 'c',
  });
  updateMemberRoles.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'MBR_2' },
    correlationId: 'c',
  });
  revokeMembership.mockResolvedValue({ kind: 'CREATED', data: undefined, correlationId: 'c' });
});

// ---------------------------------------------------------------------------

describe('the gate all three share', () => {
  const cases = [
    {
      name: 'profile',
      run: (f: FormData) => submitUpdateOrganization(IDLE_UPDATE_ORGANIZATION_FORM, f),
      entries: ORG_FORM,
      service: updateOrganization,
    },
    {
      name: 'member roles',
      run: (f: FormData) => submitUpdateMemberRoles(IDLE_UPDATE_MEMBER_ROLES_FORM, f),
      entries: ROLES_FORM,
      service: updateMemberRoles,
    },
    {
      name: 'revoke',
      run: (f: FormData) => submitRevokeMembership(IDLE_REVOKE_MEMBERSHIP_FORM, f),
      entries: REVOKE_FORM,
      service: revokeMembership,
    },
  ];

  it.each(cases)('refuses a $name post with no session, and calls nothing', async (c) => {
    currentSession.mockResolvedValue(null);
    await expect(c.run(formData(c.entries))).resolves.toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    expect(c.service).not.toHaveBeenCalled();
  });

  it.each(cases)('refuses a $name post with a token from another session', async (c) => {
    await expect(c.run(formData(c.entries, { csrf: 'someone-elses' }))).resolves.toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(c.service).not.toHaveBeenCalled();
  });

  it.each(cases)('refuses a $name post with no CSRF token at all', async (c) => {
    await expect(c.run(formData(c.entries, { csrf: null }))).resolves.toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(c.service).not.toHaveBeenCalled();
  });

  it.each(cases)('refuses a $name submission id this server did not mint', async (c) => {
    await expect(
      c.run(formData(c.entries, { submission: 'chosen-by-the-client' })),
    ).resolves.toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(c.service).not.toHaveBeenCalled();
  });

  it.each(cases)('checks CSRF before the submission id for $name', async (c) => {
    await expect(
      c.run(formData(c.entries, { csrf: 'wrong', submission: 'also-wrong' })),
    ).resolves.toEqual({ kind: 'REFUSED', reason: 'CSRF' });
  });
});

// ---------------------------------------------------------------------------

describe('editing the organization profile', () => {
  it('sends the parsed request and redirects so a refresh cannot repeat it', async () => {
    await expect(
      submitUpdateOrganization(IDLE_UPDATE_ORGANIZATION_FORM, formData(ORG_FORM)),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(updateOrganization).toHaveBeenCalledWith(
      SESSION,
      'ORG_1',
      { name: 'نام تازه', shortName: null, externalCode: null },
      expect.any(String),
    );
    expect(redirect).toHaveBeenCalledWith('/organizations?saved=profile');
  });

  it('does not call the service for a form it can already see is invalid', async () => {
    const state = await submitUpdateOrganization(
      IDLE_UPDATE_ORGANIZATION_FORM,
      formData([...ORG_FORM.filter(([k]) => k !== 'name'), ['name', '']]),
    );

    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { name: expect.any(String) } });
    expect(updateOrganization).not.toHaveBeenCalled();
  });

  it('refuses a post with no organization to act on', async () => {
    const state = await submitUpdateOrganization(
      IDLE_UPDATE_ORGANIZATION_FORM,
      formData(ORG_FORM.filter(([k]) => k !== 'organizationId')),
    );

    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(updateOrganization).not.toHaveBeenCalled();
  });
});

describe('changing a member’s roles', () => {
  it('sends every checked role, not only the first', async () => {
    await expect(
      submitUpdateMemberRoles(IDLE_UPDATE_MEMBER_ROLES_FORM, formData(ROLES_FORM)),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(updateMemberRoles).toHaveBeenCalledWith(
      SESSION,
      { membershipId: 'MBR_2', roles: ['FLEET_MANAGER', 'DRIVER'], reason: 'جابه‌جایی مسئولیت' },
      expect.any(String),
    );
  });

  it('reports the ladder refusal as its own outcome, with the correlation id', async () => {
    // An ORGANIZATION_ADMIN asking for SYSTEM_ADMIN reaches identity-service
    // and is refused there (PR #77). The page renders that; it does not
    // pretend the attempt never happened, and it does not crash.
    updateMemberRoles.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-1' });

    const state = await submitUpdateMemberRoles(
      IDLE_UPDATE_MEMBER_ROLES_FORM,
      formData([
        ['membershipId', 'MBR_2'],
        ['roles', 'SYSTEM_ADMIN'],
        ['reason', 'تلاش برای ارتقا'],
      ]),
    );

    expect(state).toEqual({ kind: 'FORBIDDEN', correlationId: 'corr-1' });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('keeps the values and the submission id so a retry is the same submission', async () => {
    const submission = newSubmissionId();
    const state = await submitUpdateMemberRoles(
      IDLE_UPDATE_MEMBER_ROLES_FORM,
      formData(
        [
          ['membershipId', 'MBR_2'],
          ['roles', 'DRIVER'],
          ['reason', 'x'],
        ],
        { submission },
      ),
    );

    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { membershipId: 'MBR_2', roles: ['DRIVER'] },
    });
    expect(updateMemberRoles).not.toHaveBeenCalled();
  });

  it('distinguishes a vanished membership from a refusal', async () => {
    updateMemberRoles.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-1' });
    await expect(
      submitUpdateMemberRoles(IDLE_UPDATE_MEMBER_ROLES_FORM, formData(ROLES_FORM)),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  it('reports an outage with its status and correlation id', async () => {
    updateMemberRoles.mockResolvedValue({ kind: 'UNAVAILABLE', status: 503, correlationId: 'c2' });
    await expect(
      submitUpdateMemberRoles(IDLE_UPDATE_MEMBER_ROLES_FORM, formData(ROLES_FORM)),
    ).resolves.toEqual({ kind: 'FAILED', status: 503, correlationId: 'c2' });
  });
});

describe('revoking a membership', () => {
  it('sends the reason and redirects', async () => {
    await expect(
      submitRevokeMembership(IDLE_REVOKE_MEMBERSHIP_FORM, formData(REVOKE_FORM)),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(revokeMembership).toHaveBeenCalledWith(
      SESSION,
      { membershipId: 'MBR_2', reason: 'پایان همکاری' },
      expect.any(String),
    );
    expect(redirect).toHaveBeenCalledWith('/organizations?revoked=1');
  });

  it('will not revoke without a stated reason', async () => {
    const state = await submitRevokeMembership(
      IDLE_REVOKE_MEMBERSHIP_FORM,
      formData([
        ['membershipId', 'MBR_2'],
        ['reason', ''],
      ]),
    );

    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { reason: expect.any(String) } });
    expect(revokeMembership).not.toHaveBeenCalled();
  });

  it('renders the refusal when the membership is above the caller', async () => {
    revokeMembership.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-2' });
    await expect(
      submitRevokeMembership(IDLE_REVOKE_MEMBERSHIP_FORM, formData(REVOKE_FORM)),
    ).resolves.toEqual({ kind: 'FORBIDDEN', correlationId: 'corr-2' });
  });
});

describe('what never reaches the page', () => {
  it('puts nothing token-shaped in any returned state', async () => {
    // Every state here is rendered into the page and readable by any script
    // on it.
    updateMemberRoles.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'no',
      correlationId: 'c',
    });

    const state = await submitUpdateMemberRoles(
      IDLE_UPDATE_MEMBER_ROLES_FORM,
      formData(ROLES_FORM),
    );
    const serialized = JSON.stringify(state);

    expect(serialized).not.toContain(SESSION.accessToken);
    expect(serialized).not.toContain(SESSION.refreshToken);
    expect(serialized).not.toContain(SESSION.csrfToken);
  });
});
