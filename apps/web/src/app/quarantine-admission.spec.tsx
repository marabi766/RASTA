import { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { answerUnresolvedOrder, orderQuarantine } from '@/lib/unresolved-order';
import type { AckOutcome, Held, QuarantineSource } from '@/lib/unresolved-tenancy';
import { bindingOf } from '@/test/unresolved-binding';

import {
  QUARANTINE_ACK_FAILED,
  QUARANTINE_CONFIRM,
  QUARANTINE_CONTINUE,
  QUARANTINE_TITLE,
  QuarantineGate,
} from './UnresolvedQuarantine';

/**
 * The gate's admission lifecycle (PR 405 review 4, R4; PM addendum E): the
 * form is admitted only on a fresh read that finds nothing held — at mount or
 * right after an acknowledgement — and once admitted it stays mounted across
 * every later hold, the warning drawn beside it. A changed record, a failed or
 * unread-back acknowledgement, a new generation or a memory hold keeps it out;
 * another identity starts over and never inherits the form's state.
 */

/** A source whose holds and acknowledgement outcome the test sets. */
function scripted() {
  let held: Held[] = [];
  let outcome: AckOutcome = 'ACKNOWLEDGED';
  let afterAck: Held[] | null = [];
  const listeners = new Set<() => void>();
  const source: QuarantineSource = {
    held: () => held,
    acknowledge: () => {
      if (afterAck !== null) held = afterAck;
      return outcome;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    hold(record: Held[]) {
      held = record;
    },
    /** What `acknowledge` returns, and what is held when it is read again afterwards. */
    onAck(result: AckOutcome, then: Held[] | null) {
      outcome = result;
      afterAck = then;
    },
    /** A record newly held after the form was drawn (a late answer kept aside). */
    notify(record: Held[]) {
      held = record;
      for (const listener of [...listeners]) listener();
    },
  };
}

const R1: Held = { key: 'rasta.unresolved-order.!q.1', fingerprint: 'f1' };
const R2: Held = { key: 'rasta.unresolved-order.!q.2', fingerprint: 'f2' };

let mounts = 0;
/** The form: counts its mounts and keeps typed text, as a real form's state does. */
function Form() {
  const [text, setText] = useState('');
  useEffect(() => {
    mounts += 1;
  }, []);
  return (
    <input aria-label="field" value={text} onChange={(event) => setText(event.target.value)} />
  );
}

const ACCOUNT = bindingOf('owner-tag-A', 'session-tag-1');

async function acknowledgeWarning() {
  fireEvent.click(screen.getByLabelText(QUARANTINE_CONFIRM));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: QUARANTINE_CONTINUE }));
  });
}

beforeEach(() => {
  mounts = 0;
  window.sessionStorage.clear();
});

afterEach(() => jest.restoreAllMocks());

it('held at mount → acknowledged → admitted; a later hold is drawn beside the form, which keeps its state', async () => {
  const gate = scripted();
  gate.hold([R1]);
  render(
    <QuarantineGate source={gate.source} account={ACCOUNT}>
      <Form />
    </QuarantineGate>,
  );
  expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
  expect(screen.queryByLabelText('field')).toBeNull();

  gate.onAck('ACKNOWLEDGED', []);
  await acknowledgeWarning();
  fireEvent.change(screen.getByLabelText('field'), { target: { value: 'typed' } });
  // Drawn once as the server draws it (then taken out by the hold read at mount), once admitted.
  expect(mounts).toBe(2);

  // A later hold, then another acknowledgement, then another hold: the form stays.
  for (const record of [R2, R1]) {
    await act(async () => gate.notify([record]));
    expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
    expect(screen.getByLabelText('field')).toHaveValue('typed');
    gate.onAck('ACKNOWLEDGED', []);
    await acknowledgeWarning();
    expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
  }
  expect(screen.getByLabelText('field')).toHaveValue('typed');
  expect(mounts).toBe(2);
});

it.each([
  ['CHANGED: a record changed after the warning was drawn', 'CHANGED', [R1]],
  ['FAILED: the acknowledgement was not written or did not read back', 'FAILED', [R1]],
  ['a new generation held by the time it is read again', 'ACKNOWLEDGED', [R2]],
] as const)('%s → not admitted: the form is not drawn', async (_label, outcome, then) => {
  const gate = scripted();
  gate.hold([R1]);
  render(
    <QuarantineGate source={gate.source} account={ACCOUNT}>
      <Form />
    </QuarantineGate>,
  );
  gate.onAck(outcome, [...then]);
  await acknowledgeWarning();
  expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
  expect(screen.queryByLabelText('field')).toBeNull();
  // Only the first paint's form, as the server draws it, taken out at the read.
  expect(mounts).toBe(1);
  if (outcome === 'FAILED') expect(screen.getByText(QUARANTINE_ACK_FAILED)).toBeInTheDocument();
});

it('memory holds (storage refusing the set-aside) follow the same lifecycle', async () => {
  const late = (id: string) =>
    answerUnresolvedOrder(
      'PRD_ELSEWHERE',
      { submissionId: id, values: { offerId: 'OFR_1', quantity: '3' }, correlationId: 'COR' },
      ACCOUNT,
    );
  const refuse = () =>
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });

  refuse();
  expect(late('sub_MEMORYONEMEMORYONEMEM')).toBe('UNAVAILABLE');
  jest.restoreAllMocks();
  render(
    <QuarantineGate source={orderQuarantine} account={ACCOUNT}>
      <Form />
    </QuarantineGate>,
  );
  expect(screen.queryByLabelText('field')).toBeNull();
  await acknowledgeWarning();
  fireEvent.change(screen.getByLabelText('field'), { target: { value: 'typed' } });

  refuse();
  await act(async () => {
    expect(late('sub_MEMORYTWOMEMORYTWOMEM')).toBe('UNAVAILABLE');
  });
  jest.restoreAllMocks();
  expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
  expect(screen.getByLabelText('field')).toHaveValue('typed');
  expect(mounts).toBe(2);
});

it.each([
  ['another person', bindingOf('owner-tag-A', 'session-tag-1', 'person-tag-2')],
  ['another organization', bindingOf('owner-tag-B', 'session-tag-1')],
  ['another login', bindingOf('owner-tag-A', 'session-tag-2')],
] as const)(
  'admission is the same identity’s: after %s, the form is drawn anew, and a hold present then keeps it out',
  async (_label, other) => {
    const gate = scripted();
    const view = render(
      <QuarantineGate source={gate.source} account={ACCOUNT}>
        <Form />
      </QuarantineGate>,
    );
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'typed' } });

    // Nothing held: the new identity's form, drawn anew — never the first one's text.
    view.rerender(
      <QuarantineGate source={gate.source} account={other}>
        <Form />
      </QuarantineGate>,
    );
    expect(screen.getByLabelText('field')).toHaveValue('');
    expect(mounts).toBe(2);

    // Back, with a hold present at that moment: not admitted for it until acknowledged.
    gate.hold([R1]);
    view.rerender(
      <QuarantineGate source={gate.source} account={ACCOUNT}>
        <Form />
      </QuarantineGate>,
    );
    expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
    expect(screen.queryByLabelText('field')).toBeNull();
  },
);
