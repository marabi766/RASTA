import { submitThroughSlot, type SlotSubmission } from './fenced-submission';
import type { StartOutcome } from './unresolved-tenancy';

/**
 * The one submit boundary of the fenced forms (PR 405 review 4): what is
 * refused before anything leaves finalizes with no answer and no record
 * (addendum D); every completion after the send — returned or thrown, a first
 * send or a re-send — goes through the same finalization (R5); a key already
 * unresolved is never sent as a first send, nor settled by its answer (R4).
 */

type State =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'HELD' }
  | { readonly kind: 'STORAGE_UNAVAILABLE' }
  | { readonly kind: 'REFUSED' }
  | { readonly kind: 'INVALID' }
  | {
      readonly kind: 'UNCONFIRMED';
      readonly submissionId: string;
      readonly note?: string;
      readonly viewOnly?: true;
    };

const K1 = 'sub_FIRSTKEYFIRSTKEYFIRS';
const K2 = 'sub_SECONDKEYSECONDKEYSE';
const UNCONFIRMED = (submissionId: string, note?: string): State => ({
  kind: 'UNCONFIRMED',
  submissionId,
  ...(note ? { note } : {}),
});

const redirect = () =>
  Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/x;307;' });

let sessionStatus: number | 'NETWORK' = 204;

beforeEach(() => {
  sessionStatus = 204;
  global.fetch = (async () => {
    if (sessionStatus === 'NETWORK') throw new TypeError('fetch failed');
    return { status: sessionStatus };
  }) as unknown as typeof fetch;
});

function harness(
  overrides: Partial<SlotSubmission<State>> & { remembered?: StartOutcome | null } = {},
) {
  const calls = { answer: [] as State[], settle: 0, send: 0, remember: 0 };
  const { remembered = 'SAVED', ...rest } = overrides;
  const submission: SlotSubmission<State> = {
    submissionId: K1,
    retrying: null,
    stored: () => null,
    remember: () => {
      calls.remember += 1;
      return remembered;
    },
    admitRetry: () => null,
    send: async () => {
      calls.send += 1;
      return UNCONFIRMED(K1, 'returned');
    },
    failed: (ended) => ({
      kind: 'UNCONFIRMED',
      submissionId: K1,
      note: ended ? 'ended' : 'thrown',
    }),
    answer: (state) => {
      calls.answer.push(state);
    },
    settle: () => {
      calls.settle += 1;
    },
    held: { kind: 'HELD' },
    unavailable: { kind: 'STORAGE_UNAVAILABLE' },
    ...rest,
  };
  return { submission, calls };
}

describe('before anything leaves: unsent, no answer, no record (addendum D)', () => {
  it.each([
    ['HELD', { kind: 'HELD' }],
    ['UNAVAILABLE', { kind: 'STORAGE_UNAVAILABLE' }],
  ] as const)('remember says %s', async (outcome, expected) => {
    const { submission, calls } = harness({ remembered: outcome });
    await expect(submitThroughSlot(submission)).resolves.toEqual(expected);
    expect(calls).toEqual({ answer: [], settle: 0, send: 0, remember: 1 });
  });

  it('another submission holds the slot: held, nothing remembered or sent', async () => {
    const { submission, calls } = harness({
      stored: () => ({ submissionId: K2, state: UNCONFIRMED(K2) }),
    });
    await expect(submitThroughSlot(submission)).resolves.toEqual({ kind: 'HELD' });
    expect(calls).toEqual({ answer: [], settle: 0, send: 0, remember: 0 });
  });

  it('the slot already keeps this very key: its kept view, never a first send (R4)', async () => {
    const kept = UNCONFIRMED(K1, 'kept');
    const { submission, calls } = harness({ stored: () => ({ submissionId: K1, state: kept }) });
    await expect(submitThroughSlot(submission)).resolves.toBe(kept);
    expect(calls).toEqual({ answer: [], settle: 0, send: 0, remember: 0 });
  });

  it('the store says UNRESOLVED (written since the check): the kept view, unsent', async () => {
    const kept = UNCONFIRMED(K1, 'kept');
    let reads = 0;
    const { submission, calls } = harness({
      remembered: 'UNRESOLVED',
      stored: () => (reads++ === 0 ? null : { submissionId: K1, state: kept }),
    });
    await expect(submitThroughSlot(submission)).resolves.toBe(kept);
    expect(calls.send).toBe(0);
    expect(calls.answer).toEqual([]);
    expect(calls.settle).toBe(0);
  });

  it('UNRESOLVED and nothing readable: held, unsent', async () => {
    const { submission, calls } = harness({ remembered: 'UNRESOLVED' });
    await expect(submitThroughSlot(submission)).resolves.toEqual({ kind: 'HELD' });
    expect(calls.send).toBe(0);
  });

  it('a form the page refuses first: nothing remembered or sent', async () => {
    const { submission, calls } = harness({ check: () => ({ kind: 'INVALID' }) });
    await expect(submitThroughSlot(submission)).resolves.toEqual({ kind: 'INVALID' });
    expect(calls).toEqual({ answer: [], settle: 0, send: 0, remember: 0 });
  });

  it('a re-send the form does not admit comes back as it is, unsent and unanswered', async () => {
    const view = UNCONFIRMED(K1);
    const refused = { ...view, viewOnly: true } as State;
    const { submission, calls } = harness({
      retrying: view as Extract<State, { kind: 'UNCONFIRMED' }>,
      admitRetry: () => refused,
    });
    await expect(submitThroughSlot(submission)).resolves.toBe(refused);
    expect(calls).toEqual({ answer: [], settle: 0, send: 0, remember: 0 });
  });
});

