import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import { REASON_FIELD, quantityField } from '@/lib/return-fields';
import {
  clearUnresolvedReturn,
  markReturnsOpen,
  purgeAllUnresolvedReturns,
  purgeForeignUnresolvedReturns,
  restoreUnresolvedReturn,
  saveUnresolvedReturn,
  type ReplayStamp,
  type ReturnScope,
} from '@/lib/unresolved-return';
import { LINE_A, LINE_B, ORDER_ID, RETURN_ID } from '@/test/return-fixtures';

import { ReturnCommandForm } from './ReturnCommandForm';
import { ReturnCommands } from './ReturnCommands';
import type { ReturnFormState } from './return-form-state';
import { OTHER_PERSON, bindingOf, keyFor } from '@/test/unresolved-binding';

/**
 * The unconfirmed path with the real `useActionState` — the statement and
 * dispute retry specs, for the return commands; only the actions and
 * `/auth/session` are scripted:
 *
 * - a request is remembered **before** it is sent, with the body it sends, and
 *   a reload finds it and offers no fresh request form (a request under a
 *   fresh key is a second request for the same goods);
 * - the retry posts the same key and the same body;
 * - a call that itself fails is "session ended" only when `/auth/session`
 *   answers `401`; a `503` (refresh unavailable for now) is not;
 * - at logout, and past the session's lifetime, the entry becomes a marker;
 *   another person's page removes it;
 * - a request's authorize, reject and cancel commands share one slot: a lost
 *   authorization is never replaced, or cleared, by a rejection.
 */

const request = jest.fn<Promise<ReturnFormState>, [string, ReturnFormState, FormData]>();
const command = jest.fn<Promise<ReturnFormState>, [string, ReturnFormState, FormData]>();
jest.mock('./return-actions', () => ({
  submitReturnRequest: (o: string, p: ReturnFormState, f: FormData) => request(o, p, f),
  submitReturnCommand: (r: string, p: ReturnFormState, f: FormData) => command(r, p, f),
}));

const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();

const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const FRESH = 'sub_FRESHKEYFRESHKEYFRE';
const BINDING = bindingOf('owner-tag-A', 'session-tag-1');
const SESSION_MAX_AGE = 12 * 60 * 60;
const ORDER_SCOPE: ReturnScope = { kind: 'ORDER', orderId: ORDER_ID };
const RETURN_SCOPE: ReturnScope = { kind: 'RETURN', returnId: RETURN_ID };
const ORDER_SLOT = keyFor('rasta.unresolved-return.', BINDING, `order.${ORDER_ID}`);
const RETURN_SLOT = keyFor('rasta.unresolved-return.', BINDING, `return.${RETURN_ID}`);
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const REASON = 'سه کیسه از شن رسیده خیس بود.';
const BODY = { reason: REASON, lines: [{ orderLineId: LINE_A, quantity: 3 }] };
const LINES = [
  { orderLineId: LINE_A, productName: 'شن و ماسه', sold: 10, available: 10 },
  { orderLineId: LINE_B, productName: 'سیمان', sold: 20, available: 20 },
];

const lostResponse = () => new Error('An unexpected response was received from the server.');

function renderRequestForm() {
  return render(
    <ReturnCommandForm
      scope={ORDER_SCOPE}
      command="REQUEST"
      csrfToken="csrf"
      submissionId={KEY}
      replay={STAMP}
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      lines={LINES}
      pageHref={`/orders/${ORDER_ID}`}
    />,
  );
}

/** What the order page draws: what a reload brings back. */
function renderRequestCommands() {
  return render(
    <ReturnCommands
      scope={ORDER_SCOPE}
      offered={[{ command: 'REQUEST', submission: { id: FRESH, replay: STAMP } }]}
      csrfToken="csrf"
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      lines={LINES}
      pageHref={`/orders/${ORDER_ID}`}
    />,
  );
}

function fill(container: HTMLElement, reason = REASON, quantity = '۳') {
  fireEvent.change(container.querySelector(`[name="${REASON_FIELD}"]`)!, {
    target: { value: reason },
  });
  fireEvent.change(container.querySelector(`[name="${quantityField(LINE_A)}"]`)!, {
    target: { value: quantity },
  });
}

async function submit(target: HTMLElement | null) {
  await act(async () => {
    fireEvent.submit(target as HTMLElement);
  });
}

const unconfirmedRequest = (correlationId: string | null = 'COR_ORIGINAL'): ReturnFormState => ({
  kind: 'UNCONFIRMED',
  command: 'REQUEST',
  correlationId,
  submissionId: KEY,
  body: BODY,
  replay: STAMP,
});

