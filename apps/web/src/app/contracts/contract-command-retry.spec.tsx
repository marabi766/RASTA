import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import type { ContractCommand } from '@/lib/contract-command-fields';
import {
  clearUnresolvedContractCommand,
  markContractCommandsOpen,
  purgeAllUnresolvedContractCommands,
  purgeForeignUnresolvedContractCommands,
  restoreUnresolvedContractCommand,
  saveUnresolvedContractCommand,
  type ContractScope,
  type ReplayStamp,
} from '@/lib/unresolved-contract-command';
import { AMENDMENT_ID, CONTRACT_ID } from '@/test/contract-command-fixtures';

import { ContractCommandForm } from './[id]/ContractCommandForm';
import { ContractCommands } from './[id]/ContractCommands';
import type { ContractFormState } from './[id]/contract-form-state';
import { OTHER_PERSON, bindingOf, keyFor } from '@/test/unresolved-binding';

/**
 * The unconfirmed path with the real `useActionState`,
 * `statement-retry.spec.tsx` for the contract commands — only the action and
 * `/auth/session` are scripted:
 *
 * - a proposal is remembered **before** it is sent, with what was typed, and a
 *   reload finds it and offers no fresh form (an amendment under a fresh key is
 *   a second amendment);
 * - the retry posts the same key and the same input;
 * - a contract's signature and cancellation share one slot: while one is in
 *   doubt the other draws no button and is never sent, and a definite answer
 *   clears only its own record; another slot is not held by it;
 * - a call that itself fails is "session ended" only when `/auth/session`
 *   answers `401`;
 * - at logout, and past the session's lifetime, the entry becomes a marker;
 *   another person's page removes it.
 */

// Some tests here render forms and run jest-axe; give each room on a loaded runner, as
// `statements.spec.tsx` does (#341).
jest.setTimeout(20_000);

const action = jest.fn<Promise<ContractFormState>, [ContractScope, ContractFormState, FormData]>();
jest.mock('./[id]/contract-actions', () => ({
  submitContractCommand: (s: ContractScope, p: ContractFormState, f: FormData) => action(s, p, f),
}));

const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();

const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const OTHER = 'sub_OTHERKEYOTHERKEYOTH';
const FRESH = 'sub_FRESHKEYFRESHKEYFRE';
const BINDING = bindingOf('owner-tag-A', 'session-tag-1');
const SESSION_MAX_AGE = 12 * 60 * 60;
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const CONTRACT_SLOT: ContractScope = { contractId: CONTRACT_ID, slot: 'CONTRACT', subjectId: null };
const NEW_AMENDMENT: ContractScope = {
  contractId: CONTRACT_ID,
  slot: 'NEW_AMENDMENT',
  subjectId: null,
};
const AMENDMENT: ContractScope = {
  contractId: CONTRACT_ID,
  slot: 'AMENDMENT',
  subjectId: AMENDMENT_ID,
};
const INPUT = { deltaMinor: '2000000', reasonCode: 'SCOPE_CHANGE', reasonText: 'افزایش کار' };
const PAGE = `/contracts/${CONTRACT_ID}`;

const lostResponse = () => new Error('An unexpected response was received from the server.');

function renderForm(scope: ContractScope, command: ContractCommand, submissionId = KEY) {
  return render(
    <ContractCommandForm
      scope={scope}
      command={command}
      csrfToken="csrf"
      submissionId={submissionId}
      replay={STAMP}
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      reasons={[{ code: 'SCOPE_CHANGE', label: 'تغییر دامنهٔ کار' }]}
      pageHref={PAGE}
    />,
  );
}

function fillProposal(container: HTMLElement) {
  const set = (name: string, value: string) =>
    fireEvent.change(container.querySelector(`[name="${name}"]`)!, { target: { value } });
  set('deltaMinor', '۲٬۰۰۰٬۰۰۰');
  set('reasonCode', 'SCOPE_CHANGE');
  set('reasonText', 'افزایش کار');
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    fireEvent.submit(form);
  });
}