describe('every completion goes through one finalization (R5)', () => {
  const retrying = UNCONFIRMED(K1) as Extract<State, { kind: 'UNCONFIRMED' }>;

  it.each([
    ['a first send answered UNCONFIRMED', {}, 'returned'],
    ['a re-send answered UNCONFIRMED', { retrying }, 'returned'],
    [
      'a first send whose call fails',
      { send: async () => Promise.reject(new Error('lost')) },
      'thrown',
    ],
    [
      'a re-send whose call fails',
      { retrying, send: async () => Promise.reject(new Error('lost')) },
      'thrown',
    ],
  ] as const)('%s: answered, never settled', async (_label, overrides, note) => {
    const { submission, calls } = harness(overrides as Partial<SlotSubmission<State>>);
    const result = await submitThroughSlot(submission);
    expect(result).toMatchObject({ kind: 'UNCONFIRMED', note });
    expect(calls.answer).toEqual([result]);
    expect(calls.settle).toBe(0);
  });

  it.each([
    ['204', 204, 'thrown'],
    ['503', 503, 'thrown'],
    ['a network failure', 'NETWORK', 'thrown'],
    ['401', 401, 'ended'],
  ] as const)(
    'a failed call with /auth/session %s stays uncertain and is answered (addendum F)',
    async (_label, status, note) => {
      sessionStatus = status;
      const { submission, calls } = harness({
        send: async () => Promise.reject(new Error('lost')),
      });
      await expect(submitThroughSlot(submission)).resolves.toMatchObject({
        kind: 'UNCONFIRMED',
        note,
      });
      expect(calls.answer).toHaveLength(1);
      expect(calls.settle).toBe(0);
    },
  );

  it('a definite answer to a first send this send wrote: settled, not answered', async () => {
    const { submission, calls } = harness({ send: async () => ({ kind: 'REFUSED' }) });
    await expect(submitThroughSlot(submission)).resolves.toEqual({ kind: 'REFUSED' });
    expect(calls.settle).toBe(1);
    expect(calls.answer).toEqual([]);
  });

  it('a definite answer to a re-send settles nothing: it proves nothing about the first send', async () => {
    const { submission, calls } = harness({ retrying, send: async () => ({ kind: 'REFUSED' }) });
    await submitThroughSlot(submission);
    expect(calls.settle).toBe(0);
    expect(calls.answer).toEqual([]);
  });

  it('a definite answer to a first send that was never remembered settles nothing', async () => {
    const { submission, calls } = harness({
      remembered: null,
      send: async () => ({ kind: 'INVALID' }),
    });
    await submitThroughSlot(submission);
    expect(calls.settle).toBe(0);
  });

  it('a redirect is the command done: settled, rethrown', async () => {
    const error = redirect();
    const { submission, calls } = harness({ send: async () => Promise.reject(error) });
    await expect(submitThroughSlot(submission)).rejects.toBe(error);
    expect(calls.settle).toBe(1);
    expect(calls.answer).toEqual([]);
  });

  it('a failed call of a first send that was never remembered is rethrown: nothing in doubt to keep', async () => {
    const error = new Error('lost');
    const { submission, calls } = harness({
      remembered: null,
      send: async () => Promise.reject(error),
    });
    await expect(submitThroughSlot(submission)).rejects.toBe(error);
    expect(calls.answer).toEqual([]);
    expect(calls.settle).toBe(0);
  });
});