function stored(key = ORDER_SLOT): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  request.mockReset();
  command.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  markReturnsOpen();
});

describe('a return request sent and not confirmed', () => {
  it('is remembered before it leaves, with the body it sends', async () => {
    let seenWhileSending: Record<string, unknown> | null = null;
    request.mockImplementation(async () => {
      seenWhileSending = stored();
      return unconfirmedRequest();
    });
    const { container } = renderRequestForm();
    fill(container);
    await submit(container.querySelector('form'));
    expect(seenWhileSending).toMatchObject({ submissionId: KEY, body: BODY, correlationId: null });
    expect(stored()).toMatchObject({
      submissionId: KEY,
      body: BODY,
      correlationId: 'COR_ORIGINAL',
    });
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is checked here first: a quantity over what the line allows is never sent', async () => {
    const { container } = renderRequestForm();
    fill(container, REASON, '11');
    await submit(container.querySelector('form'));
    expect(request).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(await screen.findByText(/حداکثر ۱۰ واحد/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the retry posts the same key and the same body', async () => {
    request.mockResolvedValueOnce(unconfirmedRequest());
    const { container } = renderRequestForm();
    fill(container);
    await submit(container.querySelector('form'));
    request.mockResolvedValueOnce({
      ...(unconfirmedRequest() as object),
      retryUnknown: true,
    } as ReturnFormState);
    await submit(container.querySelector('form'));
    const retry = request.mock.calls[1]![2];
    expect(retry.get('submission')).toBe(KEY);
    expect(retry.get('replay')).toBe(STAMP.token);
    expect(retry.get(REASON_FIELD)).toBe(REASON);
    expect(retry.get(quantityField(LINE_A))).toBe('3');
    expect(retry.get(quantityField(LINE_B))).toBeNull();
  });

  it('a reload finds it, and draws no fresh request form over it', async () => {
    saveUnresolvedReturn(
      ORDER_SCOPE,
      { command: 'REQUEST', submissionId: KEY, body: BODY, correlationId: 'COR', replay: STAMP },
      BINDING,
    );
    const { container } = renderRequestCommands();
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(container.querySelector('input[name="submission"]')).toHaveValue(KEY);
    expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
  });

  it('a confirmed answer forgets it', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/x;307;',
    });
    request.mockRejectedValue(redirect);
    const { container } = renderRequestForm();
    fill(container);
    await submit(container.querySelector('form')).catch(() => undefined);
    await waitFor(() => expect(stored()).toBeNull());
  });

  it('a lost response is "maybe done", not "session ended", unless /auth/session says 401', async () => {
    request.mockRejectedValue(lostResponse());
    sessionProbe.mockResolvedValue({ status: 503 });
    const first = renderRequestForm();
    fill(first.container);
    await submit(first.container.querySelector('form'));
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(first.container.textContent).not.toContain('نشست شما پایان یافته است');
    first.unmount();
    window.sessionStorage.clear();

    sessionProbe.mockResolvedValue({ status: 401 });
    const second = renderRequestForm();
    fill(second.container);
    await submit(second.container.querySelector('form'));
    expect(await screen.findByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).not.toBeInTheDocument();
  });

  it('is not sent when it cannot be remembered', async () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { container } = renderRequestForm();
    fill(container);
    await submit(container.querySelector('form'));
    expect(request).not.toHaveBeenCalled();
    expect(await screen.findByText(/دو بار ثبت شود/)).toBeInTheDocument();
  });
});