const unconfirmed = (): ContractFormState => ({
  kind: 'UNCONFIRMED',
  command: 'PROPOSE_AMENDMENT',
  correlationId: 'COR_ORIGINAL',
  submissionId: KEY,
  input: INPUT,
  replay: STAMP,
});

const storeKey = (scope: ContractScope) =>
  keyFor(
    'rasta.unresolved-contract.',
    BINDING,
    `${scope.contractId}.${scope.slot}.${scope.subjectId ?? '-'}`,
  );

function stored(scope: ContractScope): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(storeKey(scope));
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
  markContractCommandsOpen();
});

describe('a proposal sent and not confirmed', () => {
  it('is remembered before it leaves, with what was typed as it is sent', async () => {
    let seenWhileSending: Record<string, unknown> | null = null;
    action.mockImplementation(async () => {
      seenWhileSending = stored(NEW_AMENDMENT);
      return unconfirmed();
    });
    const { container } = renderForm(NEW_AMENDMENT, 'PROPOSE_AMENDMENT');
    fillProposal(container);
    await submit(container.querySelector('form')!);
    expect(seenWhileSending).toMatchObject({
      submissionId: KEY,
      input: INPUT,
      correlationId: null,
    });
    expect(stored(NEW_AMENDMENT)).toMatchObject({
      submissionId: KEY,
      correlationId: 'COR_ORIGINAL',
    });
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the retry posts the same key and the same input', async () => {
    action.mockResolvedValueOnce(unconfirmed());
    const { container } = renderForm(NEW_AMENDMENT, 'PROPOSE_AMENDMENT');
    fillProposal(container);
    await submit(container.querySelector('form')!);
    action.mockResolvedValueOnce({
      ...(unconfirmed() as object),
      retryUnknown: true,
    } as ContractFormState);
    await submit(container.querySelector('form')!);
    const retry = action.mock.calls[1]![2];
    expect(retry.get('submission')).toBe(KEY);
    expect(retry.get('replay')).toBe(STAMP.token);
    expect(retry.get('deltaMinor')).toBe('2000000');
    expect(retry.get('reasonCode')).toBe('SCOPE_CHANGE');
    expect(retry.get('reasonText')).toBe('افزایش کار');
  });

  it('a reload finds it, and draws no fresh form over it — even where nothing is offered now', async () => {
    saveUnresolvedContractCommand(
      NEW_AMENDMENT,
      {
        command: 'PROPOSE_AMENDMENT',
        submissionId: KEY,
        input: INPUT,
        correlationId: 'COR',
        replay: STAMP,
      },
      BINDING,
    );
    const { container } = render(
      <ContractCommands
        contractId={CONTRACT_ID}
        slot="NEW_AMENDMENT"
        subjectId={null}
        offered={[]}
        context={{
          csrfToken: 'csrf',
          binding: BINDING,
          sessionMaxAgeSeconds: SESSION_MAX_AGE,
          pageHref: PAGE,
        }}
      />,
    );
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(container.querySelector('input[name="submission"]')).toHaveValue(KEY);
    expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
  });

  it('a confirmed answer forgets it', async () => {
    action.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/x;307;' }),
    );
    const { container } = renderForm(NEW_AMENDMENT, 'PROPOSE_AMENDMENT');
    fillProposal(container);
    await submit(container.querySelector('form')!).catch(() => undefined);
    await waitFor(() => expect(stored(NEW_AMENDMENT)).toBeNull());
  });

  it('a lost response is "maybe done", not "session ended", unless /auth/session says 401', async () => {
    action.mockRejectedValue(lostResponse());
    sessionProbe.mockResolvedValue({ status: 503 });
    const first = renderForm(CONTRACT_SLOT, 'SIGN');
    await submit(first.container.querySelector('form')!);
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(first.container.textContent).not.toContain('نشست شما پایان یافته است');
    first.unmount();
    window.sessionStorage.clear();

    sessionProbe.mockResolvedValue({ status: 401 });
    const second = renderForm(CONTRACT_SLOT, 'SIGN');
    await submit(second.container.querySelector('form')!);
    expect(await screen.findByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).not.toBeInTheDocument();
  });

  it('is not sent when it cannot be remembered', async () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { container } = renderForm(NEW_AMENDMENT, 'PROPOSE_AMENDMENT');
    fillProposal(container);
    await submit(container.querySelector('form')!);
    expect(action).not.toHaveBeenCalled();
    expect(await screen.findByText(/دو بار ثبت شود/)).toBeInTheDocument();
  });
});

