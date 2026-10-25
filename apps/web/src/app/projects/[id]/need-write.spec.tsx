import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  NEED_NOTICES,
  NEED_NOTICE_TEXT,
  NEED_422_PATTERNS,
  NEED_BUSINESS_RULE_MESSAGE,
  NEED_EXPIRED_MESSAGE,
  NEED_FAILED_MESSAGE,
  NEED_FORBIDDEN_MESSAGE,
  NEED_HELD_IN_PROGRESS_MESSAGE,
  NEED_HELD_MESSAGE,
  NEED_KEY_REUSED_MESSAGE,
  NEED_LIST_UNREAD_MESSAGE,
  NEED_NOT_FOUND_MESSAGE,
  NEED_PENDING_CAPACITY_MESSAGE,
  NEED_PENDING_UNCHECKED_MESSAGE,
  NEED_PROJECT_LOCKED_MESSAGE,
  NEED_RELEASE_STALE_MESSAGE,
  NEED_STATE_MESSAGE,
  NEED_STILL_PROCESSING_MESSAGE,
  NEED_UNAVAILABLE_MESSAGE,
  NEED_UNRESOLVED_TEXT,
  NEED_COMMAND_CONSEQUENCES,
  NEED_COMMAND_LABELS,
  NEED_NOTHING_CHANGED_MESSAGE,
  QUANTITY_MESSAGE,
  type NeedFormValues,
} from '@/lib/project-need-commands';
import { STALE_MESSAGE } from '@/lib/project-commands';
import type { ProjectNeed, ProjectNeedPage, ReadResult } from '@/server/projects';
import type { UnresolvedRequest } from '@/server/unresolved-request';

import { NeedsSection, type AddNeedSlot, type NeedTokens } from './NeedsSection';
import {
  AddNeedForm,
  EditNeedForm,
  SubmitNeedForm,
  WithdrawNeedForm,
  type NeedFormIdentity,
} from './NeedForms';
import type { AddNeedFormState } from './need-form-state';
import type { ProjectFormState } from './project-form-state';
import { UnresolvedNeedNotice } from './UnresolvedNeedNotice';

/**
 * The need screens with the real `useActionState`: only the server actions are
 * scripted. Every command's form in every state its action can answer, the list in
 * every state the read can come back in, the commands drawn from the tokens the
 * page was given, and `jest-axe` over all of it.
 */

// axe over whole forms is slow on a loaded runner; the tender specs ask for the same.
jest.setTimeout(20_000);

const act_ = jest.fn<
  Promise<ProjectFormState<unknown, string> | AddNeedFormState>,
  [string, FormData]
>();
jest.mock('./need-actions', () => {
  const named =
    (name: string) =>
    (...args: unknown[]) =>
      act_(name, args[args.length - 1] as FormData);
  return {
    submitAddNeed: named('add'),
    submitEditNeed: named('edit'),
    submitSubmitNeed: named('submit'),
    submitWithdrawNeed: named('withdraw'),
    releaseUnresolvedNeed: () => undefined,
  };
});
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const BASELINE = 'signed-baseline-token';
const PROJECT_ID = 'PRJ_01J00000000000000000000000';
const NEED_ID = 'NED_01J00000000000000000000000';
const IDENTITY: NeedFormIdentity = {
  projectId: PROJECT_ID,
  needId: NEED_ID,
  csrfToken: CSRF,
  submissionId: SUBMISSION,
  baseline: BASELINE,
};
const ADD_SUBMISSION = { id: SUBMISSION, replay: 'replay-token' };
const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

const INITIAL: NeedFormValues = {
  title: 'بتن آماده',
  description: 'بتن با مقاومت بالا',
  quantity: '25',
  unit: 'متر مکعب',
  estimatedCost: '1500000',
};

async function send(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLElement);
  });
}

const field = (container: HTMLElement, name: string) =>
  container.querySelector(`[name="${name}"]`) as HTMLInputElement;

beforeEach(() => act_.mockReset());

/** Built from code points so this file carries none: hamza, its carriers, and the combining hamza. */
const HAMZA = new RegExp(
  `[${[0x0621, 0x0623, 0x0624, 0x0625, 0x0626, 0x0654].map((c) => String.fromCodePoint(c)).join('')}]`,
  'u',
);

