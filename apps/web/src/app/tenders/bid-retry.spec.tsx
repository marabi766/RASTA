import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { PRICE_FIELD, answerField } from '@/lib/bid-fields';
import {
  answerUnresolvedBid,
  markBidsOpen,
  purgeAllUnresolvedBids,
  purgeForeignUnresolvedBids,
  restoreUnresolvedBid,
  saveUnresolvedBid,
  type ReplayStamp,
} from '@/lib/unresolved-bid';
import { OPEN_TENDER, TENDER_ID } from '@/test/bid-fixtures';

import { BidCommandForm } from './[id]/BidCommandForm';
import { BidCommands } from './[id]/BidCommands';
import type { BidFormState } from './[id]/bid-form-state';
import { OTHER_PERSON, bindingOf, keyFor } from '@/test/unresolved-binding';
import type { Binding } from '@/lib/unresolved-tenancy';
import { QUARANTINE_TITLE } from '@/app/UnresolvedQuarantine';

// Each test renders a form and may run jest-axe over it (#341): room to finish.
jest.setTimeout(20_000);

/**
 * The unconfirmed path with the real `useActionState` — only the action and
 * `/auth/session` are scripted:
 *
 * - a command is remembered **before** it is sent — that it was sent, never
 *   what: no price, no answer, no note reaches storage;
 * - in the page, the retry posts the same key and the same content;
 * - after a reload the record is shown, view-only, instead of any fresh form,
 *   until the person sets it aside;
 * - the tender's three forms share one slot: another submission's record is
 *   never replaced, and a form waits while it is held;
 * - a logout writes nothing more; another person's page removes the record.
 */

const action = jest.fn<Promise<BidFormState>, [string, BidFormState, FormData]>();
jest.mock('./[id]/bid-actions', () => ({
  submitBidCommand: (t: string, p: BidFormState, f: FormData) => action(t, p, f),
}));

const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();

const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const OTHER = 'sub_OTHERKEYOTHERKEYOTH';
const FRESH = 'sub_FRESHKEYFRESHKEYFRE';
const OWNER = 'owner-tag-A';
const ACCOUNT = bindingOf(OWNER, 'session-tag-1');
const STORE_KEY = keyFor('rasta.unresolved-bid.', ACCOUNT, TENDER_ID);
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const PAGE = `/tenders/${TENDER_ID}?view=open`;
const CRITERIA = OPEN_TENDER.criteria.map(({ code, label }) => ({ code, label }));
const PRICE = '۴٬۲۰۰٬۰۰۰٬۰۰۰';
const ANSWER = 'روش اجرا با ماشین‌آلات خودی';

const lostResponse = () => new Error('An unexpected response was received from the server.');

function renderForm(command: 'SUBMIT' | 'REVISE' | 'WITHDRAW' = 'SUBMIT', submissionId = KEY) {
  return render(
    <BidCommandForm
      tenderId={TENDER_ID}
      command={command}
      criteria={CRITERIA}
      csrfToken="csrf"
      submissionId={submissionId}
      replay={STAMP}
      account={ACCOUNT}
      pageHref={PAGE}
    />,
  );
}

/** What the tender page draws: what a reload brings back. */
function renderCommands(account: Binding = ACCOUNT) {
  return render(
    <BidCommands
      tenderId={TENDER_ID}
      offered={[{ command: 'SUBMIT', submission: { id: FRESH, replay: STAMP } }]}
      criteria={CRITERIA}
      csrfToken="csrf"
      account={account}
      pageHref={PAGE}
    />,
  );
}

function fill(container: HTMLElement) {
  fireEvent.change(container.querySelector(`[name="${PRICE_FIELD}"]`)!, {
    target: { value: PRICE },
  });
  fireEvent.change(container.querySelector(`[name="${answerField(0)}"]`)!, {
    target: { value: ANSWER },
  });
}