describe('one slot per object', () => {
  const signInDoubt = {
    command: 'SIGN' as const,
    submissionId: OTHER,
    input: null,
    correlationId: 'COR_SIGN',
    replay: STAMP,
  };

  it('a cancellation is never sent while the signature in the same slot is in doubt', async () => {
    const { container } = renderForm(CONTRACT_SLOT, 'CANCEL');
    saveUnresolvedContractCommand(CONTRACT_SLOT, signInDoubt, BINDING);
    fireEvent.change(container.querySelector('[name="reasonCode"]')!, {
      target: { value: 'SCOPE_CHANGE' },
    });
    await submit(container.querySelector('form')!);
    expect(action).not.toHaveBeenCalled();
    expect(await screen.findByText(/درخواست دیگری روی همین مورد فرستاده شده/)).toBeInTheDocument();
    expect(stored(CONTRACT_SLOT)).toMatchObject({ submissionId: OTHER, command: 'SIGN' });
  });

  it('the page draws the other forms of the slot without a button while one is in doubt', async () => {
    const { container } = render(
      <ContractCommands
        contractId={CONTRACT_ID}
        slot="CONTRACT"
        subjectId={null}
        offered={[
          { command: 'SIGN', side: 'EMPLOYER', submission: { id: OTHER, replay: STAMP } },
          { command: 'CANCEL', submission: { id: FRESH, replay: STAMP } },
        ]}
        context={{
          csrfToken: 'csrf',
          binding: BINDING,
          sessionMaxAgeSeconds: SESSION_MAX_AGE,
          pageHref: PAGE,
        }}
      />,
    );
    await screen.findByRole('form', { name: /امضای قرارداد/ });
    act(() => {
      saveUnresolvedContractCommand(CONTRACT_SLOT, signInDoubt, BINDING);
    });
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'لغو پیش‌نویس قرارداد' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/درخواست دیگری روی همین مورد فرستاده شده/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'لغو پیش‌نویس قرارداد' })).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('another slot is not held: an amendment’s signature is its own', async () => {
    saveUnresolvedContractCommand(CONTRACT_SLOT, signInDoubt, BINDING);
    action.mockResolvedValue({ kind: 'NOT_FOUND' });
    const { container } = renderForm(AMENDMENT, 'SIGN_AMENDMENT');
    await submit(container.querySelector('form')!);
    expect(action).toHaveBeenCalledTimes(1);
    // A definite answer clears this submission's record only.
    expect(stored(AMENDMENT)).toBeNull();
    expect(stored(CONTRACT_SLOT)).toMatchObject({ submissionId: OTHER });
  });

  it('a record in the slot is never replaced by another submission’s, nor cleared by it', () => {
    saveUnresolvedContractCommand(CONTRACT_SLOT, signInDoubt, BINDING);
    expect(
      saveUnresolvedContractCommand(
        CONTRACT_SLOT,
        {
          command: 'CANCEL',
          submissionId: KEY,
          input: { reasonCode: 'OTHER' },
          correlationId: null,
          replay: STAMP,
        },
        BINDING,
      ),
    ).toBe('HELD');
    clearUnresolvedContractCommand(CONTRACT_SLOT, KEY, BINDING);
    expect(stored(CONTRACT_SLOT)).toMatchObject({ submissionId: OTHER, command: 'SIGN' });
  });

  it('a record is kept only in the slot its command belongs to', () => {
    expect(
      saveUnresolvedContractCommand(
        AMENDMENT,
        {
          command: 'CANCEL',
          submissionId: KEY,
          input: { reasonCode: 'OTHER' },
          correlationId: null,
          replay: STAMP,
        },
        BINDING,
      ),
    ).toBe('UNAVAILABLE');
    window.sessionStorage.setItem(
      storeKey(CONTRACT_SLOT),
      JSON.stringify({
        ...signInDoubt,
        command: 'PLAN_MILESTONE',
        v: 1,
        marker: false,
        owner: BINDING.owner,
        session: BINDING.session,
        savedAt: Date.now(),
      }),
    );
    expect(restoreUnresolvedContractCommand(CONTRACT_SLOT, BINDING, SESSION_MAX_AGE)).toBeNull();
  });
});

