import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  SUPPLIER_NOTICE_TEXT,
  SUPPLIER_NOTICES,
  type SupplierNotice,
} from '@/lib/supplier-commands';
import { supplierCapabilityLabel } from '@/lib/supplier-fields';
import type { ReadResult, SupplierDetail, SupplierPage } from '@/server/suppliers';
import type { WebSession } from '@/server/session';

import { SupplierDetailScreen } from './[id]/SupplierDetailScreen';
import { NO_COMMANDS, supplierCommandsFor } from './[id]/SupplierCommands';
import {
  ApproveQualificationForm,
  RegisterSupplierForm,
  ReinstateSupplierForm,
  RejectQualificationForm,
  SubmitQualificationForm,
  SuspendSupplierForm,
} from './SupplierForms';
import { SuppliersScreen } from './SuppliersScreen';
import type { SupplierFormState } from './supplier-form-state';

/**
 * The supplier write screens with the real `useActionState`: only the server
 * actions are scripted. Every command's form in every state its action can
 * answer, the drawing of each form from the token's roles and the record, and
 * `jest-axe` over all of it.
 */

const act_ = jest.fn<Promise<SupplierFormState<unknown, string>>, [string, FormData]>();
jest.mock('./supplier-actions', () => {
  const named =
    (name: string) =>
    (...args: unknown[]) =>
      act_(name, args[args.length - 1] as FormData);
  return {
    submitRegisterSupplier: named('register'),
    submitQualificationRequest: named('submit'),
    submitApproveQualification: named('approve'),
    submitRejectQualification: named('reject'),
    submitSuspendSupplier: named('suspend'),
    submitReinstateSupplier: named('reinstate'),
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

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const BASELINE = 'signed-baseline-token';
const SUPPLIER_ID = 'SUP_01J00000000000000000000000';
const BOUND = {
  supplierId: SUPPLIER_ID,
  csrfToken: CSRF,
  submissionId: SUBMISSION,
  baseline: BASELINE,
};
const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

async function send(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLElement);
  });
}

const field = (container: HTMLElement, name: string) =>
  container.querySelector(`[name="${name}"]`) as HTMLInputElement;

beforeEach(() => act_.mockReset());

const FORMS = [
  {
    name: 'register',
    render: () => render(<RegisterSupplierForm csrfToken={CSRF} submissionId={SUBMISSION} />),
    named: false,
    values: { displayName: '', capabilities: [] },
  },
  {
    name: 'submit a qualification',
    render: () =>
      render(<SubmitQualificationForm {...BOUND} capabilities={['GOODS_SUPPLY', 'CONTRACTING']} />),
    named: true,
    values: { capability: '', statement: '', evidence: [] },
  },
  {
    name: 'approve',
    render: () => render(<ApproveQualificationForm {...BOUND} capabilityLabel="تامین کالا" />),
    named: true,
    values: { note: '' },
  },
  {
    name: 'reject',
    render: () => render(<RejectQualificationForm {...BOUND} capabilityLabel="تامین کالا" />),
    named: true,
    values: { reason: '', note: '' },
  },
  {
    name: 'suspend',
    render: () => render(<SuspendSupplierForm {...BOUND} />),
    named: true,
    values: { reason: '' },
  },
  {
    name: 'reinstate',
    render: () => render(<ReinstateSupplierForm {...BOUND} />),
    named: true,
    values: { reason: '' },
  },
] as const;

