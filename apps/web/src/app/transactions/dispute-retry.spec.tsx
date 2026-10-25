import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import {
  markDisputesOpen,
  purgeAllUnresolvedDisputes,
  purgeForeignUnresolvedDisputes,
  restoreUnresolvedDispute,
  saveUnresolvedDispute,
  type ReplayStamp,
  type UnresolvedDispute,
} from '@/lib/unresolved-dispute';

import { DisputeCommandForm } from './[id]/DisputeCommandForm';
import { DisputeCommands } from './[id]/DisputeCommands';
import type { DisputeFormState } from './[id]/form-state';
import { OTHER_PERSON, bindingOf, keyFor } from '@/test/unresolved-binding';
import { QUARANTINE_TITLE } from '@/app/UnresolvedQuarantine';

/**
 * The unconfirmed path with the real `useActionState`: only the action's own
 * body and `/auth/session` are scripted.
 *
 * - the retry posts the same key and the same text;
 * - the submission is remembered **before** it is sent, across a reload, per
 *   transaction and per login, and nothing fresh is offered on that
 *   transaction until it is reconciled (PR 319 review 1, finding 2);
 * - a call that itself fails is "session ended" only when `/auth/session`
 *   says so; otherwise the same request may still be sent (finding 4) — a
 *   `503` (refresh unavailable for now) included (PR 319 review 2, finding 3);
 * - past the session's lifetime, and at logout, the entry is reduced to an
 *   outcome-unknown marker, never removed into fresh controls (review 2,
 *   finding 1);
 * - every send carries the signed replay stamp, and a retry the server refuses
 *   past its deadline stays view-only for good (review 2, finding 2).
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
const BINDING = bindingOf('owner-tag-A', 'session-tag-1');
const SESSION_MAX_AGE = 12 * 60 * 60;
const STORE_KEY = keyFor('rasta.unresolved-dispute.', BINDING, 'TXN_1');
/** What the page signed with the key (`server/dispute-replay.ts`); opaque here. */
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const FRESH_STAMP: ReplayStamp = { token: 'signed-fresh-stamp', until: STAMP.until };

/** What a remembered dispute looks like, as the form saves it. */
function remembered(
  overrides: Partial<Omit<UnresolvedDispute, 'savedAt' | 'marker'>> = {},
): Omit<UnresolvedDispute, 'savedAt' | 'marker'> {
  return {
    command: 'DISPUTE',
    submissionId: KEY,
    values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
    correlationId: 'COR_ORIGINAL',
    replay: STAMP,
    ...overrides,
  };
}