describe('never silently gone', () => {
  const entry = {
    command: 'AUTHORIZE' as const,
    submissionId: KEY,
    body: null,
    correlationId: 'COR',
    replay: STAMP,
  };

  it('at logout an entry becomes a marker: no stamp, no login tag, still blocking', () => {
    saveUnresolvedReturn(RETURN_SCOPE, entry, BINDING);
    purgeAllUnresolvedReturns();
    markReturnsOpen();
    expect(restoreUnresolvedReturn(RETURN_SCOPE, BINDING, SESSION_MAX_AGE)).toEqual({
      kind: 'VIEW_ONLY',
      entry: expect.objectContaining({ marker: true, replay: null, submissionId: KEY }),
    });
    expect(stored(RETURN_SLOT)).not.toHaveProperty('session');
  });

  it('past the session’s lifetime it becomes a marker too', () => {
    saveUnresolvedReturn(RETURN_SCOPE, entry, BINDING, Date.now() - (SESSION_MAX_AGE + 1) * 1000);
    expect(restoreUnresolvedReturn(RETURN_SCOPE, BINDING, SESSION_MAX_AGE)?.entry.marker).toBe(
      true,
    );
  });

  it('nothing is stored once a logout has started', () => {
    purgeAllUnresolvedReturns();
    expect(saveUnresolvedReturn(RETURN_SCOPE, entry, BINDING)).toBe('UNAVAILABLE');
  });

  it('from another login it is shown, never re-sent; another person’s page removes it', () => {
    saveUnresolvedReturn(RETURN_SCOPE, entry, BINDING);
    expect(
      restoreUnresolvedReturn(
        RETURN_SCOPE,
        { ...BINDING, session: 'session-tag-2' },
        SESSION_MAX_AGE,
      )?.kind,
    ).toBe('VIEW_ONLY');
    purgeForeignUnresolvedReturns({ person: OTHER_PERSON, legacy: [] });
    expect(restoreUnresolvedReturn(RETURN_SCOPE, BINDING, SESSION_MAX_AGE)).toBeNull();
  });

  it('refuses an entry that is not what its slot holds', () => {
    // A decision kept in an order's slot, a request without its body.
    for (const value of [
      { command: 'AUTHORIZE', body: null },
      { command: 'REQUEST', body: null },
      {
        command: 'REQUEST',
        body: { reason: REASON, lines: [{ orderLineId: LINE_A, quantity: 0 }] },
      },
    ]) {
      window.sessionStorage.setItem(
        ORDER_SLOT,
        JSON.stringify({
          v: 1,
          marker: false,
          scope: `order.${ORDER_ID}`,
          submissionId: KEY,
          correlationId: null,
          savedAt: Date.now(),
          replay: STAMP,
          owner: BINDING.owner,
          session: BINDING.session,
          ...value,
        }),
      );
      expect(restoreUnresolvedReturn(ORDER_SCOPE, BINDING, SESSION_MAX_AGE)).toBeNull();
      expect(stored()).toBeNull();
    }
  });
});

/**
 * A request's authorize and reject forms share one slot (the PR 332 review 1
 * finding, for returns): an authorization whose answer is lost must keep its
 * record, its key and its warning whatever is done with the reject form — and
 * through a reload.
 */
