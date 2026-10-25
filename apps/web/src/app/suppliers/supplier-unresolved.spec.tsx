import { act, fireEvent, render, screen } from '@testing-library/react';

import { SUBMISSION_FIELD } from '@/lib/form-fields';
import type { SupplierFormState } from './supplier-form-state';
import { NON_STANDARD_SPELLING } from '@/test/orthography';

/**
 * The forms and the notice for an unresolved supplier write, with the real
 * `useActionState`: a held form cannot send, and a form that came back
 * `UNCONFIRMED` cannot send again either — only the page's reconciliation
 * (a new draw of the form) re-enables it.
 */

const act_ = jest.fn<Promise<SupplierFormState<unknown, string>>, [string]>();
const reconcile = jest.fn();
jest.mock('./supplier-actions', () => ({
  submitRegisterSupplier: (...args: unknown[]) => act_('register', ...(args as [])),
  submitQualificationRequest: (...args: unknown[]) => act_('submit', ...(args as [])),
  submitApproveQualification: (...args: unknown[]) => act_('approve', ...(args as [])),
  submitRejectQualification: (...args: unknown[]) => act_('reject', ...(args as [])),
  submitSuspendSupplier: (...args: unknown[]) => act_('suspend', ...(args as [])),
  submitReinstateSupplier: (...args: unknown[]) => act_('reinstate', ...(args as [])),
  reconcileSupplierWrite: (...args: unknown[]) => reconcile(...args),
}));

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const forms = require('./SupplierForms') as typeof import('./SupplierForms');
const { UnresolvedSupplierNotice } =
  require('./UnresolvedSupplierNotice') as typeof import('./UnresolvedSupplierNotice');
/* eslint-enable @typescript-eslint/no-require-imports */

const BOUND = {
  supplierId: 'SUP_1',
  csrfToken: 'csrf',
  submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
  baseline: 'signed-baseline-token',
};

const FORMS = {
  register: (held: boolean) => (
    <forms.RegisterSupplierForm csrfToken="csrf" submissionId={BOUND.submissionId} held={held} />
  ),
  submit: (held: boolean) => (
    <forms.SubmitQualificationForm {...BOUND} held={held} capabilities={['GOODS_SUPPLY']} />
  ),
  approve: (held: boolean) => (
    <forms.ApproveQualificationForm {...BOUND} held={held} capabilityLabel="تأمین کالا" />
  ),
  reject: (held: boolean) => (
    <forms.RejectQualificationForm {...BOUND} held={held} capabilityLabel="تأمین کالا" />
  ),
  suspend: (held: boolean) => <forms.SuspendSupplierForm {...BOUND} held={held} />,
  reinstate: (held: boolean) => <forms.ReinstateSupplierForm {...BOUND} held={held} />,
};

beforeEach(() => {
  act_.mockReset();
  reconcile.mockReset();
});

describe.each(Object.entries(FORMS))('the %s form', (name, draw) => {
  it('has its submit button disabled while the page holds an unresolved write', () => {
    const { container } = render(draw(true));
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit).toBeDisabled();
    expect(container.querySelector(`[name="${SUBMISSION_FIELD}"]`)).not.toBeNull();
  });

  it('is enabled when nothing is held', () => {
    const { container } = render(draw(false));
    expect(container.querySelector('button[type="submit"]')).toBeEnabled();
  });

  it('stays disabled, with the warning and correlation id, after an UNCONFIRMED answer', async () => {
    act_.mockResolvedValue({ kind: 'UNCONFIRMED', correlationId: `corr-${name}` });
    const { container } = render(draw(false));
    await act(async () => {
      fireEvent.submit(container.querySelector('form') as HTMLElement);
    });
    expect(screen.getByText(new RegExp(`corr-${name}`))).toBeInTheDocument();
    expect(container.querySelector('button[type="submit"]')).toBeDisabled();
  });
});

describe('the notice', () => {
  const request = {
    id: 'a'.repeat(32),
    key: 'sub_x',
    digest: 'd',
    deadline: null,
    ref: 'corr-lost',
    inFlight: false,
  };
  const notice = (over: Partial<typeof request> = {}, supplierId: string | null = 'SUP_1') => (
    <UnresolvedSupplierNotice
      request={{ ...request, ...over }}
      supplierId={supplierId}
      csrfToken="csrf"
      releaseToken="signed-release-token"
    />
  );

  it('names the correlation id, offers no resend, and asks for the confirmation', () => {
    const { container } = render(notice());
    expect(screen.getByText(/corr-lost/)).toBeInTheDocument();
    expect(container.querySelector('input[type="checkbox"]')).toBeRequired();
    expect(container.querySelector('[name="csrf"]')).toHaveValue('csrf');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/ارسال دوباره همان/)).toBeNull();
  });

  it('names the held request it was drawn for, so a stale form cannot release a newer one', () => {
    const { container } = render(notice());
    expect(container.querySelector('[name="release"]')).toHaveValue('signed-release-token');
  });

  it('falls back to the key as the reference when none was kept, and says a send is under way', () => {
    render(notice({ ref: null as never, inFlight: true }));
    expect(screen.getByText(/sub_x/)).toBeInTheDocument();
    expect(screen.getByText(/هم‌اکنون در حال فرستاده شدن/)).toBeInTheDocument();
  });

  it('uses the standard orthography in what it says', () => {
    const { container } = render(notice({ inFlight: true }, null));
    expect(container.textContent ?? '').not.toMatch(NON_STANDARD_SPELLING);
  });
});
