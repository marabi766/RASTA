import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { scoreField } from '@/lib/tender-evaluation-fields';
import {
  EVALUATION_REFUSAL_TEXT,
  JUSTIFICATION_FIELD,
  READINESS_BLOCKED_TEXT,
} from '@/lib/tender-evaluation-fields';
import { OWNER_COMMAND_DONE, type OwnerCommand } from '@/lib/tender-owner-fields';
import type { ReadResult } from '@/server/assets';
import type { AwardNote, EvaluationMatrix, EvaluationNote } from '@/server/tender-evaluation';
import type { TenderAward } from '@/server/tender-owner';
import {
  AWARD_APPROVED_REQUEST,
  AWARD_PENDING_REQUEST,
  AWARD_RECORD,
  AWARD_STEP,
  AWARDED_TENDER,
  EVALUATED_TENDER,
  EVALUATING_MATRIX,
  EVALUATING_TENDER,
  READY_MATRIX,
} from '@/test/evaluation-fixtures';
import { TENDER_ID } from '@/test/owner-fixtures';

import { AuthorityScreen } from './[id]/AuthoritySections';
import { AwardSection, EvaluationSection } from './[id]/EvaluationSections';
import { UNREPEATABLE_OWNER_TEXT } from './[id]/OwnerCommandForm';
import { OwnerCommands, type OfferedOwnerCommand } from './[id]/OwnerCommands';
import type { OwnerFormState } from './[id]/owner-form-state';
import { OwnerFlash } from './[id]/OwnerSections';
import { OwnTenderDetailScreen } from './[id]/TenderDetailScreen';

// Each test renders the owner's tender screen and runs jest-axe over it once (#341): room to finish.
jest.setTimeout(20_000);

/**
 * What the owner's evaluators and awarder see on `/tenders/[id]`: the matrix
 * as the service returns it — decisions, each evaluator's scores and totals in
 * Persian digits, the ranking — the evaluators' forms, and the award: its
 * approval round, the bid a step names, the forms, and the award once made.
 * Every state an outcome or a form can be in; one jest-axe check per test.
 */

let formState: OwnerFormState = { kind: 'IDLE' };

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, useActionState: () => [formState, '/tenders/TND#action', false] as const };
});

jest.mock('./[id]/owner-actions', () => ({ submitOwnerCommand: jest.fn() }));

afterEach(() => {
  formState = { kind: 'IDLE' };
  window.sessionStorage.clear();
});

const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const PAGE = `/tenders/${TENDER_ID}?view=own`;

const offer = (
  command: OwnerCommand,
  extra: Partial<OfferedOwnerCommand> = {},
): OfferedOwnerCommand => ({
  command,
  submission: { id: `sub_${command}_${extra.scope ?? 'X'}AAAAAAAAAAAA`, replay: STAMP },
  ...extra,
});

