/**
 * @jest-environment node
 */
import { BASELINE_FIELD } from '@/lib/form-fields';
import type { AssetLifecycleCommand } from '@/lib/asset-lifecycle-fields';
import {
  ASSET_LIFECYCLE_CONFLICT_MESSAGE,
  sealAssetLifecycleBaseline,
} from '@/server/asset-lifecycle-commands';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_LIFECYCLE_FORM } from './lifecycle-form-state';

/**
 * The three lifecycle forms' write path. Mirrors `actions.spec.ts`: the order is
 * the assertion, each refusal proves nothing was sent, and what the command acts
 * on — the asset, its version, the status it was shown at — comes from the signed
 * baseline and from nowhere the browser can write.
 */

const currentSession = jest.fn();
const activateAsset = jest.fn();
const changeAssetStatus = jest.fn();
const decommissionAsset = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/asset-lifecycle-commands', () => {
  const actual = jest.requireActual('@/server/asset-lifecycle-commands');
  return {
    ...actual,
    activateAsset: (...args: unknown[]) => activateAsset(...args),
    changeAssetStatus: (...args: unknown[]) => changeAssetStatus(...args),
    decommissionAsset: (...args: unknown[]) => decommissionAsset(...args),
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
const actions = require('./lifecycle-actions') as typeof import('./lifecycle-actions');

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

const ASSET_ID = 'AST_01J00000000000000000000000';
const OTHER_ASSET_ID = 'AST_01J00000000000000000000099';
const VERSION = 5;
const NAME = 'لودر کوماتسو';

interface Case {
  readonly command: AssetLifecycleCommand;
  readonly submit: (form: FormData) => Promise<unknown>;
  readonly send: jest.Mock;
  readonly shownStatus: string;
  /** What a valid post of this form carries. */
  readonly valid: Record<string, string>;
  readonly notice: string;
}

const CASES: readonly Case[] = [
  {
    command: 'activate',
    submit: (form) => actions.submitActivateAsset(ASSET_ID, IDLE_LIFECYCLE_FORM, form),
    send: activateAsset,
    shownStatus: 'REGISTERED',
    valid: {},
    notice: 'activated',
  },
  {
    command: 'status',
    submit: (form) => actions.submitChangeStatus(ASSET_ID, IDLE_LIFECYCLE_FORM, form),
    send: changeAssetStatus,
    shownStatus: 'ACTIVE',
    valid: { status: 'IDLE', reason: 'فصل غیرکاری' },
    notice: 'statusChanged',
  },
  {
    command: 'decommission',
    submit: (form) => actions.submitDecommission(ASSET_ID, IDLE_LIFECYCLE_FORM, form),
    send: decommissionAsset,
    shownStatus: 'ACTIVE',
    valid: { reason: 'فرسودگی کامل و هزینهٔ تعمیر بیش از ارزش', confirm: 'yes' },
    notice: 'decommissioned',
  },
];

function baselineFor(
  testCase: Case,
  over: Partial<Parameters<typeof sealAssetLifecycleBaseline>[1]> = {},
  session: WebSession = SESSION,
): string {
  return sealAssetLifecycleBaseline(session, {
    assetId: ASSET_ID,
    command: testCase.command,
    version: VERSION,
    status: testCase.shownStatus,
    assetName: NAME,
    ...over,
  });
}

function formData(
  testCase: Case,
  fields: Record<string, string> = testCase.valid,
  options: {
    csrf?: string | null;
    submission?: string | null;
    /** `undefined`: the one this server signed for this command and machine. */
    baseline?: string | null;
  } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  const baseline = options.baseline === undefined ? baselineFor(testCase) : options.baseline;
  if (baseline !== null) form.set(BASELINE_FIELD, baseline);
  return form;
}

const redirectedTo = async (promise: Promise<unknown>): Promise<URL> => {
  const error = await promise.then(
    () => {
      throw new Error('expected a redirect');
    },
    (caught: Error) => caught,
  );
  const match = /^NEXT_REDIRECT:(.*)$/.exec(error.message);
  if (!match) throw error;
  return new URL(match[1]!, 'http://localhost:3200');
};

/** The form as the page of `assetId` binds it. */
const submitOn = (testCase: Case, assetId: string, form: FormData): Promise<unknown> =>
  testCase.command === 'activate'
    ? actions.submitActivateAsset(assetId, IDLE_LIFECYCLE_FORM, form)
    : testCase.command === 'status'
      ? actions.submitChangeStatus(assetId, IDLE_LIFECYCLE_FORM, form)
      : actions.submitDecommission(assetId, IDLE_LIFECYCLE_FORM, form);

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  for (const send of [activateAsset, changeAssetStatus, decommissionAsset]) {
    send.mockReset();
    send.mockResolvedValue({
      kind: 'CREATED',
      data: { id: ASSET_ID },
      correlationId: 'corr-sample',
    });
  }
  redirect.mockClear();
});