describe('one unresolved command per return request', () => {
  const AUTHORIZE_KEY = 'sub_AUTHORIZEKEYAUTHORIZ';
  const REJECT_KEY = 'sub_REJECTKEYREJECTKEYRE';
  const AUTHORIZE_STAMP: ReplayStamp = { token: 'authorize-stamp', until: STAMP.until };
  const REJECT_STAMP: ReplayStamp = { token: 'reject-stamp', until: STAMP.until };
  const slot = () => stored(RETURN_SLOT) as { submissionId: string; command: string } | null;

  function renderDecisions(submissions = { authorize: AUTHORIZE_KEY, reject: REJECT_KEY }) {
    return render(
      <ReturnCommands
        scope={RETURN_SCOPE}
        offered={[
          {
            command: 'AUTHORIZE',
            submission: { id: submissions.authorize, replay: AUTHORIZE_STAMP },
          },
          { command: 'REJECT', submission: { id: submissions.reject, replay: REJECT_STAMP } },
        ]}
        csrfToken="csrf"
        binding={BINDING}
        sessionMaxAgeSeconds={SESSION_MAX_AGE}
        pageHref={`/returns/${RETURN_ID}`}
      />,
    );
  }

  const formOf = (name: string) => screen.queryByRole('form', { name });

  async function loseTheAuthorization() {
    command.mockRejectedValueOnce(lostResponse());
    const view = renderDecisions();
    await submit(await screen.findByRole('form', { name: 'پذیرفتن بازگشت' }));
    await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' });
    return view;
  }

  it('while the authorization is in doubt, the reject form is view-only with the uncertainty notice', async () => {
    const { container } = await loseTheAuthorization();
    expect(slot()).toMatchObject({ submissionId: AUTHORIZE_KEY, command: 'AUTHORIZE' });
    expect(formOf('رد درخواست بازگشت')).toBeNull();
    const held = screen.getByRole('region', { name: 'رد درخواست بازگشت' });
    expect(held).toHaveTextContent('نتیجه‌اش هنوز معلوم نیست');
    expect(held.querySelector('button')).toBeNull();
    expect(container.querySelector(`input[value="${REJECT_KEY}"]`)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a reject sent anyway is refused here: nothing sent, the authorization’s record untouched', async () => {
    saveUnresolvedReturn(
      RETURN_SCOPE,
      {
        command: 'AUTHORIZE',
        submissionId: AUTHORIZE_KEY,
        body: null,
        correlationId: null,
        replay: AUTHORIZE_STAMP,
      },
      BINDING,
    );
    // The reject form as it was drawn before the authorization was in doubt.
    const { container } = render(
      <ReturnCommandForm
        scope={RETURN_SCOPE}
        command="REJECT"
        csrfToken="csrf"
        submissionId={REJECT_KEY}
        replay={REJECT_STAMP}
        binding={BINDING}
        sessionMaxAgeSeconds={SESSION_MAX_AGE}
        pageHref="/x"
      />,
    );
    await submit(container.querySelector('form'));
    expect(command).not.toHaveBeenCalled();
    expect(await screen.findByText(/نتیجه‌اش هنوز معلوم نیست/)).toBeInTheDocument();
    expect(slot()).toMatchObject({ submissionId: AUTHORIZE_KEY, command: 'AUTHORIZE' });
  });

  it('the authorization’s retry still sends its original key and stamp', async () => {
    await loseTheAuthorization();
    command.mockResolvedValueOnce({
      kind: 'UNCONFIRMED',
      command: 'AUTHORIZE',
      correlationId: null,
      submissionId: AUTHORIZE_KEY,
      body: null,
      replay: AUTHORIZE_STAMP,
      retryUnknown: true,
    });
    await submit(
      screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }).closest('form'),
    );
    const retry = command.mock.calls[1]![2];
    expect(retry.get('submission')).toBe(AUTHORIZE_KEY);
    expect(retry.get('replay')).toBe(AUTHORIZE_STAMP.token);
    expect(slot()).toMatchObject({ submissionId: AUTHORIZE_KEY });
  });

  it('a reload keeps it: only the authorization’s uncertainty view, under its original key', async () => {
    const first = await loseTheAuthorization();
    first.unmount();
    const { container } = renderDecisions({
      authorize: 'sub_FRESHAUTHORIZEFRESHAU',
      reject: 'sub_FRESHREJECTFRESHREJ',
    });
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(container.querySelector('input[name="submission"]')).toHaveValue(AUTHORIZE_KEY);
    expect(formOf('رد درخواست بازگشت')).toBeNull();
    expect(container.querySelector('input[value="sub_FRESHREJECTFRESHREJ"]')).toBeNull();
  });

  it('a definite answer to the authorization’s own first send frees the reject form', async () => {
    command.mockResolvedValueOnce({
      kind: 'INVALID',
      command: 'AUTHORIZE',
      submissionId: AUTHORIZE_KEY,
      values: null,
      fieldErrors: {},
      message: 'refused',
    });
    renderDecisions();
    await submit(await screen.findByRole('form', { name: 'پذیرفتن بازگشت' }));
    expect(slot()).toBeNull();
    expect(await screen.findByRole('form', { name: 'رد درخواست بازگشت' })).toBeInTheDocument();
  });

  it('the slot is never replaced, and cleared only by the submission it belongs to', () => {
    const authorize = {
      command: 'AUTHORIZE' as const,
      submissionId: AUTHORIZE_KEY,
      body: null,
      correlationId: 'COR',
      replay: AUTHORIZE_STAMP,
    };
    expect(saveUnresolvedReturn(RETURN_SCOPE, authorize, BINDING)).toBe('SAVED');
    for (const other of ['REJECT', 'CANCEL'] as const) {
      expect(
        saveUnresolvedReturn(
          RETURN_SCOPE,
          { ...authorize, command: other, submissionId: REJECT_KEY },
          BINDING,
        ),
      ).toBe('HELD');
    }
    clearUnresolvedReturn(RETURN_SCOPE, REJECT_KEY, BINDING);
    expect(slot()).toMatchObject({ submissionId: AUTHORIZE_KEY, command: 'AUTHORIZE' });
    clearUnresolvedReturn(RETURN_SCOPE, AUTHORIZE_KEY, BINDING);
    expect(slot()).toBeNull();
  });

  it('an order’s request slot and its requests’ slots are separate', () => {
    saveUnresolvedReturn(
      ORDER_SCOPE,
      { command: 'REQUEST', submissionId: KEY, body: BODY, correlationId: null, replay: STAMP },
      BINDING,
    );
    expect(
      saveUnresolvedReturn(
        RETURN_SCOPE,
        {
          command: 'CANCEL',
          submissionId: REJECT_KEY,
          body: null,
          correlationId: null,
          replay: STAMP,
        },
        BINDING,
      ),
    ).toBe('SAVED');
    // And a command is never kept in the other kind of slot.
    expect(
      saveUnresolvedReturn(
        ORDER_SCOPE,
        { command: 'CANCEL', submissionId: KEY, body: null, correlationId: null, replay: STAMP },
        BINDING,
      ),
    ).toBe('UNAVAILABLE');
  });
});