const SCORE_ROWS = [
  {
    cell: { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
    label: 'روش اجرا',
    current: 850,
  },
  {
    cell: { criterionCode: 'compliance', maxScore: 1, passFail: true, expectedRevision: 1 },
    label: 'کامل‌بودن مدارک',
    current: 100,
  },
];

const group = (offered: OfferedOwnerCommand[]) => (
  <OwnerCommands
    tenderId={TENDER_ID}
    offered={offered}
    csrfToken="csrf-token-for-this-session"
    owner="owner-tag"
    pageHref={PAGE}
    showsRestored
  />
);

function evaluationPage(
  matrix: ReadResult<EvaluationMatrix>,
  notes: EvaluationNote[],
  offered: OfferedOwnerCommand[] = [],
) {
  return render(
    <OwnTenderDetailScreen
      result={{ kind: 'OK', data: EVALUATING_TENDER }}
      criteria={null}
      owner={<EvaluationSection matrix={matrix} notes={notes} commands={group(offered)} />}
    />,
  );
}

function awardPage(props: {
  status?: string;
  request?: Parameters<typeof AwardSection>[0]['request'];
  step?: Parameters<typeof AwardSection>[0]['step'];
  award?: ReadResult<TenderAward> | null;
  notes?: AwardNote[];
  offered?: OfferedOwnerCommand[];
}) {
  const status = props.status ?? 'EVALUATED';
  return render(
    <OwnTenderDetailScreen
      result={{ kind: 'OK', data: status === 'AWARDED' ? AWARDED_TENDER : EVALUATED_TENDER }}
      criteria={null}
      owner={
        <AwardSection
          status={status}
          request={props.request ?? { kind: 'OK', data: null }}
          step={props.step ?? null}
          award={props.award ?? null}
          notes={props.notes ?? []}
          commands={group(props.offered ?? [])}
        />
      }
    />,
  );
}

const region = (name: string) => screen.getByRole('region', { name });

describe('the evaluation', () => {
  it('in progress: each bid, its decision and scores in Persian digits; a decision and a score form', async () => {
    const { container } = evaluationPage(
      { kind: 'OK', data: EVALUATING_MATRIX },
      ['EVALUATION_INCOMPLETE'],
      [
        offer('SCORE', { subject: 'ORG-CON-A', scope: 'BID_A', scoreRows: SCORE_ROWS }),
        offer('QUALIFY', { subject: 'ORG-CON-B', scope: 'BID_B' }),
        offer('DISQUALIFY', { subject: 'ORG-CON-B', scope: 'BID_B' }),
      ],
    );
    const matrix = within(region('ارزیابی پیشنهادها')).getByRole('list', {
      name: 'پیشنهادها در ماتریس',
    });
    expect(matrix).toHaveTextContent('ORG-CON-A');
    expect(matrix).toHaveTextContent('امتیاز وزنی ۶٫۲۵');
    expect(matrix).toHaveTextContent('روش اجرا ۸٫۵');
    expect(matrix).toHaveTextContent('هنوز کسی دربارهٔ این پیشنهاد تصمیم نگرفته است.');
    expect(screen.getByText(/ارزیابی هنوز کامل نمی‌شود/)).toBeInTheDocument();
    const scoring = screen.getByRole('form', { name: /ثبت امتیاز — ORG-CON-A/ });
    expect(within(scoring).getByLabelText('روش اجرا')).toHaveValue('۸٫۵');
    expect(within(scoring).getByLabelText('کامل‌بودن مدارک')).toHaveValue('1');
    expect(
      screen.getByRole('form', { name: /اعلام واجد شرایط بودن — ORG-CON-B/ }),
    ).toBeInTheDocument();
    const disqualify = screen.getByRole('form', { name: /اعلام فاقد شرایط بودن — ORG-CON-B/ });
    expect(within(disqualify).getByLabelText(/^دلیل/, { selector: 'select' })).toBeRequired();
    expect(within(disqualify).getByLabelText(/شرح دلیل/)).toBeRequired();
    expect(screen.queryByRole('form', { name: 'تکمیل ارزیابی' })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ready: a disqualification shown with its reason, and the completion offered', async () => {
    const { container } = evaluationPage(
      { kind: 'OK', data: READY_MATRIX },
      [],
      [offer('EVALUATE')],
    );
    expect(region('ارزیابی پیشنهادها')).toHaveTextContent(
      'فاقد شرایط — پاسخ‌گو نبودن به الزامات مناقصه',
    );
    expect(region('ارزیابی پیشنهادها')).toHaveTextContent('شرح: مدارک فنی پیوست نشده بود');
    expect(screen.getByRole('form', { name: 'تکمیل ارزیابی' })).toHaveTextContent(
      /رتبهٔ نخست برنده نیست/,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the counted evaluators not provably distinct people: said, and nothing completes', async () => {
    const { container } = evaluationPage(
      {
        kind: 'OK',
        data: { ...READY_MATRIX, ready: false, readinessBlockedBy: 'ACTOR_IDENTITY_UNKNOWN' },
      },
      ['READINESS_BLOCKED'],
    );
    expect(screen.getByText(READINESS_BLOCKED_TEXT.ACTOR_IDENTITY_UNKNOWN!)).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ['refused', { kind: 'FORBIDDEN' } as const, /ارزیابی این مناقصه برای شما خوانده نمی‌شود/],
    [
      'not yet opened',
      { kind: 'UNAVAILABLE', status: 422, correlationId: 'c' } as const,
      /هنوز گشوده نشده‌اند/,
    ],
    [
      'unavailable',
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-503' } as const,
      /corr-503/,
    ],
    [
      'empty',
      { kind: 'OK', data: { ...EVALUATING_MATRIX, bids: [] } } as const,
      /پیشنهاد گشوده‌شده‌ای ندارد/,
    ],
  ])('the matrix %s', async (_what, matrix, text) => {
    const { container } = evaluationPage(matrix as ReadResult<EvaluationMatrix>, []);
    expect(region('ارزیابی پیشنهادها')).toHaveTextContent(text);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a score refused on its field keeps what was typed; a conflict of interest is the evaluation’s words', async () => {
    formState = {
      kind: 'INVALID',
      command: 'SCORE',
      submissionId: 'sub_SCORE_BID_AAAAAAAAAAAA',
      values: { [scoreField('technical')]: '۱۱', [scoreField('compliance')]: '' },
      fieldErrors: {
        [scoreField('technical')]: 'امتیاز عددی از صفر تا ۱۰ است، با حداکثر دو رقم اعشار.',
      },
      message: null,
    };
    const { container } = evaluationPage(
      { kind: 'OK', data: EVALUATING_MATRIX },
      [],
      [offer('SCORE', { subject: 'ORG-CON-A', scope: 'BID', scoreRows: SCORE_ROWS })],
    );
    const field = screen.getByLabelText('روش اجرا');
    expect(field).toHaveValue('۱۱');
    expect(field).toHaveAccessibleDescription(/امتیاز عددی از صفر تا ۱۰ است/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a decision refused for a conflict of interest says so in the evaluation’s words', async () => {
    formState = {
      kind: 'FORBIDDEN',
      command: 'QUALIFY',
      correlationId: 'corr-403',
      reasons: ['CONFLICT_OF_INTEREST'],
    };
    const { container } = evaluationPage(
      { kind: 'OK', data: EVALUATING_MATRIX },
      [],
      [offer('QUALIFY', { subject: 'ORG-CON-B', scope: 'BID_B' })],
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      EVALUATION_REFUSAL_TEXT.CONFLICT_OF_INTEREST!,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a score unconfirmed in this page: the same request again, the scores carried hidden', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'SCORE',
      correlationId: 'corr-504',
      submissionId: 'sub_SCORE_BIDAAAAAAAAAAAA',
      values: { [scoreField('technical')]: '۷', [scoreField('compliance')]: '1' },
      replay: STAMP,
    };
    const { container } = evaluationPage(
      { kind: 'OK', data: EVALUATING_MATRIX },
      [],
      [offer('SCORE', { subject: 'ORG-CON-A', scope: 'BID', scoreRows: SCORE_ROWS })],
    );
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeInTheDocument();
    expect(container.querySelector(`input[name="${scoreField('technical')}"]`)).toHaveValue('۷');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the award', () => {
  it('evaluated, never asked: a form per ranked bid, a justification required for any but the single first', async () => {
    const { container } = awardPage({
      offered: [
        offer('AWARD', {
          subject: 'ORG-CON-A',
          scope: 'BID_A',
          award: { justificationRequired: false, execution: null },
        }),
        offer('AWARD', {
          subject: 'ORG-CON-C',
          scope: 'BID_C',
          award: { justificationRequired: true, execution: null },
        }),
      ],
    });
    expect(region('واگذاری')).toHaveTextContent(
      'هنوز درخواست واگذاری‌ای برای این مناقصه ثبت نشده است.',
    );
    const first = screen.getByRole('form', { name: /درخواست واگذاری — ORG-CON-A/ });
    expect(within(first).getByLabelText('دلیل انتخاب')).not.toBeRequired();
    const second = screen.getByRole('form', { name: /درخواست واگذاری — ORG-CON-C/ });
    expect(within(second).getByLabelText(/دلیل انتخاب/)).toBeRequired();
    expect(second).toHaveTextContent(/سامانه رتبه‌بندی می‌کند و انتخاب نمی‌کند/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('pending, to its authority: the bid the step names and the decision; the awarder is not the evaluator', async () => {
    const { container } = awardPage({
      request: { kind: 'OK', data: AWARD_PENDING_REQUEST },
      step: { kind: 'OK', data: AWARD_STEP },
      notes: ['AWARD_PENDING'],
      offered: [offer('GRANT_AWARD'), offer('REJECT_AWARD')],
    });
    const named = region('واگذاری');
    expect(named).toHaveTextContent('آخرین درخواست واگذاری');
    expect(named).toHaveTextContent('ORG-CON-C');
    expect(named).toHaveTextContent('زمان اجرای کوتاه‌تر');
    expect(named).toHaveTextContent('واجد صلاحیت');
    expect(screen.getByRole('form', { name: 'موافقت با واگذاری' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('form', { name: 'رد درخواست واگذاری' })).getByLabelText(/دلیل رد/),
    ).toBeRequired();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('approved: only executing it, with the justification approved and nothing to type', async () => {
    const { container } = awardPage({
      request: { kind: 'OK', data: AWARD_APPROVED_REQUEST },
      step: { kind: 'OK', data: { ...AWARD_STEP, status: 'GRANTED' } },
      notes: ['AWARD_APPROVED'],
      offered: [
        offer('AWARD', {
          execute: true,
          subject: 'ORG-CON-C',
          scope: 'BID_C',
          award: {
            justificationRequired: false,
            execution: { justification: 'زمان اجرای کوتاه‌تر' },
          },
        }),
      ],
    });
    const execute = screen.getByRole('form', {
      name: /اجرای واگذاری \(موافقت گرفته شده\) — ORG-CON-C/,
    });
    expect(execute).toHaveTextContent(
      'دلیل درخواستِ موافقت‌شده، که همان اجرا می‌شود: زمان اجرای کوتاه‌تر',
    );
    expect(execute.querySelector(`[name="${JUSTIFICATION_FIELD}"]`)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an evaluator is told the award is someone else’s, and offered nothing', async () => {
    const { container } = awardPage({ notes: ['AWARDER_IS_EVALUATOR'] });
    expect(region('واگذاری')).toHaveTextContent(/شما در ارزیابی این مناقصه نقش داشته‌اید/);
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('awarded: the winner, its price as the service keeps it, the rank and when', async () => {
    const { container } = awardPage({
      status: 'AWARDED',
      request: { kind: 'OK', data: { ...AWARD_APPROVED_REQUEST, status: 'CONSUMED' } },
      award: { kind: 'OK', data: AWARD_RECORD },
    });
    const record = region('واگذاری');
    expect(record).toHaveTextContent('ORG-CON-A');
    expect(record).toHaveTextContent('۴٬۲۰۰٬۰۰۰٬۰۰۰');
    expect(record).toHaveTextContent('بی‌دلیل (تنها رتبهٔ نخست)');
    expect(record).toHaveTextContent('اجراشده');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('awarded, the award refused to this person: said, and no price shown', async () => {
    const { container } = awardPage({ status: 'AWARDED', award: { kind: 'FORBIDDEN' } });
    expect(region('واگذاری')).toHaveTextContent(/جزئیات واگذاری، که مبلغ برنده را دارد/);
    expect(region('واگذاری')).not.toHaveTextContent('۴٬۲۰۰٬۰۰۰٬۰۰۰');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an award whose answer was lost is never sent again: no retry, only the set-aside', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'AWARD',
      correlationId: 'corr-504',
      submissionId: 'sub_AWARD_BID_AAAAAAAAAAAA',
      values: null,
      replay: null,
      viewOnly: true,
      unrepeatable: true,
    };
    const { container } = awardPage({
      offered: [
        offer('AWARD', {
          subject: 'ORG-CON-A',
          scope: 'BID_A',
          award: { justificationRequired: false, execution: null },
        }),
      ],
    });
    expect(screen.getByText(UNREPEATABLE_OWNER_TEXT)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'وضعیت مناقصه را دیدم؛ این درخواست را کنار بگذار' }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the confirmations, each in its own words', async () => {
    const { container } = render(
      <>
        {(
          [
            'QUALIFY',
            'DISQUALIFY',
            'SCORE',
            'EVALUATE',
            'AWARD_REQUESTED',
            'AWARDED',
            'GRANT_AWARD',
            'REJECT_AWARD',
          ] as const
        ).map((done) => (
          <OwnerFlash key={done} done={done} />
        ))}
      </>,
    );
    expect(screen.getByText(OWNER_COMMAND_DONE.AWARDED)).toBeInTheDocument();
    expect(screen.getByText(OWNER_COMMAND_DONE.AWARD_REQUESTED)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the award without the evaluators’ read, and an authority of another organization', () => {
  it('ranks unread: a form per qualified bid, the justification the person’s to give, and why', async () => {
    const { container } = awardPage({
      notes: ['AWARD_MATRIX_UNREAD'],
      offered: [
        offer('AWARD', {
          subject: 'ORG-CON-A',
          scope: 'BID_A',
          award: { justificationRequired: null, execution: null },
        }),
      ],
    });
    expect(region('واگذاری')).toHaveTextContent(/ماتریس ارزیابی برای شما خوانده نمی‌شود/);
    const field = within(
      screen.getByRole('form', { name: /درخواست واگذاری — ORG-CON-A/ }),
    ).getByLabelText('دلیل انتخاب');
    expect(field).not.toBeRequired();
    expect(field).toHaveAccessibleDescription(/این صفحه رتبهٔ پیشنهاد را نمی‌داند/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an authority of another organization: its steps as the service shows them, the decision, nothing of the tender', async () => {
    const step = {
      ...AWARD_STEP,
      stepOrder: 1,
      authorityLabel: 'بازبین (نمونه)',
      requestedAt: '2026-10-22T07:00:00.000Z',
      project: { title: 'بهسازی راه روستایی' },
    };
    const { container } = render(
      <AuthorityScreen
        tenderId={TENDER_ID}
        truncated={false}
        steps={[
          {
            step,
            notes: [],
            commands: group([offer('GRANT_AWARD'), offer('REJECT_AWARD')]),
          },
          {
            step: { ...step, id: 'APR_PUB', workflowKey: 'tender.publication', request: null },
            notes: ['STEP_REFUSED'],
          },
        ]}
      />,
    );
    const award = region('موافقت با واگذاری مناقصه');
    expect(award).toHaveTextContent('بهسازی راه روستایی');
    expect(award).toHaveTextContent('ORG-CON-C');
    expect(screen.getByRole('form', { name: 'موافقت با واگذاری' })).toBeInTheDocument();
    expect(region('موافقت با انتشار مناقصه')).toHaveTextContent(
      /تصمیم دربارهٔ آن را هم از شما نمی‌پذیرد/,
    );
    expect(screen.getByText(/مشخصات مناقصه از آنِ سازمان مالک است/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an inbox longer than the walk: no claim about the tender, the warning, and the way on and back (PR 346 review 2, finding 3)', async () => {
    const { container } = render(
      <AuthorityScreen
        tenderId={TENDER_ID}
        truncated
        continueHref="/tenders/TND_1?view=own&inbox=APR_NEXT"
        restartHref="/tenders/TND_1?view=own"
        steps={[]}
      />,
    );
    expect(screen.getByText(/مشخصات این مناقصه برای شما خوانده نمی‌شود/)).toBeInTheDocument();
    expect(screen.queryByText(/شما را مرجع این مناقصه نام برده است/)).not.toBeInTheDocument();
    expect(screen.getByText(/بیش از آن است که این صفحه یک‌جا بخواند/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ادامهٔ جست‌وجو در صندوق موافقت‌ها' })).toHaveAttribute(
      'href',
      '/tenders/TND_1?view=own&inbox=APR_NEXT',
    );
    expect(screen.getByRole('link', { name: 'جست‌وجو از آغاز صندوق' })).toHaveAttribute(
      'href',
      '/tenders/TND_1?view=own',
    );
    expect(screen.queryByText(/در انتظار تصمیم نیست/)).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an awarder who reads neither the matrix nor the bids: the fixed notice, no form (PR 346 review 2, finding 1)', async () => {
    const { container } = awardPage({ notes: ['AWARD_CANDIDATES_UNREADABLE'], offered: [] });
    expect(region('واگذاری')).toHaveTextContent(
      /در این نسخهٔ پورتال، آغاز واگذاری به خواندن ماتریس ارزیابی یا فهرست پیشنهادهای گشوده نیاز دارد/,
    );
    expect(region('واگذاری')).toHaveTextContent(
      /اجرای واگذاریِ موافقت‌شده به این خواندن نیاز ندارد/,
    );
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