describe.each(FORMS)('the $name form', (form) => {
  it('carries the CSRF token and the submission id, and names no supplier, organization or qualification', () => {
    const { container } = form.render();
    expect(field(container, CSRF_FIELD)).toHaveValue(CSRF);
    expect(field(container, SUBMISSION_FIELD)).toHaveValue(SUBMISSION);
    if (form.named) {
      expect(field(container, BASELINE_FIELD)).toHaveValue(BASELINE);
      expect(field(container, BASELINE_FIELD)).toHaveAttribute('type', 'hidden');
    } else {
      expect(container.querySelector(`[name="${BASELINE_FIELD}"]`)).toBeNull();
    }
    for (const name of ['supplierId', 'organizationId', 'qualificationId', 'id', 'status']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
  });

  it('is a plain form post to a server action, with no physical-direction utility', () => {
    const { container } = form.render();
    expect(container.querySelector('form')?.getAttribute('action')).not.toBeNull();
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
  });

  it('says what the command does before it is sent', () => {
    const { container } = form.render();
    expect(container.querySelector('p.text-content-muted')?.textContent?.length).toBeGreaterThan(
      40,
    );
  });

  it('has no axe violations idle', async () => {
    const { container } = form.render();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, /نشست شما پایان یافته/],
    [{ kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' } as const, /همین حالا در دسترس نیست/],
    [{ kind: 'REFUSED', reason: 'BASELINE' } as const, /منقضی شده است/],
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
    let release: (state: SupplierFormState<unknown, string>) => void = () => undefined;
    act_.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { container } = form.render();
    await send(container);
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
    await act(async () => release({ kind: 'IDLE' }));
  });
});

describe('a refused form is drawn again as it was typed', () => {
  it('registration keeps the name and the ticked categories, and the corrected post carries them', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      values: {
        displayName: String(sent.get('displayName')),
        capabilities: sent.getAll('capabilities').map(String),
      },
      fieldErrors: { displayName: 'نام کوتاه است' },
      message: null,
    }));
    act_.mockResolvedValueOnce({ kind: 'IDLE' });
    const { container } = render(
      <RegisterSupplierForm csrfToken={CSRF} submissionId={SUBMISSION} />,
    );
    fireEvent.change(field(container, 'displayName'), { target: { value: 'ا' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'خدمات تعمیرگاهی' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'پیمانکاری' }));
    await send(container);
    await screen.findByText('نام کوتاه است');

    expect(field(container, 'displayName')).toHaveValue('ا');
    expect(screen.getByRole('checkbox', { name: 'خدمات تعمیرگاهی' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'پیمانکاری' })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: supplierCapabilityLabel('GOODS_SUPPLY') }),
    ).not.toBeChecked();

    fireEvent.change(field(container, 'displayName'), { target: { value: 'تعمیرگاه البرز' } });
    await send(container);
    const second = act_.mock.calls[1]![1];
    expect(second.get('displayName')).toBe('تعمیرگاه البرز');
    expect(second.getAll('capabilities')).toEqual(['WORKSHOP_SERVICE', 'CONTRACTING']);
    expect(second.get(SUBMISSION_FIELD)).toBe(SUBMISSION);
  });

  it('a qualification request keeps the select, the statement and every evidence row', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      values: {
        capability: String(sent.get('capability')),
        statement: String(sent.get('statement')),
        evidence: [
          {
            documentId: String(sent.get('evidenceDocumentId_0')),
            label: String(sent.get('evidenceLabel_0')),
          },
          {
            documentId: String(sent.get('evidenceDocumentId_1')),
            label: String(sent.get('evidenceLabel_1')),
          },
        ],
      },
      fieldErrors: { evidence: 'هر سند را فقط یک بار پیوست کنید' },
      message: null,
    }));
    act_.mockResolvedValueOnce({ kind: 'IDLE' });
    const { container } = render(
      <SubmitQualificationForm {...BOUND} capabilities={['GOODS_SUPPLY', 'CONTRACTING']} />,
    );
    fireEvent.change(field(container, 'capability'), { target: { value: 'CONTRACTING' } });
    fireEvent.change(field(container, 'statement'), { target: { value: 'سابقه ده ساله' } });
    fireEvent.change(field(container, 'evidenceDocumentId_0'), { target: { value: 'DOC_1' } });
    fireEvent.change(field(container, 'evidenceLabel_0'), { target: { value: 'پروانه' } });
    fireEvent.change(field(container, 'evidenceDocumentId_1'), { target: { value: 'DOC_1' } });
    await send(container);
    await screen.findByText('هر سند را فقط یک بار پیوست کنید');

    expect(field(container, 'capability').value).toBe('CONTRACTING');
    expect(field(container, 'statement').value).toBe('سابقه ده ساله');
    expect(field(container, 'evidenceDocumentId_0').value).toBe('DOC_1');
    expect(field(container, 'evidenceLabel_0').value).toBe('پروانه');
    expect(field(container, 'evidenceDocumentId_1').value).toBe('DOC_1');

    fireEvent.change(field(container, 'evidenceDocumentId_1'), { target: { value: 'DOC_2' } });
    await send(container);
    const second = act_.mock.calls[1]![1];
    expect(second.get('capability')).toBe('CONTRACTING');
    expect(second.get('statement')).toBe('سابقه ده ساله');
    expect(second.get('evidenceDocumentId_0')).toBe('DOC_1');
    expect(second.get('evidenceDocumentId_1')).toBe('DOC_2');
  });

  it('a reason form keeps the typed reason', async () => {
    act_.mockImplementationOnce(async (_name, sent) => ({
      kind: 'INVALID',
      submissionId: String(sent.get(SUBMISSION_FIELD)),
      values: { reason: String(sent.get('reason')) },
      fieldErrors: { reason: 'دلیل را کامل بنویسید' },
      message: null,
    }));
    const { container } = render(<SuspendSupplierForm {...BOUND} />);
    fireEvent.change(field(container, 'reason'), { target: { value: 'کوتاه' } });
    await send(container);
    await screen.findByText('دلیل را کامل بنویسید');
    expect(field(container, 'reason').value).toBe('کوتاه');
  });
});

