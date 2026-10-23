import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  PROJECT_NOTICES,
  PROJECT_NOTICE_TEXT,
  POLICY_CLOSED_TITLE,
  type ProjectNotice,
} from '@/lib/project-commands';
import type {
  ApprovalInbox as Inbox,
  ExecutionPolicy,
  ProjectApproval,
  ProjectDetail,
} from '@/server/projects';
import type { ReadResult } from '@/server/projects';

import { ApprovalInbox } from './ApprovalInbox';
import { CreateProjectForm } from './CreateProjectForm';
import { ProjectApprovals } from './[id]/ProjectApprovals';
import { PolicyState, ProjectCommands } from './[id]/ProjectCommands';
import { ProjectDetailScreen } from './[id]/ProjectDetailScreen';
import {
  CancelProjectForm,
  CompleteProjectForm,
  EditProjectForm,
  GrantApprovalForm,
  RejectApprovalForm,
  RequestApprovalForm,
  StartProjectForm,
} from './[id]/ProjectForms';
import type { ProjectFormState } from './[id]/project-form-state';
import type { CreateProjectFormState } from './form-state';

/**
 * The project write screens with the real `useActionState`: only the server
 * actions are scripted. Every command's form in every state its action can
 * answer, the drawing of the commands from the record, the closed-system state,
 * the approval rounds and the authority's inbox, and `jest-axe` over all of it.
 */

// axe over whole forms is slow on a loaded runner; the tender specs ask for the same.
jest.setTimeout(20_000);

const act_ = jest.fn<
  Promise<ProjectFormState<unknown, string> | CreateProjectFormState>,
  [string, FormData]
>();
jest.mock('./[id]/project-actions', () => {
  const named =
    (name: string) =>
    (...args: unknown[]) =>
      act_(name, args[args.length - 1] as FormData);
  return {
    submitEditProject: named('edit'),
    submitRequestApproval: named('request'),
    submitStartProject: named('start'),
    submitCompleteProject: named('complete'),
    submitCancelProject: named('cancel'),
    submitGrantApproval: named('grant'),
    submitRejectApproval: named('reject'),
  };
});
jest.mock('./actions', () => ({
  submitCreateProject: (...args: unknown[]) => act_('create', args[args.length - 1] as FormData),
}));
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
const CREATE_SUBMISSION = { id: SUBMISSION, replay: 'replay-token' };
const BASELINE = 'signed-baseline-token';
const PROJECT_ID = 'PRJ_01J00000000000000000000000';
const IDENTITY = {
  targetId: PROJECT_ID,
  place: 'project' as const,
  csrfToken: CSRF,
  submissionId: SUBMISSION,
  baseline: BASELINE,
};
const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

const INITIAL = {
  title: 'بازسازی پل',
  operationType: 'خاکبرداری',
  locationDescription: 'کیلومتر ۱۲ جاده',
  scopeOfWork: 'شرح کار پروژه',
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
    name: 'create',
    render: () => render(<CreateProjectForm csrfToken={CSRF} submission={CREATE_SUBMISSION} />),
    named: false,
    values: {
      title: '',
      operationType: '',
      locationDescription: '',
      scopeOfWork: '',
      estimatedCost: '',
    },
  },
  {
    name: 'edit',
    render: () => render(<EditProjectForm {...IDENTITY} initialValues={INITIAL} />),
    named: true,
    values: INITIAL,
  },
  {
    name: 'request approval',
    render: () => render(<RequestApprovalForm {...IDENTITY} />),
    named: true,
    values: {},
  },
  {
    name: 'start',
    render: () => render(<StartProjectForm {...IDENTITY} />),
    named: true,
    values: {},
  },
  {
    name: 'complete',
    render: () => render(<CompleteProjectForm {...IDENTITY} />),
    named: true,
    values: {},
  },
  {
    name: 'cancel',
    render: () => render(<CancelProjectForm {...IDENTITY} projectTitle="بازسازی پل" />),
    named: true,
    values: { reason: '', confirm: '' },
  },
  {
    name: 'grant',
    render: () => render(<GrantApprovalForm {...IDENTITY} targetId="APR_1" />),
    named: true,
    values: { decisionNumber: '', conditions: '' },
  },
  {
    name: 'reject',
    render: () => render(<RejectApprovalForm {...IDENTITY} targetId="APR_1" />),
    named: true,
    values: { reason: '' },
  },
] as const;