const FORMS = [
  {
    name: 'add',
    render: () =>
      render(<AddNeedForm projectId={PROJECT_ID} csrfToken={CSRF} submission={ADD_SUBMISSION} />),
    named: false,
    values: { title: '', description: '', quantity: '', unit: '', estimatedCost: '' },
  },
  {
    name: 'edit',
    render: () =>
      render(<EditNeedForm {...IDENTITY} needTitle="بتن آماده" initialValues={INITIAL} />),
    named: true,
    values: INITIAL,
  },
  {
    name: 'submit',
    render: () => render(<SubmitNeedForm {...IDENTITY} needTitle="بتن آماده" />),
    named: true,
    values: {},
  },
  {
    name: 'withdraw',
    render: () => render(<WithdrawNeedForm {...IDENTITY} needTitle="بتن آماده" />),
    named: true,
    values: { reason: '' },
  },
] as const;

describe.each(FORMS)('the $name form', (form) => {
  it('carries the CSRF token and the submission id, and names no project, need, version or organization', () => {
    const { container } = form.render();
    expect(field(container, CSRF_FIELD)).toHaveValue(CSRF);
    expect(field(container, SUBMISSION_FIELD)).toHaveValue(SUBMISSION);
    if (form.named) {
      expect(field(container, BASELINE_FIELD)).toHaveValue(BASELINE);
      expect(field(container, BASELINE_FIELD)).toHaveAttribute('type', 'hidden');
      expect(container.querySelector(`[name="${REPLAY_FIELD}"]`)).toBeNull();
    } else {
      expect(container.querySelector(`[name="${BASELINE_FIELD}"]`)).toBeNull();
      expect(field(container, REPLAY_FIELD)).toHaveValue('replay-token');
    }
    for (const name of [
      'projectId',
      'needId',
      'organizationId',
      'expectedVersion',
      'version',
      'id',
      'status',
    ]) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
  });

  it('is a plain form post to a server action, with no physical-direction utility', () => {
    const { container } = form.render();
    expect(container.querySelector('form')?.getAttribute('action')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
  });

  it('has no axe violations idle', async () => {
    const { container } = form.render();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, /نشست شما پایان یافته/],
    [{ kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' } as const, /همین حالا در دسترس نیست/],
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, /معتبر شناخته نشد/],
    [{ kind: 'REFUSED', reason: 'SUBMISSION' } as const, /معتبر شناخته نشد/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
    [{ kind: 'NOT_FOUND', correlationId: 'corr-404' } as const, /corr-404/],
    [{ kind: 'FAILED', status: 503, correlationId: 'corr-503' } as const, /پاسخ نمی‌دهد/],
    [{ kind: 'FAILED', status: 500, correlationId: 'corr-500' } as const, /چیزی تغییر نکرد/],
    [{ kind: 'FAILED', status: 401, correlationId: 'corr-401' } as const, /نشست شما پایان/],
    [{ kind: 'UNCONFIRMED', correlationId: 'corr-unk' } as const, /corr-unk/],
  ])('says %j in Persian, as an alert with no axe violation', async (state, expected) => {
    act_.mockResolvedValueOnce(state);
    const { container } = form.render();
    await send(container);
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(await axe(container)).toHaveNoViolations();
  });

  // The rule for new text on these screens (no hamza, no combining hamza) covers
  // what they render from shared modules too, not only their own source files.
  it.each([
    { kind: 'REFUSED', reason: 'NO_SESSION' } as const,
    { kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' } as const,
    { kind: 'REFUSED', reason: 'CSRF' } as const,
    { kind: 'REFUSED', reason: 'BASELINE' } as const,
    { kind: 'FORBIDDEN', correlationId: 'c' } as const,
    { kind: 'NOT_FOUND', correlationId: 'c' } as const,
    { kind: 'FAILED', status: 503, correlationId: 'c' } as const,
    { kind: 'FAILED', status: 429, correlationId: 'c' } as const,
    { kind: 'UNCONFIRMED', correlationId: 'c' } as const,
  ])('renders %j without a hamza', async (state) => {
    act_.mockResolvedValueOnce(state);
    const { container } = form.render();
    await send(container);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(HAMZA);
  });

  it('says a refusal the service put on no field in a message, with no axe violation', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      replay: 'replay-token',
      values: form.values,
      fieldErrors: {},
      message: 'جمله ثابت',
    }));
    const { container } = form.render();
    await send(container);
    expect(await screen.findByRole('alert')).toHaveTextContent('جمله ثابت');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the submission id of a refused form for the corrected one', async () => {
    act_.mockResolvedValueOnce({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      replay: 'replay-token',
      values: form.values,
      fieldErrors: {},
      message: 'جمله ثابت',
    });
    const { container } = form.render();
    await send(container);
    await screen.findByRole('alert');
    expect(field(container, SUBMISSION_FIELD)).toHaveValue('sub_BBBBBBBBBBBBBBBBBBBB');
  });

  it('disables its button while the attempt is in flight', async () => {
    let release: (state: ProjectFormState<unknown, string>) => void = () => undefined;
    act_.mockImplementationOnce(
      () => new Promise<ProjectFormState<unknown, string>>((resolve) => (release = resolve)),
    );
    const { container } = form.render();
    const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await send(container);
    expect(button).toBeDisabled();
    await act(async () => release({ kind: 'FAILED', status: 500, correlationId: 'c' }));
    expect(button).not.toBeDisabled();
  });
});

