import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import {
  DISPUTE_REPLAY_WINDOW_SECONDS,
  restoreUnresolvedDispute,
  saveUnresolvedDispute,
} from '@/lib/unresolved-dispute';

import { DisputeCommandForm } from './[id]/DisputeCommandForm';
import { DisputeCommands } from './[id]/DisputeCommands';
import type { DisputeFormState } from './[id]/form-state';

/**
 * The unconfirmed path with the real `useActionState`: only the action's own
 * body and `/auth/session` are scripted.
 *
 * - the retry posts the same key and the same text;
 * - the submission is remembered **before** it is sent, across a reload, per
 *   transaction and per login, and nothing fresh is offered on that
 *   transaction until it is reconciled (PR 319 review 1, finding 2);
 * - a call that itself fails is "session ended" only when `/auth/session`
 *   says so; otherwise the same request may still be sent (finding 4).
 */

const submit = jest.fn<Promise<DisputeFormState>, [string, DisputeFormState, FormData]>();
jest.mock('./[id]/actions', () => ({
  submitDisputeCommand: (id: string, previous: DisputeFormState, form: FormData) =>
    submit(id, previous, form),
}));

const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();

const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const FRESH = 'sub_FRESHKEYFRESHKEYFRE';
const REASON = 'کالا تحویل نشده و پاسخی هم نیامده است';
const RESOLUTION = 'کالا با تأخیر رسید و پذیرفته شد';
const BINDING = { owner: 'owner-tag-A', session: 'session-tag-1' };
const SESSION_MAX_AGE = 12 * 60 * 60;
const STORE_KEY = 'rasta.unresolved-dispute.TXN_1';

const lostResponse = () => new Error('An unexpected response was received from the server.');

function renderForm(props: Partial<React.ComponentProps<typeof DisputeCommandForm>> = {}) {
  return render(
    <DisputeCommandForm
      transactionId="TXN_1"
      command="DISPUTE"
      csrfToken="csrf"
      submissionId={KEY}
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      {...props}
    />,
  );
}

/** What the page draws for the transaction: what a reload brings back. */
function renderCommands(
  commands: readonly ('DISPUTE' | 'RESOLVE_DISPUTE')[] = ['DISPUTE'],
  binding = BINDING,
) {
  return render(
    <DisputeCommands
      transactionId="TXN_1"
      commands={commands}
      csrfToken="csrf"
      submissionIds={{ DISPUTE: FRESH, RESOLVE_DISPUTE: FRESH }}
      binding={binding}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
    />,
  );
}

async function submitForm(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

const unconfirmed = (correlationId: string | null = 'COR_ORIGINAL'): DisputeFormState => ({
  kind: 'UNCONFIRMED',
  command: 'DISPUTE',
  correlationId,
  submissionId: KEY,
  values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
});

beforeEach(() => {
  submit.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => jest.restoreAllMocks());

describe('the same request again', () => {
  it('re-sends the first request’s key and text, and keeps its tracking code', async () => {
    submit.mockResolvedValueOnce(unconfirmed());
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());

    submit.mockImplementationOnce(async (_id, previous) => ({
      ...(previous as Extract<DisputeFormState, { kind: 'UNCONFIRMED' }>),
      retryUnknown: true,
    }));
    await submitForm(container);

    const [id, previous, form] = submit.mock.calls[1]!;
    expect(id).toBe('TXN_1');
    expect(previous.kind).toBe('UNCONFIRMED');
    expect(form.get('submission')).toBe(KEY);
    expect(form.get('reason')).toBe(REASON);
    expect(form.get('command')).toBe('DISPUTE');
    await waitFor(() => expect(screen.getByText(/نتیجهٔ روشنی نداشت/)).toBeInTheDocument());
    expect(container.textContent).toContain('COR_ORIGINAL');
  });

  it('a first send whose call fails is unconfirmed — same key, the text as it would be sent', async () => {
    submit.mockRejectedValueOnce(lostResponse());
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, {
      target: { value: `  ${REASON}  ` },
    });
    await submitForm(container);

    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());
    expect(container.textContent).not.toContain('کد پیگیری');
    expect(container.querySelector('[name="submission"]')).toHaveValue(KEY);
    expect(container.querySelector('[name="reason"]')).toHaveValue(REASON);
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
  });
});