describe('never silently gone', () => {
  const entry = {
    command: 'SIGN' as const,
    submissionId: KEY,
    input: null,
    correlationId: 'COR',
    replay: STAMP,
  };

  it('at logout an entry becomes a marker: no stamp, no login tag, still blocking', () => {
    saveUnresolvedContractCommand(CONTRACT_SLOT, entry, BINDING);
    purgeAllUnresolvedContractCommands();
    markContractCommandsOpen();
    expect(restoreUnresolvedContractCommand(CONTRACT_SLOT, BINDING, SESSION_MAX_AGE)).toEqual({
      kind: 'VIEW_ONLY',
      entry: expect.objectContaining({ marker: true, replay: null, submissionId: KEY }),
    });
    expect(stored(CONTRACT_SLOT)).not.toHaveProperty('session');
  });

  it('past the session’s lifetime it becomes a marker too', () => {
    saveUnresolvedContractCommand(
      CONTRACT_SLOT,
      entry,
      BINDING,
      Date.now() - (SESSION_MAX_AGE + 1) * 1000,
    );
    expect(
      restoreUnresolvedContractCommand(CONTRACT_SLOT, BINDING, SESSION_MAX_AGE)?.entry.marker,
    ).toBe(true);
  });

  it('nothing is stored once a logout has started', () => {
    purgeAllUnresolvedContractCommands();
    expect(saveUnresolvedContractCommand(CONTRACT_SLOT, entry, BINDING)).toBe('UNAVAILABLE');
  });

  it('from another login it is shown, never re-sent; another person’s page removes it', () => {
    saveUnresolvedContractCommand(CONTRACT_SLOT, entry, BINDING);
    expect(
      restoreUnresolvedContractCommand(
        CONTRACT_SLOT,
        { ...BINDING, session: 'session-tag-2' },
        SESSION_MAX_AGE,
      )?.kind,
    ).toBe('VIEW_ONLY');
    purgeForeignUnresolvedContractCommands({ person: OTHER_PERSON, legacy: [] });
    expect(restoreUnresolvedContractCommand(CONTRACT_SLOT, BINDING, SESSION_MAX_AGE)).toBeNull();
  });

  it('refuses an entry whose input is not what its command sends', () => {
    window.sessionStorage.setItem(
      storeKey(NEW_AMENDMENT),
      JSON.stringify({
        v: 1,
        marker: false,
        command: 'PROPOSE_AMENDMENT',
        submissionId: KEY,
        input: { ...INPUT, deltaMinor: '-1' },
        correlationId: null,
        savedAt: Date.now(),
        replay: STAMP,
        owner: BINDING.owner,
        session: BINDING.session,
      }),
    );
    expect(restoreUnresolvedContractCommand(NEW_AMENDMENT, BINDING, SESSION_MAX_AGE)).toBeNull();
    expect(stored(NEW_AMENDMENT)).toBeNull();
  });
});