describe('the field messages', () => {
  it('shows each field’s message beside the field and keeps what was typed (add)', async () => {
    act_.mockResolvedValueOnce({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      replay: 'replay-token',
      values: { ...INITIAL, quantity: '1,000' },
      fieldErrors: { title: 'عنوان کوتاه است', quantity: QUANTITY_MESSAGE },
      message: null,
    });
    const { container } = render(
      <AddNeedForm projectId={PROJECT_ID} csrfToken={CSRF} submission={ADD_SUBMISSION} />,
    );
    await send(container);
    expect(await screen.findByText('عنوان کوتاه است')).toBeInTheDocument();
    expect(screen.getByText(QUANTITY_MESSAGE)).toBeInTheDocument();
    expect(field(container, 'quantity')).toHaveValue('1,000');
    expect(field(container, 'unit')).toHaveValue('متر مکعب');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('opens the edit and withdraw disclosures again when an attempt came back with something to read', async () => {
    act_.mockResolvedValueOnce({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: INITIAL,
      fieldErrors: { title: NEED_NOTHING_CHANGED_MESSAGE },
      message: null,
    });
    const { container } = render(
      <EditNeedForm {...IDENTITY} needTitle="بتن آماده" initialValues={INITIAL} />,
    );
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
    await send(container);
    await screen.findByText(NEED_NOTHING_CHANGED_MESSAGE);
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(true);
  });

  it('draws the edit form from the record, with the optional fields empty when the record has none', () => {
    const { container } = render(
      <EditNeedForm
        {...IDENTITY}
        needTitle="بتن آماده"
        initialValues={{ ...INITIAL, quantity: '', unit: '', estimatedCost: '' }}
      />,
    );
    expect(field(container, 'title')).toHaveValue('بتن آماده');
    expect(field(container, 'quantity')).toHaveValue('');
    expect(field(container, 'unit')).toHaveValue('');
  });
});

describe('the add form’s own states', () => {
  const values = INITIAL;
  const cases: readonly [string, AddNeedFormState, string, boolean][] = [
    [
      'still processing at the service',
      { kind: 'PROCESSING', correlationId: 'corr-p' },
      NEED_STILL_PROCESSING_MESSAGE,
      true,
    ],
    ['left open too long', { kind: 'EXPIRED', values }, NEED_EXPIRED_MESSAGE, true],
    [
      'held: another request of this form is in flight',
      { kind: 'HELD', reason: 'IN_PROGRESS', values },
      NEED_HELD_IN_PROGRESS_MESSAGE,
      false,
    ],
    [
      'held: an earlier add is unresolved',
      { kind: 'HELD', reason: 'OTHER_REQUEST', values },
      NEED_HELD_MESSAGE,
      false,
    ],
    [
      'the store could not be checked',
      { kind: 'NOT_CHECKED', values },
      NEED_PENDING_UNCHECKED_MESSAGE,
      false,
    ],
    [
      'the login is at capacity',
      { kind: 'CAPACITY', values },
      NEED_PENDING_CAPACITY_MESSAGE,
      false,
    ],
  ];

  it.each(cases)(
    '%s: says so in fixed words, keeps the values, no hamza, no axe violation',
    async (_name, state, message) => {
      act_.mockResolvedValueOnce(state);
      const { container } = render(
        <AddNeedForm projectId={PROJECT_ID} csrfToken={CSRF} submission={ADD_SUBMISSION} />,
      );
      await send(container);
      const alert = await screen.findByRole(state.kind === 'PROCESSING' ? 'status' : 'alert');
      expect(alert).toHaveTextContent(message.slice(0, 40));
      expect(alert.textContent).not.toMatch(HAMZA);
      if ('values' in state) expect(field(container, 'title')).toHaveValue(values.title);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it.each(cases)(
    '%s: the button is disabled only when pressing again could not help',
    async (_name, state, _message, disabled) => {
      act_.mockResolvedValueOnce(state);
      const { container } = render(
        <AddNeedForm projectId={PROJECT_ID} csrfToken={CSRF} submission={ADD_SUBMISSION} />,
      );
      await send(container);
      await screen.findByRole(state.kind === 'PROCESSING' ? 'status' : 'alert');
      expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
        disabled,
      );
    },
  );

  it('an unconfirmed add disables the button: the request is held and is not sent again', async () => {
    act_.mockResolvedValueOnce({ kind: 'UNCONFIRMED', correlationId: 'corr-u' });
    const { container } = render(
      <AddNeedForm projectId={PROJECT_ID} csrfToken={CSRF} submission={ADD_SUBMISSION} />,
    );
    await send(container);
    await screen.findByRole('alert');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// The list and what it draws
// ---------------------------------------------------------------------------

const NEED = (over: Partial<ProjectNeed> = {}): ProjectNeed => ({
  id: 'NED_1',
  projectId: PROJECT_ID,
  title: 'بتن آماده',
  description: 'بتن با مقاومت بالا',
  quantity: '25.5',
  unit: 'متر مکعب',
  estimatedCostMinor: '1500000',
  status: 'DRAFT',
  createdAt: '2026-10-20T08:00:00.000Z',
  submittedAt: null,
  withdrawnAt: null,
  withdrawalReason: null,
  version: 1,
  ...over,
});

const PAGE = (
  items: ProjectNeed[],
  over: Partial<ProjectNeedPage> = {},
): ReadResult<ProjectNeedPage> => ({
  kind: 'OK',
  data: { items, nextCursor: null, hasMore: false, ...over },
});

const ALL_COMMANDS = (id: string) => ({
  edit: { submissionId: `${SUBMISSION}-${id}-e`, baseline: `b-${id}-e` },
  submit: { submissionId: `${SUBMISSION}-${id}-s`, baseline: `b-${id}-s` },
  withdraw: { submissionId: `${SUBMISSION}-${id}-w`, baseline: `b-${id}-w` },
});

const REQUEST: UnresolvedRequest = {
  id: 'a'.repeat(32),
  key: SUBMISSION,
  digest: 'digest',
  deadline: null,
  ref: 'replay-token',
  inFlight: false,
};

function section(props: Partial<React.ComponentProps<typeof NeedsSection>> = {}) {
  const needs = [
    NEED({ id: 'NED_1' }),
    NEED({
      id: 'NED_2',
      title: 'میلگرد',
      status: 'SUBMITTED',
      version: 2,
      submittedAt: '2026-10-21T08:00:00.000Z',
    }),
    NEED({
      id: 'NED_3',
      title: 'قالب',
      status: 'WITHDRAWN',
      version: 3,
      withdrawnAt: '2026-10-22T08:00:00.000Z',
      withdrawalReason: 'دیگر لازم نیست',
    }),
  ];
  const tokens: NeedTokens = {
    NED_1: ALL_COMMANDS('1'),
    NED_2: { withdraw: ALL_COMMANDS('2').withdraw },
    NED_3: {},
  };
  const editValues = Object.fromEntries(
    needs.map((need) => [need.id, { ...INITIAL, title: need.title }]),
  );
  return render(
    <NeedsSection
      projectId={PROJECT_ID}
      csrfToken={CSRF}
      result={PAGE(needs)}
      cursor={null}
      tokens={tokens}
      editValues={editValues}
      add={{ kind: 'FORM', submission: ADD_SUBMISSION }}
      releaseRefused={null}
      {...props}
    />,
  );
}

describe('the list', () => {
  it('draws, for each need, exactly the commands it was given a token for', () => {
    section();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const [draft, sent, withdrawn] = items as [HTMLElement, HTMLElement, HTMLElement];

    expect(draft.querySelectorAll('details')).toHaveLength(2);
    expect(draft.textContent).toContain('ارسال «بتن آماده»');
    expect(sent.querySelectorAll('details')).toHaveLength(1);
    expect(sent.textContent).toContain('پس‌گرفتن «میلگرد»');
    expect(sent.textContent).not.toContain('ارسال «میلگرد»');
    expect(withdrawn.querySelectorAll('form')).toHaveLength(0);
    expect(withdrawn.textContent).toContain('دلیل: دیگر لازم نیست');
  });

  it('draws a need’s status in words, its quantity with its unit and its estimate', () => {
    section();
    expect(screen.getByText('پیش‌نویس', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('ارسال‌شده', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('پس‌گرفته', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getAllByText(/۲۵٫۵ متر مکعب/)).toHaveLength(3);
  });

  it('draws no command for a need given no token, whatever its status', () => {
    section({ tokens: {} });
    expect(document.querySelectorAll('form').length).toBe(1); // only the add form
    expect(document.querySelectorAll('details')).toHaveLength(0);
  });

  it('says an empty project, and a page past the end, in different words', () => {
    section({ result: PAGE([]) });
    expect(screen.getByText('نیازی ثبت نشده')).toBeInTheDocument();
    section({ result: PAGE([]), cursor: 'CUR_1' });
    expect(screen.getByText('نیاز دیگری نیست')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'بازگشت به نخستین نیازها' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}`,
    );
  });

  it('links the next page by its cursor, and says when more exist that cannot be followed', () => {
    section({ result: PAGE([NEED()], { hasMore: true, nextCursor: 'CUR/2' }) });
    expect(screen.getByRole('link', { name: 'نیازهای بعدی' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}?needs=CUR%2F2`,
    );
    section({ result: PAGE([NEED()], { hasMore: true, nextCursor: null }) });
    expect(screen.getByText('نیازهای بیشتری هست که از اینجا دیده نمی‌شود.')).toBeInTheDocument();
  });

  it.each([
    ['FORBIDDEN', { kind: 'FORBIDDEN' } as const, 'نیازهای این پروژه در اختیار شما نیست.'],
    ['NOT_FOUND', { kind: 'NOT_FOUND' } as const, 'نیازها پیدا نشد'],
    [
      'UNAVAILABLE',
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-r1' } as const,
      'نیازهای پروژه خوانده نشد',
    ],
    [
      'MALFORMED',
      { kind: 'MALFORMED', correlationId: 'corr-r2' } as const,
      'نیازهای پروژه خوانده نشد',
    ],
  ])('%s is said as itself and draws no command beside it', (_name, result, text) => {
    section({ result, add: { kind: 'LIST_UNREAD' } });
    expect(screen.getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('form')).toHaveLength(0);
    expect(screen.queryByText('نیازی ثبت نشده')).toBeNull();
  });

  it('a service that did not answer carries its trace code', () => {
    section({
      result: { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-r1' },
      add: { kind: 'LIST_UNREAD' },
    });
    expect(screen.getByText(/corr-r1/)).toBeInTheDocument();
    expect(screen.getByText(NEED_LIST_UNREAD_MESSAGE)).toBeInTheDocument();
  });
});

describe('under the list', () => {
  it('draws the add form for a submission minted now', () => {
    const { container } = section();
    expect(field(container, REPLAY_FIELD)).toHaveValue('replay-token');
    expect(screen.getByRole('heading', { name: NEED_COMMAND_LABELS.add })).toBeInTheDocument();
  });

  const slots: readonly [string, AddNeedSlot, RegExp][] = [
    [
      'unresolved',
      { kind: 'PENDING', request: REQUEST, releaseToken: 'release-token' },
      new RegExp(NEED_UNRESOLVED_TEXT.slice(0, 30)),
    ],
    [
      'store unreadable',
      { kind: 'UNCHECKED' },
      new RegExp(NEED_PENDING_UNCHECKED_MESSAGE.slice(0, 30)),
    ],
    ['list unreadable', { kind: 'LIST_UNREAD' }, new RegExp(NEED_LIST_UNREAD_MESSAGE.slice(0, 30))],
    ['no role', { kind: 'NOT_OFFERED', reason: 'ROLE' }, /نقش شما اجازه تغییر پروژه ندارد/],
    ['project status', { kind: 'NOT_OFFERED', reason: 'STATUS' }, /پیش‌نویس یا نیازمند اصلاح/],
  ];

  it.each(slots)('%s: draws no add form, and says why', (_name, add, text) => {
    const { container } = section({ add });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector(`[name="${REPLAY_FIELD}"]`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'افزودن نیاز' })).toBeNull();
  });

  it('an unresolved add carries the release form with the confirmation, and says it is not sent again', () => {
    const { container } = section({
      add: {
        kind: 'PENDING',
        request: { ...REQUEST, inFlight: true },
        releaseToken: 'release-token',
      },
    });
    expect(screen.getByText(/دوباره فرستاده نمی‌شود/)).toBeInTheDocument();
    expect(screen.getByText(NEED_HELD_IN_PROGRESS_MESSAGE)).toBeInTheDocument();
    expect(field(container, 'release')).toHaveValue('release-token');
    const tick = screen.getByRole('checkbox');
    expect(tick).toBeRequired();
    expect(
      screen.getByRole('button', { name: 'رها کردن و افزودن درخواست تازه' }),
    ).toBeInTheDocument();
  });

  it.each([
    ['STALE', NEED_RELEASE_STALE_MESSAGE],
    ['IN_PROGRESS', NEED_HELD_IN_PROGRESS_MESSAGE],
  ] as const)('a release that did nothing (%s) is said', (releaseRefused, text) => {
    section({ releaseRefused });
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('the unresolved notice on its own', () => {
  it('has no axe violation, in flight or not', async () => {
    for (const inFlight of [false, true]) {
      const { container, unmount } = render(
        <UnresolvedNeedNotice
          projectId={PROJECT_ID}
          request={{ ...REQUEST, inFlight }}
          csrfToken={CSRF}
          releaseToken="release-token"
        />,
      );
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe('the whole section', () => {
  const states: readonly [string, () => ReturnType<typeof section>][] = [
    ['with needs in every status', () => section()],
    ['empty', () => section({ result: PAGE([]) })],
    [
      'unavailable',
      () =>
        section({
          result: { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
          add: { kind: 'LIST_UNREAD' },
        }),
    ],
    [
      'forbidden',
      () =>
        section({ result: { kind: 'FORBIDDEN' }, add: { kind: 'NOT_OFFERED', reason: 'ROLE' } }),
    ],
    [
      'unresolved',
      () => section({ add: { kind: 'PENDING', request: REQUEST, releaseToken: 'r' } }),
    ],
    ['a reader', () => section({ tokens: {}, add: { kind: 'NOT_OFFERED', reason: 'ROLE' } })],
    [
      'more pages',
      () => section({ result: PAGE([NEED()], { hasMore: true, nextCursor: 'CUR_2' }) }),
    ],
  ];

  it.each(states)(
    '%s: has no axe violation, no physical-direction utility and no hamza',
    async (_name, draw) => {
      const { container } = draw();
      expect(await axe(container)).toHaveNoViolations();
      expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
      // Open every disclosure: the forms inside are on the page for axe as well.
      container.querySelectorAll('details').forEach((details) => details.setAttribute('open', ''));
      expect(await axe(container)).toHaveNoViolations();
      const own = (container.textContent ?? '').replace(/[«»]/g, '');
      expect(own).not.toMatch(HAMZA);
    },
  );
});

describe('the fixed words', () => {
  const ALL_TEXT = [
    ...Object.values(NEED_COMMAND_CONSEQUENCES),
    ...Object.values(NEED_COMMAND_LABELS),
    ...NEED_NOTICES.map((notice) => NEED_NOTICE_TEXT[notice].text),
    ...NEED_422_PATTERNS.map(([, text]) => text),
    NEED_BUSINESS_RULE_MESSAGE,
    NEED_EXPIRED_MESSAGE,
    NEED_FAILED_MESSAGE,
    NEED_FORBIDDEN_MESSAGE,
    NEED_HELD_IN_PROGRESS_MESSAGE,
    NEED_HELD_MESSAGE,
    NEED_KEY_REUSED_MESSAGE,
    NEED_LIST_UNREAD_MESSAGE,
    NEED_NOT_FOUND_MESSAGE,
    NEED_NOTHING_CHANGED_MESSAGE,
    NEED_PENDING_CAPACITY_MESSAGE,
    NEED_PENDING_UNCHECKED_MESSAGE,
    NEED_PROJECT_LOCKED_MESSAGE,
    NEED_RELEASE_STALE_MESSAGE,
    NEED_STATE_MESSAGE,
    NEED_STILL_PROCESSING_MESSAGE,
    NEED_UNAVAILABLE_MESSAGE,
    NEED_UNRESOLVED_TEXT,
    QUANTITY_MESSAGE,
    STALE_MESSAGE,
  ];

  it('carry no hamza, no combining hamza and no confusable decimal mark typed as a letter', () => {
    for (const text of ALL_TEXT) expect(text).not.toMatch(HAMZA);
  });

  it('are all non-empty, distinct from the service’s own English', () => {
    for (const text of ALL_TEXT) {
      expect(text.trim().length).toBeGreaterThan(3);
      expect(text).not.toMatch(/[A-Za-z]{6,}/);
    }
  });
});