async function submit(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

const unconfirmed = (form: FormData): BidFormState => ({
  kind: 'UNCONFIRMED',
  command: 'SUBMIT',
  correlationId: 'COR_ORIGINAL',
  submissionId: KEY,
  values: {
    priceMinor: String(form.get(PRICE_FIELD)),
    note: '',
    answers: [{ criterionCode: 'technical', response: String(form.get(answerField(0))) }],
  },
  replay: STAMP,
});

function stored(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(STORE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  action.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  markBidsOpen();
});

describe('a bid sent and not confirmed', () => {
  it('is remembered before it leaves — that it was sent, never the price or the answers', async () => {
    let seenWhileSending: Record<string, unknown> | null = null;
    action.mockImplementation(async (_t, _p, form) => {
      seenWhileSending = stored();
      return unconfirmed(form);
    });
    const { container } = renderForm();
    fill(container);
    await submit(container);

    expect(seenWhileSending).toMatchObject({
      command: 'SUBMIT',
      submissionId: KEY,
      correlationId: null,
    });
    expect(stored()).toMatchObject({
      command: 'SUBMIT',
      submissionId: KEY,
      correlationId: 'COR_ORIGINAL',
    });
    const everything = JSON.stringify(window.sessionStorage);
    for (const secret of [PRICE, '4200000000', ANSWER]) {
      expect(JSON.stringify(stored())).not.toContain(secret);
      expect(everything).not.toContain(secret);
    }
    expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('in the page, the retry posts the same key and the same content', async () => {
    action.mockImplementation(async (_t, _p, form) => unconfirmed(form));
    const { container } = renderForm();
    fill(container);
    await submit(container);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }));
    });

    expect(action).toHaveBeenCalledTimes(2);
    const [first, second] = action.mock.calls.map(([, , form]) => form);
    expect(second!.get('submission')).toBe(KEY);
    expect(second!.get('replay')).toBe(STAMP.token);
    expect(second!.get(PRICE_FIELD)).toBe(first!.get(PRICE_FIELD));
    expect(second!.get(answerField(0))).toBe(first!.get(answerField(0)));
    expect(second!.get('criterion.0')).toBe('technical');
  });

  it('a call that fails is "session ended" only on a 401 from /auth/session', async () => {
    action.mockRejectedValue(lostResponse());
    sessionProbe.mockResolvedValue({ status: 503 });
    const { container } = renderForm();
    fill(container);
    await submit(container);
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeInTheDocument();
    expect(screen.queryByText(/نشست شما پایان یافته است/)).toBeNull();

    sessionProbe.mockResolvedValue({ status: 401 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }));
    });
    expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
  });

  it('a withdrawal whose call was lost is remembered, view-only, never sent again', async () => {
    action.mockRejectedValue(lostResponse());
    sessionProbe.mockResolvedValue({ status: 503 });
    const { container } = renderForm('WITHDRAW');
    await submit(container);
    expect(stored()).toMatchObject({ command: 'WITHDRAW', submissionId: KEY });
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    expect(screen.getByRole('link', { name: /کنار بگذار/ })).toBeInTheDocument();
    await submit(container);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('a definite answer to the first send drops its record', async () => {
    action.mockResolvedValue({
      kind: 'INVALID',
      command: 'SUBMIT',
      submissionId: KEY,
      values: null,
      fieldErrors: {},
      message: 'refused',
    });
    const { container } = renderForm();
    fill(container);
    await submit(container);
    expect(stored()).toBeNull();
  });

  it('a content that would be refused unsent is not remembered', async () => {
    let seen: Record<string, unknown> | null = { sentinel: true };
    action.mockImplementation(async () => {
      seen = stored();
      return {
        kind: 'INVALID',
        command: 'SUBMIT',
        submissionId: KEY,
        values: null,
        fieldErrors: { [PRICE_FIELD]: 'x' },
        message: null,
      };
    });
    const { container } = renderForm();
    // No price: the action refuses it unsent, so there is nothing in doubt.
    await submit(container);
    expect(seen).toBeNull();
    expect(stored()).toBeNull();
  });
});