function stored(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(STORE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const lostResponse = () => new Error('An unexpected response was received from the server.');

function renderForm(props: Partial<React.ComponentProps<typeof DisputeCommandForm>> = {}) {
  return render(
    <DisputeCommandForm
      transactionId="TXN_1"
      command="DISPUTE"
      csrfToken="csrf"
      submissionId={KEY}
      replay={STAMP}
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
      submissions={{
        DISPUTE: { id: FRESH, replay: FRESH_STAMP },
        RESOLVE_DISPUTE: { id: FRESH, replay: FRESH_STAMP },
      }}
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
  replay: STAMP,
});

beforeEach(() => {
  submit.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  markDisputesOpen();
});

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
    expect(form.get('replay')).toBe(STAMP.token);
    expect(form.get('reason')).toBe(REASON);
    expect(form.get('command')).toBe('DISPUTE');
    // The first send carried the same stamp: it is never re-issued for a key.
    expect(submit.mock.calls[0]![2].get('replay')).toBe(STAMP.token);
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
      remembered({
        command: 'RESOLVE_DISPUTE',
        values: { ...EMPTY_DISPUTE_FORM, resolution: RESOLUTION },
        correlationId: 'COR_RESOLVE',
      }),
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
    saveUnresolvedDispute('TXN_1', remembered(), BINDING);
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

  it('past the signed replay deadline: shown, never re-sent, and only then may be put aside', async () => {
    saveUnresolvedDispute(
      'TXN_1',
      remembered({ replay: { token: STAMP.token, until: Date.now() - 1 } }),
      BINDING,
    );
    const { container } = renderCommands();
    await waitFor(() =>
      expect(screen.getByText(/مهلت ارسال دوباره‌اش گذشته است/)).toBeInTheDocument(),
    );
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

    jest.spyOn(Date, 'now').mockReturnValue(Math.max(realNow(), STAMP.until) + 5_000);
    await submitForm(container);
    expect(submit).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText(/مهلت ارسال دوباره‌اش گذشته است/)).toBeInTheDocument(),
    );
  });

  it('from another login: shown, never re-sent (the key is bound to the old login)', async () => {
    saveUnresolvedDispute('TXN_1', remembered(), BINDING);
    renderCommands(['DISPUTE'], bindingOf(BINDING.owner, 'session-tag-2'));
    await waitFor(() => expect(screen.getByText(/نشست پیشین/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
  });

  it('someone else’s entry is never shown — they are warned instead — and the account boundary reduces it to a content-free marker', async () => {
    saveUnresolvedDispute('TXN_1', remembered(), BINDING);
    const { container } = renderCommands(['DISPUTE'], bindingOf('owner-tag-B', 'x', OTHER_PERSON));
    // The device quarantine (PR 405 review 2, F1): no fresh form over an unknown outcome.
    await waitFor(() => expect(container.textContent).toContain(QUARANTINE_TITLE));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain(REASON);
    purgeForeignUnresolvedDisputes({ person: OTHER_PERSON, legacy: [] });
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    const markers = Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith('rasta.unresolved-dispute.!q.'),
    );
    expect(markers).toHaveLength(1);
    expect(window.sessionStorage.getItem(markers[0]!)).not.toContain(REASON);
  });

  it('the same person acting for another organization: not shown there, kept for this one (task 100)', async () => {
    saveUnresolvedDispute('TXN_1', remembered(), BINDING);
    const inB = renderCommands(['DISPUTE'], bindingOf('owner-tag-B', 'x'));
    await waitFor(() => expect(inB.container.querySelector('textarea')).not.toBeNull());
    expect(inB.container.textContent).not.toContain(REASON);
    purgeForeignUnresolvedDisputes({ person: BINDING.person, legacy: [] });
    expect(window.sessionStorage.getItem(STORE_KEY)).not.toBeNull();
    inB.unmount();
    // Back on A: the same unresolved command, retryable under its own key.
    expect(restoreUnresolvedDispute('TXN_1', BINDING, SESSION_MAX_AGE)).toMatchObject({
      kind: 'RETRYABLE',
      dispute: { submissionId: KEY },
    });
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

  it('keeps the first send’s time across the answer, so the lifetime runs from the first send', () => {
    const first = Date.now() - 10_000;
    const dispute = remembered({ correlationId: null });
    saveUnresolvedDispute('TXN_1', dispute, BINDING, first);
    saveUnresolvedDispute('TXN_1', { ...dispute, correlationId: 'COR_LATER' }, BINDING);
    expect(restoreUnresolvedDispute('TXN_1', BINDING, SESSION_MAX_AGE)).toMatchObject({
      kind: 'RETRYABLE',
      dispute: { savedAt: first, correlationId: 'COR_LATER' },
    });
  });
});

describe('never silently forgotten: the outcome-unknown marker (PR 319 review 2, finding 1)', () => {
  it('past the session lifetime: reduced to a view-only marker, never fresh controls', async () => {
    // A resolution sent under KEY, response lost; the payer opened a new
    // dispute; the operator signs in again after the stored entry outlived
    // WEB_SESSION_MAX_AGE_SECONDS. A fresh form here would let the old decision
    // resolve the new dispute under a fresh key.
    saveUnresolvedDispute(
      'TXN_1',
      remembered({
        command: 'RESOLVE_DISPUTE',
        values: { ...EMPTY_DISPUTE_FORM, resolution: RESOLUTION },
        correlationId: 'COR_RESOLVE',
      }),
      BINDING,
      Date.now() - (SESSION_MAX_AGE + 1) * 1000,
    );

    const first = renderCommands(['RESOLVE_DISPUTE'], bindingOf(BINDING.owner, 's-new'));
    await waitFor(() =>
      expect(screen.getByText(/متن آن دیگر نگه داشته نمی‌شود/)).toBeInTheDocument(),
    );
    expect(first.container.querySelector('textarea')).toBeNull();
    expect(first.container.querySelector(`[value="${FRESH}"]`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    expect(first.container.textContent).toContain('COR_RESOLVE');
    expect(screen.getByRole('link', { name: /این درخواست را کنار بگذار/ })).toBeInTheDocument();
    expect(await axe(first.container)).toHaveNoViolations();

    // The text, the login tag and the stamp are gone; the marker is not.
    expect(stored()).toMatchObject({ marker: true, submissionId: KEY, owner: BINDING.owner });
    expect(stored()).not.toHaveProperty('text');
    expect(stored()).not.toHaveProperty('session');
    expect(stored()).not.toHaveProperty('replay');
    expect(window.sessionStorage.getItem(STORE_KEY)).not.toContain(RESOLUTION);
    first.unmount();

    // Another reload: still the marker, still no fresh form.
    const again = renderCommands(['RESOLVE_DISPUTE'], bindingOf(BINDING.owner, 's-new'));
    await waitFor(() =>
      expect(screen.getByText(/متن آن دیگر نگه داشته نمی‌شود/)).toBeInTheDocument(),
    );
    expect(again.container.querySelector('textarea')).toBeNull();

    // Only the person's explicit acknowledgement removes it.
    const forget = screen.getByRole('link', { name: /این درخواست را کنار بگذار/ });
    forget.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(forget);
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    again.unmount();

    const acknowledged = renderCommands(['RESOLVE_DISPUTE']);
    await waitFor(() => expect(acknowledged.container.querySelector('textarea')).not.toBeNull());
    expect(acknowledged.container.querySelector('[name="submission"]')).toHaveValue(FRESH);
  });

  it('a marker is never turned back into something that can be re-sent', () => {
    saveUnresolvedDispute(
      'TXN_1',
      remembered(),
      BINDING,
      Date.now() - (SESSION_MAX_AGE + 1) * 1000,
    );
    expect(restoreUnresolvedDispute('TXN_1', BINDING, SESSION_MAX_AGE)?.dispute.marker).toBe(true);

    expect(saveUnresolvedDispute('TXN_1', remembered(), BINDING)).toBe('SAVED');
    expect(restoreUnresolvedDispute('TXN_1', BINDING, SESSION_MAX_AGE)).toMatchObject({
      kind: 'VIEW_ONLY',
      dispute: { marker: true, replay: null },
    });
  });

  it('logout keeps only the marker; the same person sees it after signing in again', async () => {
    saveUnresolvedDispute('TXN_1', remembered(), BINDING);
    purgeAllUnresolvedDisputes();

    expect(stored()).toMatchObject({ marker: true, submissionId: KEY });
    expect(window.sessionStorage.getItem(STORE_KEY)).not.toContain(REASON);
    expect(stored()).not.toHaveProperty('session');

    // Signed in again (`AccountBoundary`): same owner, a new login.
    markDisputesOpen();
    purgeForeignUnresolvedDisputes({ person: BINDING.person, legacy: [] });
    const { container } = renderCommands(['DISPUTE'], bindingOf(BINDING.owner, 's-new'));
    await waitFor(() =>
      expect(screen.getByText(/متن آن دیگر نگه داشته نمی‌شود/)).toBeInTheDocument(),
    );
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('another person’s page removes the marker, as it removes any entry of someone else', () => {
    saveUnresolvedDispute('TXN_1', remembered(), BINDING);
    purgeAllUnresolvedDisputes();
    markDisputesOpen();
    purgeForeignUnresolvedDisputes({ person: OTHER_PERSON, legacy: [] });
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
  });
});

describe('the server’s replay deadline (PR 319 review 2, finding 2)', () => {
  it('a retry refused past the deadline: nothing sent, view-only for good, across a reload', async () => {
    submit.mockResolvedValueOnce(unconfirmed());
    const first = renderForm();
    fireEvent.change(first.container.querySelector('[name="reason"]')!, {
      target: { value: REASON },
    });
    await submitForm(first.container);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());

    // What the action answers when the stamp's signed deadline has passed.
    submit.mockImplementationOnce(async (_id, previous) => ({
      ...(previous as Extract<DisputeFormState, { kind: 'UNCONFIRMED' }>),
      replay: null,
      viewOnly: true,
      replayExpired: true,
    }));
    await submitForm(first.container);
    await waitFor(() =>
      expect(screen.getByText(/مهلت ارسال دوبارهٔ همین درخواست گذشته است/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    expect(screen.getByRole('link', { name: /این درخواست را کنار بگذار/ })).toBeInTheDocument();
    expect(first.container.textContent).toContain('COR_ORIGINAL');
    expect(stored()).toMatchObject({ submissionId: KEY, replay: null });
    first.unmount();

    // Even though the browser's own copy of the deadline had not passed.
    const reloaded = renderCommands(['DISPUTE']);
    await waitFor(() =>
      expect(screen.getByText(/مهلت ارسال دوباره‌اش گذشته است/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    expect(reloaded.container.querySelector('textarea')).toBeNull();

    // And a later save under the same key never brings the stamp back.
    saveUnresolvedDispute('TXN_1', remembered(), BINDING);
    expect(restoreUnresolvedDispute('TXN_1', BINDING, SESSION_MAX_AGE)?.kind).toBe('VIEW_ONLY');
  });

  it('a first send refused for an outdated form: nothing sent, nothing remembered', async () => {
    submit.mockResolvedValueOnce({ kind: 'REFUSED', reason: 'REPLAY' });
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/مهلت این فرم گذشته است/)).toBeInTheDocument());
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    expect(container.querySelector('textarea')).not.toBeNull();
  });
});

describe('a refresh that is only unavailable for now (PR 319 review 2, finding 3)', () => {
  it('a retry whose call fails while /auth/session says 503: unknown, the retry stays', async () => {
    submit.mockResolvedValueOnce(unconfirmed());
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());

    sessionProbe.mockResolvedValueOnce({ status: 503 });
    submit.mockRejectedValueOnce(lostResponse());
    await submitForm(container);

    await waitFor(() => expect(screen.getByText(/نتیجهٔ روشنی نداشت/)).toBeInTheDocument());
    expect(container.textContent).not.toContain('نشست شما پایان یافته است');
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    expect(stored()).toMatchObject({ submissionId: KEY });
  });

  it('a first send whose call fails while /auth/session says 503: unconfirmed, not ended', async () => {
    sessionProbe.mockResolvedValueOnce({ status: 503 });
    submit.mockRejectedValueOnce(lostResponse());
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);

    await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());
    expect(container.textContent).not.toContain('نشست شما پایان یافته است');
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
  });

  it('a first send the action refuses as unavailable: nothing sent, says so, not "ended"', async () => {
    submit.mockResolvedValueOnce({ kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' });
    const { container } = renderForm();
    fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
    await submitForm(container);
    await waitFor(() =>
      expect(screen.getByText(/نشست شما همین حالا در دسترس نیست/)).toBeInTheDocument(),
    );
    expect(container.textContent).not.toContain('نشست شما پایان یافته است');
    expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
  });
});