describe.each(FORMS)('the $name form', (form) => {
  it('carries the CSRF token and the submission id, and names no project, approval, version or organization', () => {
    const { container } = form.render();
    expect(field(container, CSRF_FIELD)).toHaveValue(CSRF);
    expect(field(container, SUBMISSION_FIELD)).toHaveValue(SUBMISSION);
    if (form.named) {
      expect(field(container, BASELINE_FIELD)).toHaveValue(BASELINE);
      expect(field(container, BASELINE_FIELD)).toHaveAttribute('type', 'hidden');
    } else {
      expect(container.querySelector(`[name="${BASELINE_FIELD}"]`)).toBeNull();
    }
    for (const name of [
      'projectId',
      'approvalId',
      'organizationId',
      'expectedVersion',
      'version',
      'id',
      'status',
      'area',
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
  // what they render from shared modules too, not only their own source files:
  // the unconfirmed alert, the session refusals, the in-progress sentence.
  it.each([
    { kind: 'REFUSED', reason: 'NO_SESSION' } as const,
    { kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' } as const,
    { kind: 'REFUSED', reason: 'CSRF' } as const,
    { kind: 'FORBIDDEN', correlationId: 'c' } as const,
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
    act_.mockImplementationOnce(async () => ({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: form.values,
      fieldErrors: {},
      message: 'x',
    }));
    const { container } = form.render();
    await send(container);
    await screen.findByRole('alert');
    expect(field(container, SUBMISSION_FIELD)).toHaveValue('sub_BBBBBBBBBBBBBBBBBBBB');
  });

  it('disables its button while it is being sent', async () => {
    let release: (state: ProjectFormState<unknown, string>) => void = () => undefined;
    act_.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { container } = form.render();
    await send(container);
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
    await act(async () => release({ kind: 'IDLE' }));
  });
});

describe('a refused form is drawn again as it was typed', () => {
  it('create keeps every typed field, and the corrected post carries them under the same id', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      values: {
        title: String(sent.get('title')),
        operationType: String(sent.get('operationType')),
        locationDescription: String(sent.get('locationDescription')),
        scopeOfWork: String(sent.get('scopeOfWork')),
        estimatedCost: String(sent.get('estimatedCost')),
      },
      fieldErrors: { title: 'عنوان کوتاه است', estimatedCost: 'برآورد نادرست است' },
      message: null,
    }));
    act_.mockResolvedValueOnce({ kind: 'IDLE' });
    const { container } = render(
      <CreateProjectForm csrfToken={CSRF} submission={CREATE_SUBMISSION} />,
    );
    fireEvent.change(field(container, 'title'), { target: { value: 'ا' } });
    fireEvent.change(field(container, 'operationType'), { target: { value: 'خاکبرداری' } });
    fireEvent.change(field(container, 'locationDescription'), { target: { value: 'محل' } });
    fireEvent.change(field(container, 'scopeOfWork'), { target: { value: 'شرح\nدو خط' } });
    fireEvent.change(field(container, 'estimatedCost'), { target: { value: 'abc' } });
    await send(container);
    await screen.findByText('عنوان کوتاه است');

    expect(field(container, 'title')).toHaveValue('ا');
    expect(field(container, 'operationType')).toHaveValue('خاکبرداری');
    expect(field(container, 'scopeOfWork')).toHaveValue('شرح\nدو خط');
    expect(field(container, 'estimatedCost')).toHaveValue('abc');

    fireEvent.change(field(container, 'title'), { target: { value: 'بازسازی پل' } });
    fireEvent.change(field(container, 'estimatedCost'), { target: { value: '1500000' } });
    await send(container);
    const second = act_.mock.calls[1]![1];
    expect(second.get('title')).toBe('بازسازی پل');
    expect(second.get('operationType')).toBe('خاکبرداری');
    expect(second.get('scopeOfWork')).toBe('شرح\nدو خط');
    expect(second.get('estimatedCost')).toBe('1500000');
    expect(second.get(SUBMISSION_FIELD)).toBe(SUBMISSION);
  });

  it('edit starts from the record, keeps what was typed after a refusal, and posts the correction', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      values: {
        title: String(sent.get('title')),
        operationType: String(sent.get('operationType')),
        locationDescription: String(sent.get('locationDescription')),
        scopeOfWork: String(sent.get('scopeOfWork')),
        estimatedCost: String(sent.get('estimatedCost')),
      },
      fieldErrors: { title: 'عنوان کوتاه است' },
      message: null,
    }));
    act_.mockResolvedValueOnce({ kind: 'IDLE' });
    const { container } = render(<EditProjectForm {...IDENTITY} initialValues={INITIAL} />);
    expect(field(container, 'title')).toHaveValue('بازسازی پل');
    expect(field(container, 'estimatedCost')).toHaveValue('1500000');

    fireEvent.change(field(container, 'title'), { target: { value: 'ا' } });
    fireEvent.change(field(container, 'estimatedCost'), { target: { value: '' } });
    await send(container);
    await screen.findByText('عنوان کوتاه است');
    expect(field(container, 'title')).toHaveValue('ا');
    expect(field(container, 'estimatedCost')).toHaveValue('');
    expect(field(container, 'scopeOfWork')).toHaveValue('شرح کار پروژه');

    fireEvent.change(field(container, 'title'), { target: { value: 'عنوان درست' } });
    await send(container);
    const second = act_.mock.calls[1]![1];
    expect(second.get('title')).toBe('عنوان درست');
    expect(second.get('estimatedCost')).toBe('');
    expect(second.get('scopeOfWork')).toBe('شرح کار پروژه');
  });

  it('cancel keeps the reason and the tick, and says which is missing', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      values: { reason: String(sent.get('reason')), confirm: String(sent.get('confirm') ?? '') },
      fieldErrors: { reason: 'دلیل را کامل بنویسید' },
      message: null,
    }));
    const { container } = render(<CancelProjectForm {...IDENTITY} projectTitle="بازسازی پل" />);
    fireEvent.click(screen.getByText('لغو این پروژه…'));
    fireEvent.change(field(container, 'reason'), { target: { value: 'کوتاه' } });
    fireEvent.click(field(container, 'confirm'));
    await send(container);
    await screen.findByText('دلیل را کامل بنویسید');
    expect(field(container, 'reason')).toHaveValue('کوتاه');
    expect(field(container, 'confirm')).toBeChecked();
  });

  it('a decision keeps its typed text', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      values: { reason: String(sent.get('reason')) },
      fieldErrors: { reason: 'دلیل را کامل بنویسید' },
      message: null,
    }));
    const { container } = render(<RejectApprovalForm {...IDENTITY} targetId="APR_1" />);
    fireEvent.change(field(container, 'reason'), { target: { value: 'کوتاه' } });
    await send(container);
    await screen.findByText('دلیل را کامل بنویسید');
    expect(field(container, 'reason')).toHaveValue('کوتاه');
  });
});

