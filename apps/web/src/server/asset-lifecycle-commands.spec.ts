/**
 * @jest-environment node
 */
import {
  ASSET_LIFECYCLE_CONFLICT_MESSAGE,
  DECOMMISSION_UNCONFIRMED_MESSAGE,
  NOT_OFFERED_MESSAGE,
  activateAsset,
  canChangeAssetStatus,
  canDecommissionAsset,
  changeAssetStatus,
  changeStatusFormValues,
  decommissionAsset,
  decommissionFormValues,
  openAssetLifecycleBaseline,
  parseChangeStatusForm,
  parseDecommissionForm,
  sealAssetLifecycleBaseline,
} from './asset-lifecycle-commands';
import { signPayload } from './signed-payload';
import type { WebSession } from './session';
import {
  canActivateFrom,
  canDecommissionFrom,
  statusTargetsFrom,
} from '@/lib/asset-lifecycle-fields';

/**
 * The three lifecycle commands: what a person may type and in what words a
 * mistake is reported, what is sent and where, every sentence the service says
 * for these endpoints in Persian, and the baseline that names the asset and the
 * version.
 *
 * The form's rules are a courtesy that saves a round trip; the service is the
 * enforcement (`asset-lifecycle-commands.contract.spec.ts` pins the two together).
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

beforeEach(() => {
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

const ASSET = 'AST_01J00000000000000000000000';

describe('who is offered the forms', () => {
  it.each([
    [['ORGANIZATION_ADMIN'], true, true],
    [['FLEET_MANAGER'], true, false],
    [['UNION_ADMIN'], true, true],
    [['OPERATOR'], false, false],
    [['DRIVER', 'OPERATOR'], false, false],
    [[], false, false],
  ])('%j: status/activate %s, decommission %s', (roles, status, decommission) => {
    expect(canChangeAssetStatus(roles)).toBe(status);
    expect(canDecommissionAsset(roles)).toBe(decommission);
  });
});

describe('which commands a status leaves open', () => {
  it.each([
    ['REGISTERED', true, ['OUT_OF_SERVICE'], true],
    ['ACTIVE', false, ['IDLE', 'OUT_OF_SERVICE'], true],
    ['IDLE', false, ['ACTIVE', 'OUT_OF_SERVICE'], true],
    ['OUT_OF_SERVICE', false, ['ACTIVE'], true],
    // Open work in another service: nothing from here (docs/24 Q-93).
    ['ASSIGNED', false, [], false],
    ['IN_MAINTENANCE', false, [], false],
    ['DECOMMISSIONED', false, [], false],
    ['SOMETHING_NEW', false, [], false],
  ])('%s: activate %s, targets %j, decommission %s', (status, activate, targets, decommission) => {
    expect(canActivateFrom(status)).toBe(activate);
    expect(statusTargetsFrom(status)).toEqual(targets);
    expect(canDecommissionFrom(status)).toBe(decommission);
  });

  it('never offers a plain status change to ACTIVE from REGISTERED: that is activation, with its dossier check', () => {
    expect(statusTargetsFrom('REGISTERED')).not.toContain('ACTIVE');
  });

  it('never offers a status the owning service decides (ASSIGNED, IN_MAINTENANCE) or the terminal one', () => {
    for (const status of ['REGISTERED', 'ACTIVE', 'IDLE', 'OUT_OF_SERVICE', 'ASSIGNED']) {
      const targets: string[] = statusTargetsFrom(status);
      for (const forbidden of ['ASSIGNED', 'IN_MAINTENANCE', 'DECOMMISSIONED', 'REGISTERED']) {
        expect(targets).not.toContain(forbidden);
      }
    }
  });
});

describe('the change-status form', () => {
  const form = (over: Record<string, string> = {}) => ({
    status: 'IDLE',
    reason: 'فصل غیرکاری',
    ...over,
  });

  it('reads only its own two fields from a post', () => {
    const post = new FormData();
    post.set('status', 'IDLE');
    post.set('reason', 'x');
    post.set('assetId', 'AST_other');
    post.set('expectedVersion', '1');
    expect(changeStatusFormValues(post)).toEqual({ status: 'IDLE', reason: 'x' });
  });

  it('sends the status and the trimmed reason, and nothing else', () => {
    expect(parseChangeStatusForm(form({ reason: '  فصل غیرکاری  ' }), 'ACTIVE')).toEqual({
      ok: true,
      body: { status: 'IDLE', reason: 'فصل غیرکاری' },
    });
  });

  it('sends the reason as typed: no letter folding, no character class (the service has none)', () => {
    const typed = 'ي ك ٣ <b> «تست» 🚜';
    const parsed = parseChangeStatusForm(form({ reason: typed }), 'ACTIVE');
    expect(parsed).toEqual({ ok: true, body: { status: 'IDLE', reason: typed } });
  });

  it.each([
    ['empty', '', 'دلیل تغییر را بنویسید'],
    ['blank', '   ', 'دلیل تغییر را بنویسید'],
    ['too short', 'ab', 'دلیل تغییر دست‌کم ۳ نویسه باشد'],
    ['too long', 'x'.repeat(501), 'دلیل تغییر حداکثر ۵۰۰ نویسه است'],
  ])('refuses a %s reason with a sentence on the reason field', (_name, reason, message) => {
    expect(parseChangeStatusForm(form({ reason }), 'ACTIVE')).toEqual({
      ok: false,
      fieldErrors: { reason: message },
    });
  });

  it('accepts a reason at each bound', () => {
    expect(parseChangeStatusForm(form({ reason: 'abc' }), 'ACTIVE').ok).toBe(true);
    expect(parseChangeStatusForm(form({ reason: 'x'.repeat(500) }), 'ACTIVE').ok).toBe(true);
  });

  it.each(['', 'ASSIGNED', 'IN_MAINTENANCE', 'DECOMMISSIONED', 'REGISTERED', 'active', 'DROP'])(
    'refuses the status %j: not one the service takes on this route',
    (status) => {
      expect(parseChangeStatusForm(form({ status }), 'ACTIVE')).toEqual({
        ok: false,
        fieldErrors: { status: 'وضعیت تازه را از فهرست انتخاب کنید' },
      });
    },
  );

  it('refuses a target the page did not offer from the status it showed', () => {
    // The page showed OUT_OF_SERVICE, which can only return to ACTIVE.
    expect(parseChangeStatusForm(form({ status: 'IDLE' }), 'OUT_OF_SERVICE')).toEqual({
      ok: false,
      fieldErrors: { status: NOT_OFFERED_MESSAGE },
    });
    // The page showed a machine that is not yet in service.
    expect(parseChangeStatusForm(form({ status: 'ACTIVE' }), 'REGISTERED')).toEqual({
      ok: false,
      fieldErrors: { status: NOT_OFFERED_MESSAGE },
    });
    expect(parseChangeStatusForm(form({ status: 'IDLE' }), 'DECOMMISSIONED').ok).toBe(false);
  });
});

describe('the decommission form', () => {
  const form = (over: Record<string, string> = {}) => ({
    reason: 'فرسودگی کامل و هزینهٔ تعمیر بیش از ارزش',
    confirm: 'yes',
    ...over,
  });

  it('reads only its own two fields from a post', () => {
    const post = new FormData();
    post.set('reason', 'x');
    post.set('confirm', 'yes');
    post.set('assetId', 'AST_other');
    expect(decommissionFormValues(post)).toEqual({ reason: 'x', confirm: 'yes' });
  });

  it('sends the reason alone: the tick is the person’s, not the service’s', () => {
    expect(parseDecommissionForm(form())).toEqual({
      ok: true,
      body: { reason: 'فرسودگی کامل و هزینهٔ تعمیر بیش از ارزش' },
    });
  });

  it.each(['', 'on', 'true', 'YES', 'no'])(
    'does not decommission on the confirmation %j: only an explicit yes does',
    (confirm) => {
      expect(parseDecommissionForm(form({ confirm }))).toEqual({
        ok: false,
        fieldErrors: { confirm: DECOMMISSION_UNCONFIRMED_MESSAGE },
      });
    },
  );

  it.each([
    ['empty', '', 'دلیل اسقاط را بنویسید'],
    ['too short', 'کوتاه', 'دلیل اسقاط دست‌کم ۱۰ نویسه باشد'],
    ['too long', 'x'.repeat(1001), 'دلیل اسقاط حداکثر ۱۰۰۰ نویسه است'],
  ])('refuses a %s reason', (_name, reason, message) => {
    expect(parseDecommissionForm(form({ reason }))).toEqual({
      ok: false,
      fieldErrors: { reason: message },
    });
  });

  it('reports both problems at once, so a person does not find the second on the next try', () => {
    expect(parseDecommissionForm({ reason: '', confirm: '' })).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.any(String), confirm: DECOMMISSION_UNCONFIRMED_MESSAGE },
    });
  });
});

describe('writing', () => {
  interface Recorded {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: unknown;
  }

  function recording(status: number, body: unknown) {
    const calls: Recorded[] = [];
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  const OK = { id: ASSET, status: 'ACTIVE', version: 8 };

  it.each([
    [
      'activates',
      'activate',
      (impl: typeof fetch) => activateAsset(SESSION, ASSET, 7, 'sub_abc', impl),
      { expectedVersion: 7 },
    ],
    [
      'changes the status',
      'status',
      (impl: typeof fetch) =>
        changeAssetStatus(
          SESSION,
          ASSET,
          { status: 'IDLE', reason: 'فصل غیرکاری' },
          7,
          'sub_abc',
          impl,
        ),
      { status: 'IDLE', reason: 'فصل غیرکاری', expectedVersion: 7 },
    ],
    [
      'decommissions',
      'decommission',
      (impl: typeof fetch) =>
        decommissionAsset(SESSION, ASSET, { reason: 'فرسودگی کامل ماشین' }, 7, 'sub_abc', impl),
      { reason: 'فرسودگی کامل ماشین', expectedVersion: 7 },
    ],
  ])(
    '%s: a POST to its own path with the version, the key and the token',
    async (_verb, action, call, body) => {
      const { impl, calls } = recording(200, OK);

      expect(await call(impl)).toMatchObject({ kind: 'CREATED', data: { id: ASSET } });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        url: `http://gateway.test:3000/v1/assets/${ASSET}/${action}`,
        method: 'POST',
        body,
      });
      expect(calls[0]!.headers['idempotency-key']).toBe('sub_abc');
      expect(calls[0]!.headers.authorization).toBe('Bearer access-token-value');
    },
  );

  it('encodes the asset id into the path, so an id with a slash cannot address another endpoint', async () => {
    const { impl, calls } = recording(200, OK);
    await activateAsset(SESSION, '../../maintenance-requests/x', 1, 's', impl);
    expect(calls[0]!.url).toBe(
      'http://gateway.test:3000/v1/assets/..%2F..%2Fmaintenance-requests%2Fx/activate',
    );
  });

  it('treats an answer that does not look like the asset as unconfirmed, never as "nothing happened"', async () => {
    expect(
      await activateAsset(SESSION, ASSET, 1, 's', recording(200, { nope: true }).impl),
    ).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
  });

  describe('what the service says, in Persian', () => {
    const CODE_AND_STATUS = {
      OPTIMISTIC_LOCK_FAILED: 409,
      INVALID_STATE_TRANSITION: 409,
      BUSINESS_RULE_VIOLATION: 422,
    } as const;

    it.each([
      [
        'OPTIMISTIC_LOCK_FAILED',
        'Asset was modified by another request; reload and retry',
        ASSET_LIFECYCLE_CONFLICT_MESSAGE,
      ],
      [
        'INVALID_STATE_TRANSITION',
        'A DECOMMISSIONED asset cannot change status. This state is final because financial and audit records still reference the asset.',
        'این دارایی اسقاط شده و نهایی است؛ وضعیت آن دیگر تغییر نمی‌کند.',
      ],
      [
        'BUSINESS_RULE_VIOLATION',
        'The asset cannot be activated without an insurance policy currently in force.',
        'برای فعال‌سازی، دارایی باید بیمه‌نامهٔ معتبر داشته باشد. بیمه‌نامه ثبت کنید و دوباره تلاش کنید.',
      ],
      [
        'BUSINESS_RULE_VIOLATION',
        'The asset cannot be activated without an ownership title or registration card.',
        'برای فعال‌سازی، سند مالکیت یا کارت ماشین دارایی باید ثبت شده باشد.',
      ],
      [
        'BUSINESS_RULE_VIOLATION',
        'The asset cannot be activated without an insurance policy currently in force and an ownership title or registration card.',
        'برای فعال‌سازی، دارایی هم بیمه‌نامهٔ معتبر و هم سند مالکیت یا کارت ماشین لازم دارد؛ هیچ‌کدام ثبت نشده است.',
      ],
      [
        'INVALID_STATE_TRANSITION',
        'A registered asset is commissioned with the activate command, which checks that its dossier is complete.',
        'دارایی ثبت‌شده با دستور «فعال‌سازی» به ناوگان می‌پیوندد، که کامل بودن پرونده را بررسی می‌کند.',
      ],
    ] as const)('%s — %j', async (code, sentence, persian) => {
      for (const call of [
        (impl: typeof fetch) => activateAsset(SESSION, ASSET, 1, 's', impl),
        (impl: typeof fetch) =>
          changeAssetStatus(SESSION, ASSET, { status: 'IDLE', reason: 'abc' }, 1, 's', impl),
        (impl: typeof fetch) =>
          decommissionAsset(SESSION, ASSET, { reason: 'abcdefghij' }, 1, 's', impl),
      ]) {
        const result = await call(
          recording(CODE_AND_STATUS[code], { code, message: sentence }).impl,
        );
        expect(result).toMatchObject({ kind: 'INVALID', message: persian });
        expect(result.kind === 'INVALID' && result.message).not.toMatch(/[A-Za-z]{4,}/);
      }
    });

    it.each([
      ['OPEN_ASSIGNMENT', 'تخصیص باز دارد', 'fleet-service'],
      ['OPEN_MAINTENANCE', 'در تعمیر است', 'maintenance-service'],
    ] as const)(
      'says the closed open-work code %s in Persian, whatever sentence carries it (docs/24 Q-93)',
      async (code, words, owner) => {
        for (const call of [
          (impl: typeof fetch) =>
            changeAssetStatus(
              SESSION,
              ASSET,
              { status: 'OUT_OF_SERVICE', reason: 'abc' },
              1,
              's',
              impl,
            ),
          (impl: typeof fetch) =>
            decommissionAsset(SESSION, ASSET, { reason: 'abcdefghij' }, 1, 's', impl),
        ]) {
          const result = await call(
            recording(409, {
              code: 'INVALID_STATE_TRANSITION',
              // Reworded on purpose: the code decides the Persian, not the English.
              message: `Some future wording naming ${owner}`,
              details: [{ path: 'status', message: `Some future wording naming ${owner}`, code }],
            }).impl,
          );
          expect(result).toMatchObject({ kind: 'INVALID' });
          const said =
            result.kind === 'INVALID'
              ? ((result.fieldErrors as Record<string, string | undefined>).status ??
                result.message ??
                '')
              : '';
          expect(said).toContain(words);
          expect(said).not.toMatch(/[A-Za-z]{4,}/);
        }
      },
    );

    it('says a transition it does not know by its platform code, and an unknown code as it arrived', async () => {
      const call = (impl: typeof fetch) => activateAsset(SESSION, ASSET, 1, 's', impl);
      expect(
        await call(
          recording(409, { code: 'INVALID_STATE_TRANSITION', message: 'A new sentence' }).impl,
        ),
      ).toMatchObject({
        kind: 'INVALID',
        message:
          'وضعیت فعلی دارایی اجازهٔ این کار را نمی‌دهد. صفحه را تازه کنید و وضعیت را ببینید.',
      });
      expect(
        await call(
          recording(409, { code: 'SOME_NEW_CODE', message: 'An asset cannot be frobbed' }).impl,
        ),
      ).toMatchObject({ kind: 'INVALID', message: 'An asset cannot be frobbed' });
    });

    it('puts a field problem from the service on the field it names', async () => {
      const result = await changeAssetStatus(
        SESSION,
        ASSET,
        { status: 'IDLE', reason: 'abc' },
        1,
        's',
        recording(400, {
          code: 'VALIDATION_FAILED',
          message: 'Invalid request',
          details: [{ path: 'reason', message: 'String must contain at least 3 character(s)' }],
        }).impl,
      );
      expect(result).toMatchObject({
        kind: 'INVALID',
        fieldErrors: { reason: 'String must contain at least 3 character(s)' },
      });
    });
  });

  it('reports 403 as FORBIDDEN and 404 as the platform’s non-disclosure', async () => {
    const call = (impl: typeof fetch) => activateAsset(SESSION, ASSET, 1, 's', impl);
    expect(await call(recording(403, { code: 'FORBIDDEN' }).impl)).toMatchObject({
      kind: 'FORBIDDEN',
    });
    expect(await call(recording(404, { code: 'NOT_FOUND' }).impl)).toMatchObject({
      kind: 'NOT_FOUND',
    });
  });

  it('never claims nothing happened when the gateway timed out after forwarding', async () => {
    expect(
      await activateAsset(SESSION, ASSET, 1, 's', recording(504, { code: 'GATEWAY_TIMEOUT' }).impl),
    ).toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });
});

describe('the baseline that names the asset, the version and the status', () => {
  const baseline = (over: Partial<Parameters<typeof sealAssetLifecycleBaseline>[1]> = {}) => ({
    assetId: ASSET,
    command: 'decommission' as const,
    version: 7,
    status: 'ACTIVE',
    assetName: 'لودر کوماتسو',
    ...over,
  });
  const seal = (over = {}) => sealAssetLifecycleBaseline(SESSION, baseline(over));

  it('opens for the command it was signed for, and carries the asset, version, status and name', () => {
    expect(openAssetLifecycleBaseline(SESSION, seal(), 'decommission')).toEqual(baseline());
  });

  it('does not open for another command: the token beside "decommission" cannot mark the asset idle', () => {
    for (const other of ['activate', 'status'] as const) {
      expect(openAssetLifecycleBaseline(SESSION, seal(), other)).toBeNull();
    }
  });

  it('does not open for somebody else, for an earlier login, or once altered', () => {
    const token = seal();
    expect(
      openAssetLifecycleBaseline({ ...SESSION, subject: 'someone-else' }, token, 'decommission'),
    ).toBeNull();
    expect(
      openAssetLifecycleBaseline(
        { ...SESSION, csrfToken: 'the-token-before-re-login' },
        token,
        'decommission',
      ),
    ).toBeNull();

    const mac = token.split('.')[1];
    const forge = (changes: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ ...baseline(), ...changes, exp: 4_102_444_800 })).toString('base64url')}.${mac}`;
    // A different asset, a newer version — each is a payload this server never signed.
    expect(
      openAssetLifecycleBaseline(
        SESSION,
        forge({ assetId: 'AST_01J00000000000000000000099' }),
        'decommission',
      ),
    ).toBeNull();
    expect(openAssetLifecycleBaseline(SESSION, forge({ version: 8 }), 'decommission')).toBeNull();
    for (const junk of ['', 'not-a-token', null, undefined, 42]) {
      expect(openAssetLifecycleBaseline(SESSION, junk, 'decommission')).toBeNull();
    }
  });

  it('does not open once expired — and the window is short', () => {
    const token = seal();
    jest.useFakeTimers({ now: Date.now() + 29 * 60 * 1000 });
    try {
      expect(openAssetLifecycleBaseline(SESSION, token, 'decommission')).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
    jest.useFakeTimers({ now: Date.now() + 31 * 60 * 1000 });
    try {
      expect(openAssetLifecycleBaseline(SESSION, token, 'decommission')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not open a token signed for another purpose: the purpose is part of the key', () => {
    for (const purpose of ['asset-edit-baseline', 'repair-order-baseline', 'flash']) {
      const wrong = signPayload(SESSION, purpose, { ...baseline() }, 600);
      expect(openAssetLifecycleBaseline(SESSION, wrong, 'decommission')).toBeNull();
    }
  });

  it('refuses a payload with a version that is not a positive integer', () => {
    for (const version of [0, -1, 1.5, '7']) {
      const wrong = signPayload(
        SESSION,
        'asset-lifecycle-baseline',
        { ...baseline(), version },
        600,
      );
      expect(openAssetLifecycleBaseline(SESSION, wrong, 'decommission')).toBeNull();
    }
  });
});