describe('the evidence rows', () => {
  it('draw three rows, add one at a time, and stop at the service’s twenty', () => {
    const { container } = render(
      <SubmitQualificationForm {...BOUND} capabilities={['GOODS_SUPPLY']} />,
    );
    const rows = () => container.querySelectorAll('[name^="evidenceDocumentId_"]').length;
    expect(rows()).toBe(3);
    for (let i = 0; i < 40; i += 1) {
      const add = screen.queryByRole('button', { name: 'افزودن سند' });
      if (add) fireEvent.click(add);
    }
    expect(rows()).toBe(20);
    expect(screen.queryByRole('button', { name: 'افزودن سند' })).toBeNull();
  });

  it('say that a document is only an id in the document service and nothing is required', () => {
    render(<SubmitQualificationForm {...BOUND} capabilities={['GOODS_SUPPLY']} />);
    expect(screen.getByText(/فقط شناسه سند در سرویس اسناد/)).toBeInTheDocument();
    expect(screen.getByText(/هیچ سندی اجباری نیست/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// What the page draws, from the token and the record
// ---------------------------------------------------------------------------

const SUPPLIER_ORG = 'ORG-SUP';

function tokenFor(organizationId: string | null, roles: string[], memberships?: string[]): string {
  const claims = {
    ...(organizationId === null
      ? {}
      : {
          org_id: organizationId,
          org_roles: roles.filter((r) => r !== 'SYSTEM_ADMIN').map((r) => `${organizationId}:${r}`),
        }),
    org_ids: memberships ?? (organizationId === null ? [] : [organizationId]),
    realm_access: { roles: roles.includes('SYSTEM_ADMIN') ? ['SYSTEM_ADMIN'] : [] },
  };
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

const sessionFor = (token: string): WebSession => ({
  subject: 'user-1',
  username: 'u',
  organizationId: 'ORG-X',
  accessToken: token,
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: CSRF,
  issuedAt: 1_900_000_000,
});

const DETAIL: SupplierDetail = {
  id: SUPPLIER_ID,
  organizationId: SUPPLIER_ORG,
  displayName: 'تعمیرگاه البرز',
  status: 'ACTIVE',
  capabilities: ['WORKSHOP_SERVICE'],
  qualifiedFor: ['WORKSHOP_SERVICE'],
  registeredAt: '2026-08-01T08:00:00.000Z',
  qualifications: [
    {
      id: 'QUA_APPROVED',
      capability: 'WORKSHOP_SERVICE',
      state: 'APPROVED',
      statement: null,
      submittedAt: '2026-08-02T08:00:00.000Z',
      decidedAt: '2026-08-03T08:00:00.000Z',
      decisionNote: null,
      evidence: [],
      evidenceCount: 0,
      current: true,
    },
    {
      id: 'QUA_OPEN',
      capability: 'GOODS_SUPPLY',
      state: 'SUBMITTED',
      statement: 'تامین لوازم یدکی',
      submittedAt: '2026-09-02T08:00:00.000Z',
      decidedAt: null,
      decisionNote: null,
      evidence: [
        { documentId: 'DOC_LICENCE_1', label: 'پروانه کسب' },
        { documentId: 'DOC_NO_LABEL', label: null },
      ],
      evidenceCount: 2,
      current: false,
    },
  ],
  suspensions: [],
};

const SUSPENDED: SupplierDetail = {
  ...DETAIL,
  status: 'SUSPENDED',
  qualifiedFor: [],
  suspensions: [
    {
      id: 'SUS_1',
      reason: 'شکایت تکراری',
      suspendedAt: '2026-09-01T08:00:00.000Z',
      reinstatedAt: null,
      reinstatementNote: null,
      open: true,
    },
  ],
};

function drawn(
  detail: SupplierDetail,
  organizationId: string | null,
  roles: string[],
  memberships?: string[],
) {
  const session = sessionFor(tokenFor(organizationId, roles, memberships));
  const commands = supplierCommandsFor(session, detail);
  return render(<SupplierDetailScreen result={{ kind: 'OK', data: detail }} commands={commands} />);
}

const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent);

describe('who is drawn which form on a supplier', () => {
  it('a supplier-side person of the supplier’s own organization may send a request for what is still open — and decide nothing', () => {
    drawn(DETAIL, SUPPLIER_ORG, ['SUPPLIER']);
    // GOODS_SUPPLY awaits a decision and WORKSHOP_SERVICE is approved: only CONTRACTING is open.
    const select = screen.getByRole('combobox', { name: /دسته/ });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['انتخاب کنید…', 'پیمانکاری']);
    expect(buttons()).toContain('ارسال درخواست صلاحیت');
    expect(buttons().join()).not.toMatch(/تایید صلاحیت|رد صلاحیت|تعلیق/);
  });

  it('offers no request when every capability is awaiting a decision or approved', () => {
    drawn(
      {
        ...DETAIL,
        qualifications: [
          ...DETAIL.qualifications,
          { ...DETAIL.qualifications[1]!, id: 'QUA_3', capability: 'CONTRACTING' },
        ],
      },
      SUPPLIER_ORG,
      ['SUPPLIER'],
    );
    expect(screen.queryByRole('combobox', { name: /دسته/ })).toBeNull();
  });

  it('a platform operator may decide a request awaiting a decision and suspend — and cannot submit', () => {
    drawn(DETAIL, 'ORG-UNION', ['UNION_ADMIN']);
    expect(screen.getByText('تایید صلاحیت…')).toBeInTheDocument();
    expect(screen.getByText('رد صلاحیت…')).toBeInTheDocument();
    expect(screen.getByText('تعلیق این تامین‌کننده…')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /دسته/ })).toBeNull();
    // Only the one request awaiting a decision has the decision forms.
    expect(screen.getAllByText('تایید صلاحیت…')).toHaveLength(1);
  });

  it('draws a reinstatement, and no suspension, for a suspended supplier', () => {
    drawn(SUSPENDED, 'ORG-UNION', ['UNION_ADMIN']);
    expect(buttons()).toContain('رفع تعلیق');
    expect(screen.queryByText('تعلیق این تامین‌کننده…')).toBeNull();
  });

  it('a platform operator who belongs to the supplier’s organization is offered no decision and is told why', () => {
    drawn(DETAIL, 'ORG-UNION', ['UNION_ADMIN'], ['ORG-UNION', SUPPLIER_ORG]);
    expect(screen.queryByText('تایید صلاحیت…')).toBeNull();
    expect(screen.queryByText('تعلیق این تامین‌کننده…')).toBeNull();
    expect(screen.getByText(/سازمان شما صاحب این پرونده است/)).toBeInTheDocument();
  });

  it('a platform administrator with no organization decides too: no decision names a tenant', () => {
    drawn(DETAIL, null, ['SYSTEM_ADMIN']);
    expect(screen.getByText('تایید صلاحیت…')).toBeInTheDocument();
  });

  it.each([
    ['a fleet manager', 'ORG-X', ['FLEET_MANAGER']],
    ['a procurement user', 'ORG-X', ['PROCUREMENT_USER']],
    ['an auditor', 'ORG-UNION', ['UNION_ADMIN', 'AUDITOR']],
    ['a supplier-side person of another organization', 'ORG-OTHER', ['SUPPLIER']],
  ])('draws %s no form at all and says the role only reads', (_name, org, roles) => {
    drawn(DETAIL, org, roles);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('نقش شما در این پرونده فقط خواندن را می‌دهد.')).toBeInTheDocument();
  });

  it('draws nothing for a token it cannot read', () => {
    const session = sessionFor('not-a-jwt');
    expect(supplierCommandsFor(session, DETAIL)).toEqual(NO_COMMANDS);
  });

  it('signs every form for its own command, supplier and — for a decision — qualification', () => {
    const { container } = drawn(DETAIL, 'ORG-UNION', ['UNION_ADMIN']);
    const opened = [...container.querySelectorAll(`input[name="${BASELINE_FIELD}"]`)].map(
      (input) => (input as HTMLInputElement).value,
    );
    // approve, reject and suspend: three forms, three different signed tokens.
    expect(opened).toHaveLength(3);
    expect(new Set(opened).size).toBe(3);
  });

  it('has no axe violations for the supplier’s person, the operator, the reinstating operator and the read-only person', async () => {
    for (const [detail, org, roles] of [
      [DETAIL, SUPPLIER_ORG, ['SUPPLIER']],
      [DETAIL, 'ORG-UNION', ['UNION_ADMIN']],
      [SUSPENDED, 'ORG-UNION', ['UNION_ADMIN']],
      [DETAIL, 'ORG-X', ['FLEET_MANAGER']],
    ] as const) {
      const { container, unmount } = drawn(detail, org, [...roles]);
      for (const summary of container.querySelectorAll('summary')) fireEvent.click(summary);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe('the supplier page itself', () => {
  it.each(SUPPLIER_NOTICES)(
    'says the %s notice once, in its own words, as a status',
    async (notice: SupplierNotice) => {
      const { container } = render(
        <SupplierDetailScreen result={{ kind: 'OK', data: DETAIL }} notice={notice} />,
      );
      expect(screen.getByText(SUPPLIER_NOTICE_TEXT[notice].text)).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it('shows each evidence document by its id and label only — no link, nothing opened or resolved', () => {
    const { container } = render(<SupplierDetailScreen result={{ kind: 'OK', data: DETAIL }} />);
    expect(screen.getByText('DOC_LICENCE_1')).toBeInTheDocument();
    expect(screen.getByText('پروانه کسب')).toBeInTheDocument();
    expect(screen.getByText('DOC_NO_LABEL')).toBeInTheDocument();
    expect(container.querySelectorAll('a[href]')).toHaveLength(0);
    expect(screen.getByText(/سامانه آن را نگشوده و نسنجیده است/)).toBeInTheDocument();
  });

  it('shows no commands and no note when it was given none', () => {
    render(<SupplierDetailScreen result={{ kind: 'OK', data: DETAIL }} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('draws the empty states with the request form below them for an organization with nothing sent yet', () => {
    const empty = { ...DETAIL, qualifications: [], suspensions: [] };
    drawn(empty, SUPPLIER_ORG, ['ORGANIZATION_ADMIN']);
    expect(screen.getByText('هیچ درخواست صلاحیتی ثبت نشده')).toBeInTheDocument();
    expect(screen.getByText('هیچ تعلیقی ثبت نشده')).toBeInTheDocument();
    expect(buttons()).toContain('ارسال درخواست صلاحیت');
  });

  it.each([
    [{ kind: 'FORBIDDEN' } as const, /در اختیار شما نیست/],
    [{ kind: 'NOT_FOUND' } as const, /پیدا نشد/],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-down' } as const, /corr-down/],
  ])('draws no command when the read is %j', (result, expected) => {
    const { container } = render(
      <SupplierDetailScreen result={result as ReadResult<SupplierDetail>} commands={NO_COMMANDS} />,
    );
    expect(container).toHaveTextContent(expected);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('the directory page', () => {
  const PAGE: ReadResult<SupplierPage> = {
    kind: 'OK',
    data: {
      items: [
        {
          id: 'SUP_OWN',
          organizationId: SUPPLIER_ORG,
          displayName: 'تعمیرگاه ما',
          status: 'ACTIVE',
          capabilities: ['WORKSHOP_SERVICE'],
          qualifiedFor: [],
          registeredAt: '2026-08-01T08:00:00.000Z',
        },
        {
          id: 'SUP_OTHER',
          organizationId: 'ORG-OTHER',
          displayName: 'تعمیرگاه دیگر',
          status: 'ACTIVE',
          capabilities: ['WORKSHOP_SERVICE'],
          qualifiedFor: [],
          registeredAt: '2026-08-01T08:00:00.000Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  };

  it('marks the row of the organization the session acts for — the API has no “my supplier”', () => {
    render(<SuppliersScreen result={PAGE} query={{}} ownOrganizationId={SUPPLIER_ORG} />);
    expect(screen.getAllByText('سازمان شما')).toHaveLength(1);
    expect(screen.getByText('سازمان شما').closest('li')).toHaveTextContent('تعمیرگاه ما');
  });

  it('draws the registration form only when it was given one, above the directory', async () => {
    const { container } = render(
      <SuppliersScreen
        result={PAGE}
        query={{}}
        register={<RegisterSupplierForm csrfToken={CSRF} submissionId={SUBMISSION} />}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'ثبت پرونده تامین‌کننده برای سازمان شما' }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws no registration and no mark by default', () => {
    render(<SuppliersScreen result={PAGE} query={{}} />);
    expect(screen.queryByText('سازمان شما')).toBeNull();
    expect(screen.queryByRole('heading', { name: /ثبت پرونده/ })).toBeNull();
  });
});