describe('after a reload', () => {
  it('the record is shown view-only instead of a fresh form, until set aside', async () => {
    saveUnresolvedBid(
      TENDER_ID,
      { command: 'SUBMIT', submissionId: KEY, correlationId: 'COR_ORIGINAL' },
      ACCOUNT,
    );
    const { container } = renderCommands();
    expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
    expect(screen.getByText(/نگه داشته نمی‌شود/)).toBeInTheDocument();
    expect(screen.getByText(/COR_ORIGINAL/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    const aside = screen.getByRole('link', { name: /این درخواست را کنار بگذار/ });
    expect(aside).toHaveAttribute('href', PAGE);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(aside);
    expect(stored()).toBeNull();
  });

  it('another person’s page never shows it — it is warned instead — and the account boundary reduces it to a content-free marker', () => {
    saveUnresolvedBid(
      TENDER_ID,
      { command: 'SUBMIT', submissionId: KEY, correlationId: null },
      ACCOUNT,
    );
    const { container, unmount } = renderCommands(
      bindingOf('owner-tag-B', 'session-tag-B', OTHER_PERSON),
    );
    // The device quarantine (PR 405 review 2, F1): no fresh form over an unknown outcome, nothing of it shown.
    expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
    expect(container.textContent).toContain(QUARANTINE_TITLE);
    expect(container.textContent).not.toContain(KEY);
    unmount();

    purgeForeignUnresolvedBids({ person: OTHER_PERSON, legacy: [] });
    expect(stored()).toBeNull();
    const markers = Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith('rasta.unresolved-bid.!q.'),
    );
    expect(markers).toHaveLength(1);
    expect(window.sessionStorage.getItem(markers[0]!)).not.toContain(KEY);
  });

  it('an entry that is not one of ours — content in it included — is never shown, and kept as it is (quarantined)', () => {
    window.sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        v: 1,
        command: 'SUBMIT',
        submissionId: KEY,
        correlationId: null,
        savedAt: 1,
        owner: OWNER,
        priceMinor: '1',
      }),
    );
    const raw = window.sessionStorage.getItem(STORE_KEY);
    expect(restoreUnresolvedBid(TENDER_ID, ACCOUNT)).toBeNull();
    expect(window.sessionStorage.getItem(STORE_KEY)).toBe(raw);
  });
});

describe('one slot per tender', () => {
  it('another submission’s record is never replaced, and that form is not sent', async () => {
    saveUnresolvedBid(
      TENDER_ID,
      { command: 'REVISE', submissionId: OTHER, correlationId: 'COR_OTHER' },
      ACCOUNT,
    );
    const { container } = renderForm('WITHDRAW');
    await submit(container);
    expect(action).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ submissionId: OTHER, command: 'REVISE' });
    expect(screen.getByText(/درخواست دیگری روی پیشنهاد همین مناقصه/)).toBeInTheDocument();
  });

  it('saving another submission into a held slot is refused, the record left as it was', () => {
    saveUnresolvedBid(
      TENDER_ID,
      { command: 'REVISE', submissionId: OTHER, correlationId: 'COR_OTHER' },
      ACCOUNT,
      1000,
    );
    expect(
      saveUnresolvedBid(
        TENDER_ID,
        { command: 'WITHDRAW', submissionId: KEY, correlationId: null },
        ACCOUNT,
      ),
    ).toBe('HELD');
    expect(stored()).toEqual({
      v: 1,
      command: 'REVISE',
      submissionId: OTHER,
      correlationId: 'COR_OTHER',
      savedAt: 1000,
      owner: OWNER,
    });
    // Its own submission's later answer may update it; the first send's time stays.
    // A first send of it again is not one (review 4, R4): nothing written.
    expect(
      saveUnresolvedBid(
        TENDER_ID,
        { command: 'REVISE', submissionId: OTHER, correlationId: 'COR_2' },
        ACCOUNT,
      ),
    ).toBe('UNRESOLVED');
    expect(
      answerUnresolvedBid(
        TENDER_ID,
        { command: 'REVISE', submissionId: OTHER, correlationId: 'COR_2' },
        ACCOUNT,
      ),
    ).toBe('SAVED');
    expect(stored()).toMatchObject({ correlationId: 'COR_2', savedAt: 1000 });
  });

  it('a held form draws no button', () => {
    render(
      <BidCommandForm
        tenderId={TENDER_ID}
        command="WITHDRAW"
        criteria={CRITERIA}
        csrfToken="csrf"
        submissionId={KEY}
        replay={STAMP}
        account={ACCOUNT}
        pageHref={PAGE}
        heldBy={OTHER}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('at logout', () => {
  it('nothing is written any more, and the marker stays — it holds nothing of the bid', () => {
    saveUnresolvedBid(
      TENDER_ID,
      { command: 'SUBMIT', submissionId: KEY, correlationId: null },
      ACCOUNT,
    );
    purgeAllUnresolvedBids();
    expect(stored()).toMatchObject({ submissionId: KEY });
    expect(
      saveUnresolvedBid(
        'TND_OTHER',
        { command: 'SUBMIT', submissionId: OTHER, correlationId: null },
        ACCOUNT,
      ),
    ).toBe('UNAVAILABLE');
  });
});
