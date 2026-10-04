/**
 * @jest-environment node
 */
import { BASELINE_FIELD } from '@/lib/form-fields';
import type { RepairCommandName } from '@/lib/repair-order-fields';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import {
  REPAIR_TOTAL_CHANGED_MESSAGE,
  sealRepairOrderBaseline,
} from '@/server/repair-order-commands';
import { signPayload } from '@/server/signed-payload';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_COMMAND_FORM } from './form-state';

/**
 * The six commands on a repair order. The order is the assertion: each refusal
 * proves nothing was called, and the order a command acts on is the one the
 * page signed — never one the form names.
 */

const currentSession = jest.fn();
const startRepair = jest.fn();
const completeRepair = jest.fn();
const cancelRepair = jest.fn();
const recordPart = jest.fn();
const recordLabour = jest.fn();
const recordCost = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/repair-order-commands', () => {
  const actual = jest.requireActual('@/server/repair-order-commands');
  return {
    ...actual,
    startRepair: (...args: unknown[]) => startRepair(...args),
    completeRepair: (...args: unknown[]) => completeRepair(...args),
    cancelRepair: (...args: unknown[]) => cancelRepair(...args),
    recordPart: (...args: unknown[]) => recordPart(...args),
    recordLabour: (...args: unknown[]) => recordLabour(...args),
    recordCost: (...args: unknown[]) => recordCost(...args),
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
const actions = require('./repair-actions') as typeof import('./repair-actions');

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
const OTHER_REQUEST = 'MNT_01J00000000000000000000099';
const ORDER_ID = 'RPO_01J00000000000000000000000';
const OTHER_ORDER = 'RPO_01J00000000000000000000099';
const TOTAL = '750000';

/** The baseline the page signs beside a command. */
const baselineFor = (
  command: RepairCommandName,
  over: { requestId?: string; repairOrderId?: string; total?: string; session?: WebSession } = {},
) =>
  sealRepairOrderBaseline(over.session ?? SESSION, {
    requestId: over.requestId ?? REQUEST_ID,
    repairOrderId: over.repairOrderId ?? ORDER_ID,
    command,
    totalCostMinor: over.total ?? TOTAL,
  });

interface Command {
  readonly name: RepairCommandName;
  readonly submit: (form: FormData) => Promise<unknown>;
  readonly service: jest.Mock;
  /** What the person types. */
  readonly typed: Record<string, string>;
  /** Correctly authorised, but a form its own schema refuses. */
  readonly refusedByItsSchema: Record<string, string>;
  readonly notice: string;
}

const COMMANDS: readonly Command[] = [
  {
    name: 'start',
    submit: (form) => actions.submitStartRepair(IDLE_COMMAND_FORM, form),
    service: startRepair,
    typed: { workSummary: 'تعویض شیلنگ' },
    refusedByItsSchema: { workSummary: 'x' },
    notice: 'repairStarted',
  },
  {
    name: 'complete',
    submit: (form) => actions.submitCompleteRepair(IDLE_COMMAND_FORM, form),
    service: completeRepair,
    typed: { workPerformed: 'شیلنگ تعویض شد' },
    refusedByItsSchema: { workPerformed: '' },
    notice: 'repairCompleted',
  },
  {
    name: 'cancel',
    submit: (form) => actions.submitCancelRepair(IDLE_COMMAND_FORM, form),
    service: cancelRepair,
    typed: { reason: 'تعمیرگاه نپذیرفت' },
    refusedByItsSchema: { reason: 'ab' },
    notice: 'repairCancelled',
  },
  {
    name: 'part',
    submit: (form) => actions.submitRecordPart(IDLE_COMMAND_FORM, form),
    service: recordPart,
    typed: {
      partName: 'فیلتر روغن',
      quantity: '2',
      unit: 'عدد',
      unitCostMinor: '350000',
      source: 'WORKSHOP_SUPPLIED',
    },
    refusedByItsSchema: {
      partName: '',
      quantity: '0',
      unit: 'عدد',
      unitCostMinor: '1',
      source: 'X',
    },
    notice: 'partRecorded',
  },
  {
    name: 'labour',
    submit: (form) => actions.submitRecordLabour(IDLE_COMMAND_FORM, form),
    service: recordLabour,
    typed: { description: 'تعویض شیلنگ', hours: '1.5', hourlyRateMinor: '800000' },
    refusedByItsSchema: { description: 'تعویض شیلنگ', hours: '0', hourlyRateMinor: '800000' },
    notice: 'labourRecorded',
  },
  {
    name: 'cost',
    submit: (form) => actions.submitRecordCost(IDLE_COMMAND_FORM, form),
    service: recordCost,
    typed: { category: 'SERVICE', amountMinor: '500000', description: 'ایاب و ذهاب' },
    refusedByItsSchema: { category: 'SERVICE', amountMinor: '0', description: 'ایاب و ذهاب' },
    notice: 'costRecorded',
  },
];

/** A post as the page would have rendered it: the typed fields and this command's baseline. */
const validFor = (command: Command) => ({
  ...command.typed,
  [BASELINE_FIELD]: baselineFor(command.name),
});

function formData(
  fields: Record<string, string>,
  options: { csrf?: string | null; submission?: string | null; requestId?: string | null } = {},
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
    expect(await command.submit(formData(validFor(command)))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    noneCalled();
  });

  it('refuses a post with no CSRF token, and one from another session', async () => {
    for (const csrf of [null, 'someone-elses']) {
      expect(await command.submit(formData(validFor(command), { csrf }))).toEqual({
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
      expect(await command.submit(formData(validFor(command), { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    noneCalled();
  });

  it('answers a request id that cannot be a request’s as a missing one, and calls nothing', async () => {
    for (const requestId of [null, '', 'x', ORDER_ID, 'MNT/../x']) {
      expect(await command.submit(formData(validFor(command), { requestId }))).toEqual({
        kind: 'NOT_FOUND',
        correlationId: null,
      });
    }
    noneCalled();
  });
});

describe.each(COMMANDS)('$name — an order that is not the one the page showed', (command) => {
  const BASELINE_REFUSED = { kind: 'REFUSED', reason: 'BASELINE' };

  it('refuses a form with no baseline at all', async () => {
    expect(await command.submit(formData(command.typed))).toEqual(BASELINE_REFUSED);
    noneCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('refuses a form that names another request than the baseline was signed for', async () => {
    // A manager edits the hidden request id but keeps the order's signed baseline.
    const form = formData(validFor(command), { requestId: OTHER_REQUEST });
    expect(await command.submit(form)).toEqual(BASELINE_REFUSED);
    noneCalled();
  });

  it('refuses a baseline signed for another command on the same order', async () => {
    for (const other of COMMANDS.filter((candidate) => candidate.name !== command.name)) {
      const form = formData({ ...command.typed, [BASELINE_FIELD]: baselineFor(other.name) });
      expect(await command.submit(form)).toEqual(BASELINE_REFUSED);
    }
    noneCalled();
  });

  it('refuses a baseline signed for somebody else, one from an earlier login, and one that was altered', async () => {
    const theirs = baselineFor(command.name, { session: { ...SESSION, subject: 'someone-else' } });
    const earlier = baselineFor(command.name, {
      session: { ...SESSION, csrfToken: 'the-token-before-re-login' },
    });
    const mac = baselineFor(command.name).split('.')[1];
    const altered = `${Buffer.from(
      JSON.stringify({
        requestId: REQUEST_ID,
        repairOrderId: OTHER_ORDER,
        command: command.name,
        totalCostMinor: TOTAL,
        exp: 4_102_444_800,
      }),
    ).toString('base64url')}.${mac}`;

    for (const baseline of [theirs, earlier, altered, 'not-a-token', '']) {
      expect(
        await command.submit(formData({ ...command.typed, [BASELINE_FIELD]: baseline })),
      ).toEqual(BASELINE_REFUSED);
    }
    noneCalled();
  });

  it('refuses a baseline that has expired', async () => {
    // Minted now, posted five hours later.
    const form = formData(validFor(command));
    jest.useFakeTimers({ now: Date.now() + 5 * 60 * 60 * 1000 });
    try {
      expect(await command.submit(form)).toEqual(BASELINE_REFUSED);
    } finally {
      jest.useRealTimers();
    }
    noneCalled();
  });

  it('does not accept the approval’s baseline in its place: the purpose is part of the key', async () => {
    const wrongPurpose = signPayload(
      SESSION,
      'maintenance-approval-baseline',
      { requestId: REQUEST_ID, totalCostMinor: TOTAL },
      600,
    );
    expect(
      await command.submit(formData({ ...command.typed, [BASELINE_FIELD]: wrongPurpose })),
    ).toEqual(BASELINE_REFUSED);
    noneCalled();
  });

  it('acts on the order the baseline names, whatever order the form says', async () => {
    const form = formData(validFor(command));
    // Fields a form never carries: if they arrive they are not read.
    form.set('repairOrderId', OTHER_ORDER);
    form.set('expectedTotalCostMinor', '1');
    await expect(command.submit(form)).rejects.toThrow(/NEXT_REDIRECT/);

    expect(command.service).toHaveBeenCalledTimes(1);
    expect(command.service.mock.calls[0][1]).toBe(ORDER_ID);
  });
});

describe.each(COMMANDS)('$name — what reaches the service', (command) => {
  it('acts under the session, with the submission id and only what was typed', async () => {
    const submission = mintSubmissionId(SESSION);
    await expect(command.submit(formData(validFor(command), { submission }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );

    expect(command.service).toHaveBeenCalledTimes(1);
    const [session, orderId, body, submissionId] = command.service.mock.calls[0];
    expect(session).toBe(SESSION);
    expect(orderId).toBe(ORDER_ID);
    expect(submissionId).toBe(submission);
    for (const unwanted of ['requestId', 'repairOrderId', BASELINE_FIELD, 'csrf']) {
      expect(body).not.toHaveProperty(unwanted);
    }
  });

  it('redirects to a fresh read of the request with a flash the server signed for it', async () => {
    await expect(command.submit(formData(validFor(command)))).rejects.toThrow(/NEXT_REDIRECT/);

    const url = redirect.mock.calls[0][0] as string;
    expect(url.startsWith(`/maintenance/${REQUEST_ID}?flash=`)).toBe(true);
    const flash = new URLSearchParams(url.split('?')[1]).get('flash');
    expect(readFlash(SESSION, flash, REQUEST_ID, [command.notice])).toBe(command.notice);
    expect(url).not.toContain('done=');
  });

  it('does not send a form the form schema refuses', async () => {
    const form = formData({
      ...command.refusedByItsSchema,
      [BASELINE_FIELD]: baselineFor(command.name),
    });
    expect(await command.submit(form)).toMatchObject({
      kind: 'INVALID',
      fieldErrors: expect.any(Object),
    });
    expect(command.service).not.toHaveBeenCalled();
  });

  it('returns the service’s refusal with what was typed still in hand', async () => {
    command.service.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'A sentence',
      correlationId: 'corr-sample',
    });
    expect(await command.submit(formData(validFor(command)))).toMatchObject({
      kind: 'INVALID',
      message: 'A sentence',
      values: expect.any(Object),
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('answers an order that is not visible with the request’s own state, never saying which', async () => {
    command.service.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-sample' });
    expect(await command.submit(formData(validFor(command)))).toEqual({
      kind: 'NOT_FOUND',
      correlationId: 'corr-sample',
    });
  });

  it('reports a forbidden write with its correlation id', async () => {
    command.service.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-sample' });
    expect(await command.submit(formData(validFor(command)))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'corr-sample',
    });
  });

  it.each(['UNKNOWN_OUTCOME', 'IN_PROGRESS'])(
    'reports %s as UNCONFIRMED: nothing here may say it did not happen',
    async (kind) => {
      command.service.mockResolvedValue({
        kind,
        retryAfterSeconds: 1,
        correlationId: 'corr-sample',
      });
      expect(await command.submit(formData(validFor(command)))).toEqual({
        kind: 'UNCONFIRMED',
        correlationId: 'corr-sample',
      });
      expect(redirect).not.toHaveBeenCalled();
    },
  );

  it('reports an outage with its status, and never puts a token in what the page renders', async () => {
    command.service.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    const state = await command.submit(formData(validFor(command)));
    expect(state).toEqual({ kind: 'FAILED', status: 503, correlationId: 'corr-sample' });
    const text = JSON.stringify(state);
    for (const secret of [SESSION.accessToken, SESSION.refreshToken, SESSION.csrfToken]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('part — the two references are identifiers', () => {
  const part = COMMANDS.find((command) => command.name === 'part')!;
  const post = (fields: Record<string, string>) =>
    part.submit(formData({ ...validFor(part), ...fields }));

  describe.each(['partReference', 'sourceReference'])('%s', (field) => {
    it.each([
      ['U+202E', 0x202e, 'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد'],
      ['U+061C', 0x061c, 'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد'],
      ['ZWNJ', 0x200c, 'شناسه نویسهٔ نامرئی، نیم‌فاصله یا شکست خط نمی‌پذیرد'],
      ['a byte-order mark', 0xfeff, 'شناسه نویسهٔ نامرئی، نیم‌فاصله یا شکست خط نمی‌پذیرد'],
    ])('is not sent carrying %s', async (_label, codePoint, message) => {
      const state = await post({ [field]: `ORD-${String.fromCodePoint(codePoint)}0042` });
      expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { [field]: message } });
      expect(part.service).not.toHaveBeenCalled();
    });

    it('is sent in Persian or Latin letters and digits', async () => {
      await expect(post({ [field]: 'حواله-۱۴۰۳-ORD01' })).rejects.toThrow(/NEXT_REDIRECT/);
      expect(part.service.mock.calls[0][2]).toMatchObject({ [field]: 'حواله-۱۴۰۳-ORD01' });
    });
  });
});

describe('complete — the total the person was shown', () => {
  const complete = COMMANDS[1];

  it('sends the total the page signed, and no amount the form says', async () => {
    const form = formData({
      ...complete.typed,
      [BASELINE_FIELD]: baselineFor('complete', { total: '99' }),
    });
    form.set('expectedTotalCostMinor', '1');
    await expect(complete.submit(form)).rejects.toThrow(/NEXT_REDIRECT/);

    expect(complete.service.mock.calls[0][2]).toEqual({
      workPerformed: 'شیلنگ تعویض شد',
      expectedTotalCostMinor: '99',
    });
  });

  it('sends the person to a page that shows the new figure when the service says it moved', async () => {
    complete.service.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: REPAIR_TOTAL_CHANGED_MESSAGE,
      correlationId: 'corr-sample',
    });

    await expect(complete.submit(formData(validFor(complete)))).rejects.toThrow(/NEXT_REDIRECT/);

    const url = redirect.mock.calls[0][0] as string;
    expect(url.startsWith(`/maintenance/${REQUEST_ID}?flash=`)).toBe(true);
    const flash = new URLSearchParams(url.split('?')[1]).get('flash');
    expect(readFlash(SESSION, flash, REQUEST_ID, ['repairCostChanged'])).toBe('repairCostChanged');
  });

  it('does not treat another refusal as a moved total', async () => {
    complete.service.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'something else',
      correlationId: 'corr-sample',
    });
    expect(await complete.submit(formData(validFor(complete)))).toMatchObject({ kind: 'INVALID' });
    expect(redirect).not.toHaveBeenCalled();
  });
});