const sent = () =>
  [activateAsset, changeAssetStatus, decommissionAsset].flatMap((m) => m.mock.calls);

describe.each(CASES)('$command', (testCase) => {
  describe('what is refused before anything is sent', () => {
    it('refuses a post with no session', async () => {
      currentSession.mockResolvedValue(null);
      expect(await testCase.submit(formData(testCase))).toEqual({
        kind: 'REFUSED',
        reason: 'NO_SESSION',
      });
      expect(sent()).toHaveLength(0);
    });

    it.each([null, 'someone-elses'])('refuses CSRF token %j', async (csrf) => {
      expect(await testCase.submit(formData(testCase, undefined, { csrf }))).toEqual({
        kind: 'REFUSED',
        reason: 'CSRF',
      });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a submission id the client chose, one never issued, and one minted for somebody else', async () => {
      for (const submission of [
        null,
        'chosen-by-the-client',
        `sub_${'A'.repeat(38)}`,
        mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
        mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' }),
      ]) {
        expect(await testCase.submit(formData(testCase, undefined, { submission }))).toEqual({
          kind: 'REFUSED',
          reason: 'SUBMISSION',
        });
      }
      expect(sent()).toHaveLength(0);
    });

    it('refuses a post with no baseline, and a baseline the client wrote itself', async () => {
      expect(await testCase.submit(formData(testCase, undefined, { baseline: null }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      const forged = Buffer.from(
        JSON.stringify({
          assetId: OTHER_ASSET_ID,
          command: testCase.command,
          version: 1,
          status: testCase.shownStatus,
          assetName: NAME,
          exp: 4_000_000_000,
        }),
      ).toString('base64url');
      expect(
        await testCase.submit(
          formData(testCase, undefined, { baseline: `${forged}.${'A'.repeat(43)}` }),
        ),
      ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      expect(sent()).toHaveLength(0);
    });

    it('refuses a baseline signed for somebody else, or from an earlier login', async () => {
      for (const session of [
        { ...SESSION, subject: 'someone-else' },
        { ...SESSION, csrfToken: 'the-token-before-re-login' },
      ]) {
        expect(
          await testCase.submit(
            formData(testCase, undefined, { baseline: baselineFor(testCase, {}, session) }),
          ),
        ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      }
      expect(sent()).toHaveLength(0);
    });

    it('refuses a baseline signed for one of the other commands', async () => {
      for (const other of CASES.filter((candidate) => candidate.command !== testCase.command)) {
        expect(
          await testCase.submit(formData(testCase, undefined, { baseline: baselineFor(other) })),
        ).toEqual({ kind: 'REFUSED', reason: 'BASELINE' });
      }
      expect(sent()).toHaveLength(0);
    });

    it('refuses a genuine baseline for ANOTHER asset of the same person, and sends nothing (the swap)', async () => {
      // Both baselines are valid: same session, same command, signed by this
      // server. The form belongs to asset A's page; the baseline names B. A
      // person who confirmed A's name must never act on B.
      const ofB = baselineFor(testCase, { assetId: OTHER_ASSET_ID, assetName: 'ماشین دیگر' });

      expect(await testCase.submit(formData(testCase, undefined, { baseline: ofB }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      expect(sent()).toHaveLength(0);
      expect(redirect).not.toHaveBeenCalled();
    });

    it('does the same from the other side: asset B’s page refuses asset A’s baseline', async () => {
      const ofA = baselineFor(testCase);
      const onB = (form: FormData) => submitOn(testCase, OTHER_ASSET_ID, form);
      expect(await onB(formData(testCase, undefined, { baseline: ofA }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
      expect(sent()).toHaveLength(0);
    });

    it('acts on a page’s own baseline for each of two assets of one session, each on its own', async () => {
      const own = await redirectedTo(testCase.submit(formData(testCase)));
      expect(own.pathname).toBe(`/assets/${ASSET_ID}`);
      expect(testCase.send.mock.calls[0]![1]).toBe(ASSET_ID);
    });

    it('refuses an expired baseline', async () => {
      const token = baselineFor(testCase);
      jest.useFakeTimers({ now: Date.now() + 31 * 60 * 1000 });
      try {
        expect(await testCase.submit(formData(testCase, undefined, { baseline: token }))).toEqual({
          kind: 'REFUSED',
          reason: 'BASELINE',
        });
      } finally {
        jest.useRealTimers();
      }
      expect(sent()).toHaveLength(0);
    });
  });

  describe('what is sent, and to which asset at which version', () => {
    it('sends to the asset and the version the baseline names, however the form is rewritten', async () => {
      const tampered = formData(testCase, {
        ...testCase.valid,
        assetId: OTHER_ASSET_ID,
        id: OTHER_ASSET_ID,
        expectedVersion: '999',
        version: '999',
        status: testCase.command === 'status' ? 'IDLE' : 'ASSIGNED',
      });
      await redirectedTo(testCase.submit(tampered));

      expect(testCase.send).toHaveBeenCalledTimes(1);
      const args = testCase.send.mock.calls[0]!;
      expect(args[0]).toBe(SESSION);
      expect(args[1]).toBe(ASSET_ID);
      // The version is the third argument for activate and the fourth for the other two.
      expect(args).toContain(VERSION);
      expect(args).not.toContain(999);
      expect(JSON.stringify(args)).not.toContain(OTHER_ASSET_ID);
    });

    it('sends the submission id the form carried', async () => {
      const submission = mintSubmissionId(SESSION);
      await redirectedTo(testCase.submit(formData(testCase, undefined, { submission })));
      expect(testCase.send.mock.calls[0]).toContain(submission);
    });

    it('lands on a fresh read of the asset, with a flash only this session can read for this asset', async () => {
      const target = await redirectedTo(testCase.submit(formData(testCase)));
      expect(target.pathname).toBe(`/assets/${ASSET_ID}`);
      const flash = target.searchParams.get('flash');
      expect(readFlash(SESSION, flash, ASSET_ID, [testCase.notice])).toBe(testCase.notice);
      expect(readFlash(SESSION, flash, OTHER_ASSET_ID, [testCase.notice])).toBeUndefined();
      expect(
        readFlash({ ...SESSION, subject: 'someone-else' }, flash, ASSET_ID, [testCase.notice]),
      ).toBeUndefined();
    });

    it('sends nothing the person typed beyond the form’s own fields', async () => {
      await redirectedTo(
        testCase.submit(
          formData(testCase, { ...testCase.valid, role: 'SYSTEM_ADMIN', extra: 'x' }),
        ),
      );
      expect(JSON.stringify(testCase.send.mock.calls[0])).not.toMatch(/SYSTEM_ADMIN|"extra"/);
    });
  });

  describe('what the service answers', () => {
    it('shows a fresh read, with a sentence that nothing was written this time, on a 409 for the version', async () => {
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: {},
        message: ASSET_LIFECYCLE_CONFLICT_MESSAGE,
        correlationId: 'corr-409',
      });

      const target = await redirectedTo(testCase.submit(formData(testCase)));

      expect(target.pathname).toBe(`/assets/${ASSET_ID}`);
      const flash = target.searchParams.get('flash');
      expect(readFlash(SESSION, flash, ASSET_ID, ['lifecycleConflict'])).toBe('lifecycleConflict');
      expect(readFlash(SESSION, flash, ASSET_ID, [testCase.notice])).toBeUndefined();
      expect(testCase.send).toHaveBeenCalledTimes(1);
    });

    it('keeps what was typed, and the submission id, on a refusal it can explain', async () => {
      testCase.send.mockResolvedValue({
        kind: 'INVALID',
        fieldErrors: {},
        message: 'دارایی باید بیمه‌نامهٔ معتبر داشته باشد',
        correlationId: 'corr-422',
      });
      const submission = mintSubmissionId(SESSION);

      expect(await testCase.submit(formData(testCase, undefined, { submission }))).toMatchObject({
        kind: 'INVALID',
        submissionId: submission,
        values: expect.objectContaining(testCase.valid),
        message: 'دارایی باید بیمه‌نامهٔ معتبر داشته باشد',
      });
    });

    it.each([
      [
        'FORBIDDEN',
        { kind: 'FORBIDDEN', correlationId: 'c1' },
        { kind: 'FORBIDDEN', correlationId: 'c1' },
      ],
      [
        'NOT_FOUND',
        { kind: 'NOT_FOUND', correlationId: 'c2' },
        { kind: 'NOT_FOUND', correlationId: 'c2' },
      ],
      [
        'UNAVAILABLE',
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c3' },
        { kind: 'FAILED', status: 503, correlationId: 'c3' },
      ],
      [
        'UNKNOWN_OUTCOME',
        { kind: 'UNKNOWN_OUTCOME', correlationId: 'c4' },
        { kind: 'UNCONFIRMED', correlationId: 'c4' },
      ],
      [
        'IN_PROGRESS',
        { kind: 'IN_PROGRESS', retryAfterSeconds: 1, correlationId: 'c5' },
        { kind: 'UNCONFIRMED', correlationId: 'c5' },
      ],
    ])('says %s without claiming more than it knows', async (_name, result, state) => {
      testCase.send.mockResolvedValue(result);
      expect(await testCase.submit(formData(testCase))).toEqual(state);
      expect(redirect).not.toHaveBeenCalled();
    });
  });

  it('answers a 404 for another organization’s asset exactly as for a missing one', async () => {
    // Each on the page of its own id, with a baseline signed for that id: the
    // portal asks the service, which answers the same for both.
    const MISSING_ID = 'AST_01J00000000000000000000123';
    testCase.send.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'same-shape' });
    const ofAnotherTenant = await submitOn(testCase, ASSET_ID, formData(testCase));
    testCase.send.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'same-shape' });
    const ofNothing = await submitOn(
      testCase,
      MISSING_ID,
      formData(testCase, undefined, { baseline: baselineFor(testCase, { assetId: MISSING_ID }) }),
    );
    expect(ofAnotherTenant).toEqual(ofNothing);
    expect(ofNothing).toMatchObject({ kind: 'NOT_FOUND' });
  });
});

describe('change status: what the form itself catches', () => {
  const status = CASES[1]!;

  it('does not call the service for a status the page did not offer from the one it showed', async () => {
    // The page showed ACTIVE: the machine can go idle or out of service, not back to ACTIVE.
    const state = await status.submit(formData(status, { status: 'ACTIVE', reason: 'abc' }));
    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { status: expect.any(String) } });
    expect(status.send).not.toHaveBeenCalled();
  });

  it('does not call the service for a status the service never takes here', async () => {
    for (const target of ['ASSIGNED', 'IN_MAINTENANCE', 'DECOMMISSIONED', '']) {
      expect(
        await status.submit(formData(status, { status: target, reason: 'abc' })),
      ).toMatchObject({ kind: 'INVALID', fieldErrors: { status: expect.any(String) } });
    }
    expect(status.send).not.toHaveBeenCalled();
  });

  it('does not call the service without a reason, and keeps what was typed', async () => {
    const submission = mintSubmissionId(SESSION);
    const state = await status.submit(
      formData(status, { status: 'IDLE', reason: '  ' }, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { status: 'IDLE', reason: '  ' },
      fieldErrors: { reason: expect.any(String) },
    });
    expect(status.send).not.toHaveBeenCalled();
  });

  it('draws the offered statuses from the signed status: out of service can only return', async () => {
    const token = baselineFor(status, { status: 'OUT_OF_SERVICE' });
    expect(
      await status.submit(formData(status, { status: 'IDLE', reason: 'abc' }, { baseline: token })),
    ).toMatchObject({ kind: 'INVALID', fieldErrors: { status: expect.any(String) } });
    await redirectedTo(
      status.submit(formData(status, { status: 'ACTIVE', reason: 'abc' }, { baseline: token })),
    );
    expect(status.send).toHaveBeenCalledTimes(1);
  });

  it('sends the status and the trimmed reason, and nothing else, as the body', async () => {
    await redirectedTo(
      status.submit(formData(status, { status: 'OUT_OF_SERVICE', reason: '  عیب فنی  ' })),
    );
    expect(status.send.mock.calls[0]![2]).toEqual({ status: 'OUT_OF_SERVICE', reason: 'عیب فنی' });
  });
});

describe('decommission: the confirmation', () => {
  const decommission = CASES[2]!;

  it.each([[{}], [{ confirm: '' }], [{ confirm: 'on' }], [{ confirm: 'true' }]])(
    'does not decommission without an explicit yes: %j',
    async (override) => {
      const state = await decommission.submit(
        formData(decommission, { ...decommission.valid, confirm: '', ...override }),
      );
      expect(state).toMatchObject({
        kind: 'INVALID',
        fieldErrors: { confirm: expect.any(String) },
      });
      expect(decommission.send).not.toHaveBeenCalled();
    },
  );

  it('does not decommission with a confirmation and no reason', async () => {
    const state = await decommission.submit(
      formData(decommission, { reason: 'کوتاه', confirm: 'yes' }),
    );
    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { reason: expect.any(String) } });
    expect(decommission.send).not.toHaveBeenCalled();
  });

  it('sends the reason alone as the body: the tick is not a field of the service’s', async () => {
    await redirectedTo(decommission.submit(formData(decommission)));
    expect(decommission.send.mock.calls[0]![2]).toEqual({ reason: decommission.valid.reason });
  });

  it('is offered no second chance on the same stale baseline after a conflict', async () => {
    decommission.send.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: ASSET_LIFECYCLE_CONFLICT_MESSAGE,
      correlationId: 'c',
    });
    await redirectedTo(decommission.submit(formData(decommission)));
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});

describe('the same form sent twice (a double click, a browser retry, a resubmitted POST)', () => {
  /**
   * asset-service, in miniature: it applies a command to the version it names,
   * and moves the version. Whatever answers the second send is the service's
   * rule, which its own specs pin; this proves the portal sends the *same*
   * version twice and shows the second answer as "already changed".
   */
  function serviceAtVersion(start: number) {
    let version = start;
    const applied: number[] = [];
    return {
      applied,
      answer: async (...args: unknown[]) => {
        const named = args.find((arg): arg is number => typeof arg === 'number');
        if (named !== version) {
          return {
            kind: 'INVALID' as const,
            fieldErrors: {},
            message: ASSET_LIFECYCLE_CONFLICT_MESSAGE,
            correlationId: 'corr-409',
          };
        }
        applied.push(version);
        version += 1;
        return { kind: 'CREATED' as const, data: { id: ASSET_ID }, correlationId: 'corr-ok' };
      },
    };
  }

  it.each(CASES)(
    '$command: the second send is "already changed", and one command is applied',
    async (testCase) => {
      const service = serviceAtVersion(VERSION);
      testCase.send.mockImplementation(service.answer);

      // One rendered form, one baseline, one submission id — posted twice.
      const submission = mintSubmissionId(SESSION);
      const baseline = baselineFor(testCase);
      const post = () =>
        redirectedTo(testCase.submit(formData(testCase, undefined, { submission, baseline })));

      const first = await post();
      const second = await post();

      expect(readFlash(SESSION, first.searchParams.get('flash'), ASSET_ID, [testCase.notice])).toBe(
        testCase.notice,
      );
      expect(
        readFlash(SESSION, second.searchParams.get('flash'), ASSET_ID, ['lifecycleConflict']),
      ).toBe('lifecycleConflict');
      expect(testCase.send).toHaveBeenCalledTimes(2);
      expect(service.applied).toEqual([VERSION]);
    },
  );
});