describe('the create form left open past the service’s retention', () => {
  it('carries the signed replay deadline', () => {
    const { container } = render(
      <CreateProjectForm csrfToken={CSRF} submission={CREATE_SUBMISSION} />,
    );
    expect(field(container, REPLAY_FIELD)).toHaveValue('replay-token');
  });

  it('tells the person to check the project list first, keeps what was typed, and cannot send', async () => {
    act_.mockResolvedValueOnce({ kind: 'EXPIRED', values: { ...INITIAL } });
    const { container } = render(
      <CreateProjectForm csrfToken={CSRF} submission={CREATE_SUBMISSION} />,
    );
    await send(container);
    expect(await screen.findByText(/فهرست پروژه‌ها را بررسی کنید/)).toBeInTheDocument();
    expect(container.querySelector('input[name="title"]')).toHaveValue('بازسازی پل');
    expect(screen.getByRole('button', { name: 'ثبت پروژه' })).toBeDisabled();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the create form while a request is in flight', () => {
  const values = { ...INITIAL };

  it('locks the fields and keeps the values, then offers the same id again after the wait', async () => {
    jest.useFakeTimers();
    try {
      act_.mockResolvedValueOnce({
        kind: 'IN_PROGRESS',
        submissionId: SUBMISSION,
        replay: 'replay-token',
        values,
        retryAfterSeconds: 1,
        correlationId: 'corr-wait',
      });
      const { container } = render(
        <CreateProjectForm csrfToken={CSRF} submission={CREATE_SUBMISSION} />,
      );
      await send(container);
      expect(await screen.findByRole('status')).toHaveTextContent('corr-wait');
      const title = container.querySelector('input[name="title"]:not([type="hidden"])');
      expect(title).toBeDisabled();
      expect(title).toHaveValue('بازسازی پل');
      // The values travel as hidden fields, exactly as sent.
      const hidden = [...container.querySelectorAll('input[type="hidden"]')].map(
        (input) => (input as HTMLInputElement).name,
      );
      expect(hidden).toEqual(expect.arrayContaining(['title', 'scopeOfWork', 'estimatedCost']));
      const buttons = container.querySelectorAll('button[type="submit"]');
      expect(buttons[0]).toBeDisabled();

      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
      expect(container.querySelector('button[type="submit"]')).not.toBeDisabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('says nothing was sent when an unresolved earlier request holds the form', async () => {
    act_.mockResolvedValueOnce({ kind: 'HELD', reason: 'OTHER_REQUEST', values });
    const { container } = render(
      <CreateProjectForm csrfToken={CSRF} submission={CREATE_SUBMISSION} />,
    );
    await send(container);
    expect(await screen.findByText(/هنوز روشن نشده است/)).toBeInTheDocument();
    expect(container.querySelector('input[name="title"]')).toHaveValue('بازسازی پل');
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// The page's pieces
// ---------------------------------------------------------------------------

const TOKEN = { submissionId: SUBMISSION, baseline: BASELINE };
const tokensFor = (...commands: string[]) =>
  Object.fromEntries(commands.map((command) => [command, TOKEN]));

describe('the commands a project is drawn with', () => {
  const draw = (...commands: string[]) =>
    render(
      <ProjectCommands
        projectId={PROJECT_ID}
        projectTitle="بازسازی پل"
        csrfToken={CSRF}
        tokens={tokensFor(...commands)}
        initialValues={INITIAL}
      />,
    );

  it('draws exactly the commands it was given a token for', () => {
    draw('edit', 'requestApproval', 'cancel');
    expect(screen.getByRole('heading', { name: 'ویرایش مشخصات' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'درخواست موافقت' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'لغو پروژه' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'شروع اجرا' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'تکمیل پروژه' })).toBeNull();
  });

  it.each([
    [['start', 'cancel'], 'شروع اجرا'],
    [['complete'], 'تکمیل پروژه'],
  ])('draws %j', async (commands, heading) => {
    const { container } = draw(...commands);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws nothing when it was given nothing', () => {
    const { container } = draw();
    expect(container.querySelectorAll('form')).toHaveLength(0);
  });

  it('draws every command with no axe violation together', async () => {
    const { container } = draw('edit', 'requestApproval', 'start', 'complete', 'cancel');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the approval policy, as the page states it', () => {
  const ok = (data: ExecutionPolicy): ReadResult<ExecutionPolicy> => ({ kind: 'OK', data });

  it('says the system is closed when no policy is active, and says who does what about it', async () => {
    const { container } = render(<PolicyState policy={ok({ kind: 'CLOSED' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(POLICY_CLOSED_TITLE);
    expect(container).toHaveTextContent('هیچ پروژه‌ای به مرحله تایید نمی‌رسد');
    expect(container).toHaveTextContent('مدیر پلتفرم فعال می‌کند');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('names the active policy and its steps in order', async () => {
    const { container } = render(
      <PolicyState
        policy={ok({
          kind: 'OPEN',
          label: 'سیاست شورا',
          isSample: true,
          steps: [
            { approvalType: 'تایید فنی', authorityLabel: 'شورای شهر' },
            { approvalType: 'تایید مالی', authorityLabel: 'استانداری' },
          ],
        })}
      />,
    );
    expect(container).toHaveTextContent('سیاست شورا');
    expect(container).toHaveTextContent('(نمونه)');
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('تایید فنی');
    expect(items[1]).toHaveTextContent('استانداری');
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [{ kind: 'OK', data: { kind: 'UNKNOWN' } } as const],
    [{ kind: 'FORBIDDEN' } as const],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'c' } as const],
    [{ kind: 'MALFORMED', correlationId: 'c' } as const],
    [{ kind: 'NOT_FOUND' } as const],
  ])('does not say closed when the policy could not be read (%j)', (policy) => {
    const { container } = render(<PolicyState policy={policy} />);
    expect(container).not.toHaveTextContent(POLICY_CLOSED_TITLE);
    expect(container).toHaveTextContent('نمی‌توانیم بگوییم سامانه باز است یا بسته');
  });
});

const STEP = (over: Partial<ProjectApproval> = {}): ProjectApproval => ({
  id: 'APR_1',
  projectId: PROJECT_ID,
  workflowKey: 'project.execution',
  round: 1,
  stepOrder: 1,
  approvalType: 'تایید فنی',
  authorityOrganizationId: 'ORG-COUNCIL',
  authorityRole: 'UNION_ADMIN',
  authorityLabel: 'شورای شهر',
  status: 'PENDING',
  requestedAt: '2026-10-20T08:00:00.000Z',
  decidedAt: null,
  decisionNumber: null,
  conditions: null,
  reason: null,
  version: 2,
  ...over,
});

describe('the approval rounds', () => {
  const draw = (result: ReadResult<ProjectApproval[]>, decisions = {}) =>
    render(<ProjectApprovals result={result} csrfToken={CSRF} decisions={decisions} />);

  it('says nothing was asked yet', async () => {
    const { container } = draw({ kind: 'OK', data: [] });
    expect(container).toHaveTextContent('هنوز موافقتی خواسته نشده');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows rounds newest first and steps in order, with what was decided and why', async () => {
    const { container } = draw({
      kind: 'OK',
      data: [
        STEP({
          id: 'A1',
          round: 1,
          stepOrder: 1,
          status: 'GRANTED',
          decisionNumber: '۱۲۳',
          conditions: 'با رعایت حریم',
          decidedAt: '2026-10-21T08:00:00.000Z',
        }),
        STEP({
          id: 'A2',
          round: 1,
          stepOrder: 2,
          status: 'REJECTED',
          reason: 'برآورد نادرست است',
          approvalType: 'تایید مالی',
        }),
        STEP({ id: 'B1', round: 2, stepOrder: 1, status: 'PENDING' }),
      ],
    });
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['اجرای پروژه، دور ۲', 'اجرای پروژه، دور ۱']);
    expect(container).toHaveTextContent('شماره تصمیم: ۱۲۳');
    expect(container).toHaveTextContent('شرایط: با رعایت حریم');
    expect(container).toHaveTextContent('دلیل رد: برآورد نادرست است');
    expect(container).toHaveTextContent('منتظر تصمیم');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws the decision forms on the step it was given tokens for, and on no other', async () => {
    const { container } = draw(
      {
        kind: 'OK',
        data: [STEP({ id: 'APR_1' }), STEP({ id: 'APR_2', stepOrder: 2, status: 'QUEUED' })],
      },
      { APR_1: { grant: TOKEN, reject: TOKEN } },
    );
    expect(container.querySelectorAll('form')).toHaveLength(2);
    expect(container).toHaveTextContent('این مرحله به نام شما و منتظر تصمیم شماست');
    expect(screen.getByRole('button', { name: 'ثبت موافقت' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ثبت رد' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws no decision form without tokens, whatever the step says', () => {
    const { container } = draw({ kind: 'OK', data: [STEP()] });
    expect(container.querySelectorAll('form')).toHaveLength(0);
  });

  it.each([
    [{ kind: 'FORBIDDEN' } as const, 'در اختیار شما نیست'],
    [{ kind: 'NOT_FOUND' } as const, 'پیدا نشد'],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-x' } as const, 'corr-x'],
    [{ kind: 'MALFORMED', correlationId: 'corr-y' } as const, 'corr-y'],
  ])('says %j', async (result, expected) => {
    const { container } = draw(result);
    expect(container).toHaveTextContent(expected);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the authority’s inbox', () => {
  const ok = (items: ProjectApproval[], hasMore = false): ReadResult<Inbox> => ({
    kind: 'OK',
    data: { items, nextCursor: null, hasMore },
  });
  const draw = (result: ReadResult<Inbox>, decisions = {}) =>
    render(<ApprovalInbox result={result} csrfToken={CSRF} decisions={decisions} />);

  it('says nothing waits, and that this is not a decision', async () => {
    const { container } = draw(ok([]));
    expect(container).toHaveTextContent('تصمیمی منتظر شما نیست');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('does not say nothing waits when only other workflows were read and the service has more', async () => {
    const { container } = draw(ok([], true));
    expect(container).not.toHaveTextContent('تصمیمی منتظر شما نیست');
    expect(container).toHaveTextContent('خوانده نشد');
    expect(container.textContent).not.toMatch(HAMZA);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('names the project of each step, with its estimate, and the decision forms for the steps it was given tokens for', async () => {
    const { container } = draw(
      ok(
        [
          STEP({ id: 'APR_1', project: { title: 'پل شمالی', estimatedCostMinor: '1500000' } }),
          STEP({ id: 'APR_2', project: { title: 'جاده جنوبی', estimatedCostMinor: null } }),
        ],
        true,
      ),
      { APR_1: { grant: TOKEN, reject: TOKEN } },
    );
    expect(container).toHaveTextContent('پروژه: پل شمالی');
    expect(container).toHaveTextContent('جاده جنوبی');
    expect(container).toHaveTextContent('برآورد نشده');
    expect(container).toHaveTextContent('بیشتر هم هست');
    expect(within(container).getAllByRole('button', { name: 'ثبت موافقت' })).toHaveLength(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [{ kind: 'FORBIDDEN' } as const, 'در دسترس نیست'],
    [{ kind: 'NOT_FOUND' } as const, 'سازمان فعالی ندارد'],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-x' } as const, 'corr-x'],
    [{ kind: 'MALFORMED', correlationId: 'corr-y' } as const, 'corr-y'],
  ])('says %j', async (result, expected) => {
    const { container } = draw(result);
    expect(container).toHaveTextContent(expected);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the project page itself', () => {
  const detail: ProjectDetail = {
    id: PROJECT_ID,
    title: 'بازسازی پل',
    operationType: 'خاکبرداری',
    locationDescription: 'کیلومتر ۱۲ جاده',
    estimatedCostMinor: '1500000',
    status: 'DRAFT',
    statusChangedAt: '2026-10-20T08:00:00.000Z',
    hasArea: false,
    statusReason: null,
    createdAt: '2026-10-19T08:00:00.000Z',
    scopeOfWork: 'شرح کار پروژه',
    needsSummary: null,
    version: 3,
  };

  it.each(PROJECT_NOTICES)(
    'says the confirmation %s, and only that',
    async (notice: ProjectNotice) => {
      const { container } = render(
        <ProjectDetailScreen
          demoMode="REAL"
          result={{ kind: 'OK', data: detail }}
          notice={notice}
        />,
      );
      const alert = screen.getByRole(
        PROJECT_NOTICE_TEXT[notice].tone === 'warning' ? 'alert' : 'status',
      );
      expect(alert).toHaveTextContent(PROJECT_NOTICE_TEXT[notice].text);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it('shows no notice, no approvals and no commands when it was given none', () => {
    const { container } = render(
      <ProjectDetailScreen demoMode="REAL" result={{ kind: 'OK', data: detail }} />,
    );
    expect(container.querySelectorAll('form')).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('draws the slots it was given after the record', () => {
    render(
      <ProjectDetailScreen
        demoMode="REAL"
        result={{ kind: 'OK', data: detail }}
        approvals={<p>موافقت‌ها اینجا</p>}
        commands={<p>اقدام‌ها اینجا</p>}
      />,
    );
    expect(screen.getByText('موافقت‌ها اینجا')).toBeInTheDocument();
    expect(screen.getByText('اقدام‌ها اینجا')).toBeInTheDocument();
  });

  it.each([
    [{ kind: 'FORBIDDEN' } as const, 'در اختیار شما نیست'],
    [{ kind: 'NOT_FOUND' } as const, 'این پروژه پیدا نشد'],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-x' } as const, 'corr-x'],
    [{ kind: 'MALFORMED', correlationId: 'corr-y' } as const, 'corr-y'],
  ])('writes nothing and draws no slot for %j', (result, expected) => {
    const { container } = render(
      <ProjectDetailScreen
        demoMode="REAL"
        result={result}
        notice="updated"
        approvals={<p>موافقت‌ها اینجا</p>}
        commands={<p>اقدام‌ها اینجا</p>}
      />,
    );
    expect(container).toHaveTextContent(expected);
    expect(screen.queryByText('اقدام‌ها اینجا')).toBeNull();
    expect(screen.queryByText('موافقت‌ها اینجا')).toBeNull();
  });
});