describe('a retry whose call itself fails (finding 4)', () => {
  async function unconfirmedThenThrow(probe: { status: number } | Error) {
    submit.mockResolvedValueOnce(unconfirmed());
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());

    if (probe instanceof Error) sessionProbe.mockRejectedValueOnce(probe);
    else sessionProbe.mockResolvedValueOnce(probe);
    submit.mockRejectedValueOnce(lostResponse());
    await submitForm(container);
    return container;
  }

  it('with the session alive: no answer, the same request may still be sent', async () => {
    const container = await unconfirmedThenThrow({ status: 204 });
    await waitFor(() => expect(screen.getByText(/نتیجهٔ روشنی نداشت/)).toBeInTheDocument());
    expect(container.textContent).not.toContain('نشست شما پایان یافته است');
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    expect(sessionProbe).toHaveBeenCalledWith('/auth/session');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('when the probe itself gets no answer: still not "session ended"', async () => {
    const container = await unconfirmedThenThrow(new Error('network'));
    await waitFor(() => expect(screen.getByText(/نتیجهٔ روشنی نداشت/)).toBeInTheDocument());
    expect(container.textContent).not.toContain('نشست شما پایان یافته است');
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
  });

  it('only an authoritative 401 says the session ended, and withdraws the retry', async () => {
    const container = await unconfirmedThenThrow({ status: 401 });
    await waitFor(() => expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument());
    expect(container.textContent).toContain('COR_ORIGINAL');
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
  });
});

describe('remembered across a reload (finding 2)', () => {
  it('is stored before the request leaves, and a reload finds the same key — no fresh form', async () => {
    let storedWhileSending: string | null = null;
    submit.mockImplementationOnce(async () => {
      storedWhileSending = window.sessionStorage.getItem(STORE_KEY);
      return unconfirmed();
    });
    const first = renderForm();
    fireEvent.change(first.container.querySelector('[name="reason"]')!, {
      target: { value: REASON },
    });
    await submitForm(first.container);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());
    expect(storedWhileSending).not.toBeNull();
    expect(JSON.parse(storedWhileSending!)).toMatchObject({ submissionId: KEY, text: REASON });
    first.unmount();

    // The reload: a fresh key was minted for the page, and is not used.
    const reloaded = renderCommands(['DISPUTE']);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());
    expect(reloaded.container.querySelector('[name="submission"]')).toHaveValue(KEY);
    expect(reloaded.container.querySelector('[name="reason"]')).toHaveValue(REASON);
    expect(reloaded.container.textContent).toContain('COR_ORIGINAL');
    expect(reloaded.container.querySelector(`[value="${FRESH}"]`)).toBeNull();
    expect(reloaded.container.querySelector('textarea')).toBeNull();
    expect(await axe(reloaded.container)).toHaveNoViolations();
  });

  it('the resolution case: after a new dispute, the reload offers only the old request under its old key', async () => {
    // A resolution sent under KEY, unconfirmed; meanwhile the payer opened a new
    // dispute, so the record allows RESOLVE_DISPUTE again.
    saveUnresolvedDispute(
      'TXN_1',
      {
        command: 'RESOLVE_DISPUTE',
        submissionId: KEY,
        values: { ...EMPTY_DISPUTE_FORM, resolution: RESOLUTION },
        correlationId: 'COR_RESOLVE',
      },
      BINDING,
    );
    const { container } = renderCommands(['RESOLVE_DISPUTE']);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());
    expect(container.querySelector('[name="submission"]')).toHaveValue(KEY);
    expect(container.querySelector('[name="command"]')).toHaveValue('RESOLVE_DISPUTE');
    expect(container.querySelector('[name="resolution"]')).toHaveValue(RESOLUTION);
    expect(container.querySelector('textarea')).toBeNull();

    submit.mockImplementationOnce(async (_id, previous) => ({
      ...(previous as Extract<DisputeFormState, { kind: 'UNCONFIRMED' }>),
      retryUnknown: true,
    }));
    await submitForm(container);
    const [, , form] = submit.mock.calls[0]!;
    expect(form.get('submission')).toBe(KEY);
    expect(form.get('resolution')).toBe(RESOLUTION);
  });

  it('a confirmed answer forgets it', async () => {
    submit.mockRejectedValueOnce(
      Object.assign(new Error('redirect'), { digest: 'NEXT_REDIRECT;x' }),
    );
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container).catch(() => undefined);
    await waitFor(() => expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull());
  });

  it('a definite refusal of a first send forgets it — it was never in doubt', async () => {
    submit.mockResolvedValueOnce({ kind: 'FORBIDDEN', correlationId: 'C-403' });
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/در اختیار شما نیست/)).toBeInTheDocument());
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('a refused retry does not forget it: the person decides, after seeing the record', async () => {
    saveUnresolvedDispute(
      'TXN_1',
      {
        command: 'DISPUTE',
        submissionId: KEY,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
        correlationId: 'COR_ORIGINAL',
      },
      BINDING,
    );
    const { container } = renderCommands();
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());
    // Before the same request has been tried again, there is no way to put it aside.
    expect(screen.queryByRole('link', { name: /این درخواست را کنار بگذار/ })).toBeNull();

    submit.mockImplementationOnce(async (_id, previous) => ({
      ...(previous as Extract<DisputeFormState, { kind: 'UNCONFIRMED' }>),
      retryRefused: true,
    }));
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/ارسال دوباره رد شد/)).toBeInTheDocument());
    expect(window.sessionStorage.getItem(STORE_KEY)).not.toBeNull();

    const forget = screen.getByRole('link', { name: /این درخواست را کنار بگذار/ });
    expect(forget).toHaveAttribute('href', '/transactions/TXN_1');
    // jsdom does not navigate; the full reload is the browser's part.
    forget.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(forget);
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('past the replay window: shown, never re-sent, and only then may be put aside', async () => {
    const now = Date.now();
    saveUnresolvedDispute(
      'TXN_1',
      {
        command: 'DISPUTE',
        submissionId: KEY,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
        correlationId: 'COR_ORIGINAL',
      },
      BINDING,
      now - (DISPUTE_REPLAY_WINDOW_SECONDS + 1) * 1000,
    );
    const { container } = renderCommands();
    await waitFor(() => expect(screen.getByText(/بیش از یک ساعت پیش/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    expect(screen.getByRole('link', { name: /این درخواست را کنار بگذار/ })).toBeInTheDocument();
    expect(container.querySelector('textarea')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a retry attempted after the window closed in the same mount is not sent', async () => {
    const realNow = Date.now;
    submit.mockResolvedValueOnce(unconfirmed());
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());

    const later = realNow() + (DISPUTE_REPLAY_WINDOW_SECONDS + 5) * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    await submitForm(container);
    expect(submit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText(/بیش از یک ساعت پیش/)).toBeInTheDocument());
  });

  it('from another login: shown, never re-sent (the key is bound to the old login)', async () => {
    saveUnresolvedDispute(
      'TXN_1',
      {
        command: 'DISPUTE',
        submissionId: KEY,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
        correlationId: 'COR_ORIGINAL',
      },
      BINDING,
    );
    renderCommands(['DISPUTE'], { owner: BINDING.owner, session: 'session-tag-2' });
    await waitFor(() => expect(screen.getByText(/نشست پیشین/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
  });

  it('someone else’s entry is never shown, and is removed', async () => {
    saveUnresolvedDispute(
      'TXN_1',
      {
        command: 'DISPUTE',
        submissionId: KEY,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
        correlationId: 'COR_ORIGINAL',
      },
      BINDING,
    );
    const { container } = renderCommands(['DISPUTE'], { owner: 'owner-tag-B', session: 'x' });
    await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());
    expect(container.querySelector('[name="submission"]')).toHaveValue(FRESH);
    expect(container.textContent).not.toContain(REASON);
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
  });

  it('not sent at all when it cannot be remembered', async () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/درخواست ارسال نشد/)).toBeInTheDocument());
    expect(submit).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the first send’s time across the answer, so the window runs from the first send', () => {
    const first = Date.now() - 10_000;
    const dispute = {
      command: 'DISPUTE' as const,
      submissionId: KEY,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
      correlationId: null,
    };
    saveUnresolvedDispute('TXN_1', dispute, BINDING, first);
    saveUnresolvedDispute('TXN_1', { ...dispute, correlationId: 'COR_LATER' }, BINDING);
    expect(restoreUnresolvedDispute('TXN_1', BINDING, SESSION_MAX_AGE)).toMatchObject({
      kind: 'RETRYABLE',
      dispute: { savedAt: first, correlationId: 'COR_LATER' },
    });
  });
});
