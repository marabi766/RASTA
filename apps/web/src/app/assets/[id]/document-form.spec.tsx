import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { DOCUMENT_KINDS, UPLOAD_TOKEN_FIELD } from '@/lib/asset-document-fields';

import { AttachDocumentForm } from './AssetDocumentForm';
import type { DocumentFormState } from './document-form-state';

/**
 * The attach-document form in every state its own action can put it in.
 * `useActionState` is stubbed so a state can be rendered without a server action
 * running (the technique of `record-forms.spec.tsx`).
 */

let currentState: DocumentFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/assets/AST#action', pending] as const,
  };
});
jest.mock('./document-actions', () => ({ submitAttachDocument: jest.fn() }));

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const ASSET = 'AST_01J00000000000000000000000';
const BASELINE = 'eyJzaWduZWQiOiJieS10aGUtcGFnZSJ9.sig';
const IDENTITY = { assetId: ASSET, csrfToken: CSRF, submissionId: SUBMISSION, baseline: BASELINE };

const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

const setState = (state: DocumentFormState, isPending = false) => {
  currentState = state;
  pending = isPending;
};

describe('the attach-document form', () => {
  it('carries the CSRF token, the submission id and the signed baseline — and no field that names an asset or a document', () => {
    const { container } = render(<AttachDocumentForm {...IDENTITY} />);
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    expect(container.querySelector(`input[name="${BASELINE_FIELD}"]`)).toHaveValue(BASELINE);
    for (const name of ['assetId', 'id', 'asset', 'documentId', UPLOAD_TOKEN_FIELD]) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
    expect(container.innerHTML).not.toContain(ASSET);
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = render(<AttachDocumentForm {...IDENTITY} />);
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/assets/AST#action');
  });

  it('stays closed on a fresh page, and opens once an attempt came back', () => {
    const closed = render(<AttachDocumentForm {...IDENTITY} />);
    expect(closed.container.querySelector('details')).not.toHaveAttribute('open');
    closed.unmount();
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr', resume: null });
    const reopened = render(<AttachDocumentForm {...IDENTITY} />);
    expect(reopened.container.querySelector('details')).toHaveAttribute('open');
  });

  it('offers exactly the service’s kinds, in Persian, with none chosen — and a file input', () => {
    const { container } = render(<AttachDocumentForm {...IDENTITY} />);
    const select = container.querySelector('select[name="kind"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['', ...DOCUMENT_KINDS]);
    expect(select).toHaveValue('');
    expect([...select.options].map((option) => option.text).join(' ')).not.toMatch(/[A-Za-z]/);
    expect(container.querySelector('input[name="file"]')).toHaveAttribute('type', 'file');
  });

  it('requires the kind, the title and the file, and leaves the two dates optional', () => {
    const { container } = render(<AttachDocumentForm {...IDENTITY} />);
    for (const name of ['kind', 'title', 'file']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeRequired();
    }
    for (const name of ['issuedAt', 'expiresAt']) {
      expect(container.querySelector(`[name="${name}"]`)).not.toBeRequired();
      expect(container.querySelector(`[name="${name}"]`)).toHaveAttribute('type', 'date');
    }
  });

  it('states no limit of its own: the hint sends the person to the service’s refusal', () => {
    render(<AttachDocumentForm {...IDENTITY} />);
    expect(screen.getByText(/نوع و حجم مجاز را سامانهٔ اسناد تعیین می‌کند/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/مگابایت|MB|kB|\d+ ?KB/i);
  });

  it('keeps the same submission id when the form comes back invalid', () => {
    setState({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: { kind: 'MANUAL', title: 'عنوان', issuedAt: '', expiresAt: '' },
      fieldErrors: { file: 'جملهٔ سرویس دربارهٔ فایل' },
      message: null,
      resume: null,
    });
    const { container } = render(<AttachDocumentForm {...IDENTITY} />);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
    expect(screen.getByText('جملهٔ سرویس دربارهٔ فایل')).toBeInTheDocument();
    expect(container.querySelector('select[name="kind"]')).toHaveValue('MANUAL');
    expect(container.querySelector('input[name="title"]')).toHaveValue('عنوان');
    // The browser clears a file input after an attempt; the form says so.
    expect(screen.getByText(/دوباره انتخاب کنید/)).toBeInTheDocument();
  });

  describe('once the file is registered', () => {
    const resume = 'eyJ1cGxvYWRlZCI6InRva2VuIn0.sig';

    it('carries the signed token, drops the file input, and says a resend only attaches', () => {
      setState({ kind: 'UNCONFIRMED', correlationId: 'corr-unk', resume });
      const { container } = render(<AttachDocumentForm {...IDENTITY} />);
      expect(container.querySelector(`input[name="${UPLOAD_TOKEN_FIELD}"]`)).toHaveValue(resume);
      expect(container.querySelector('input[name="file"]')).toBeNull();
      expect(
        screen.getByText(/فرستادن دوباره فقط پیوست آن به دارایی را تکرار می‌کند/),
      ).toBeInTheDocument();
      // The same submission id: a resend is the replay asset-service recognises.
      expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    });

    it('says the file was uploaded when the attach failed, and never "nothing was attached" for an unknown outcome', () => {
      setState({ kind: 'FAILED', status: 503, correlationId: 'corr-503', resume });
      const failed = render(<AttachDocumentForm {...IDENTITY} />);
      expect(screen.getByRole('alert')).toHaveTextContent('فایل بارگذاری شد');
      failed.unmount();

      setState({ kind: 'UNCONFIRMED', correlationId: 'corr-unk', resume });
      render(<AttachDocumentForm {...IDENTITY} />);
      expect(screen.getByRole('alert')).not.toHaveTextContent('چیزی پیوست نشد');
    });
  });

  it('disables the button while a submit is in flight, so a double click is one send', () => {
    setState({ kind: 'IDLE' }, true);
    render(<AttachDocumentForm {...IDENTITY} />);
    expect(screen.getByRole('button', { name: 'در حال بارگذاری…' })).toBeDisabled();
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, /نشست شما پایان یافته/],
    [{ kind: 'REFUSED', reason: 'UPLOAD' } as const, /معتبر شناخته نشد/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
    [
      { kind: 'NOT_FOUND', correlationId: 'corr-404' } as const,
      /پیدا نشد یا در سازمان فعال شما نیست/,
    ],
    [{ kind: 'FAILED', status: 503, correlationId: 'corr-503', resume: null } as const, /corr-503/],
    [{ kind: 'UNCONFIRMED', correlationId: 'corr-unk', resume: null } as const, /corr-unk/],
  ])('says so in Persian for %j', (state, expected) => {
    setState(state);
    render(<AttachDocumentForm {...IDENTITY} />);
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
  });

  it('uses no physical-direction utility, and has no accessibility violations', async () => {
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr', resume: 'tok.sig' });
    const { container } = render(<AttachDocumentForm {...IDENTITY} />);
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });
});
