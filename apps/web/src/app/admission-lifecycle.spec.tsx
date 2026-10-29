import type { ReactElement, ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PRICE_FIELD, answerField } from '@/lib/bid-fields';
import { lineField } from '@/lib/statement-fields';
import { REASON_FIELD, quantityField } from '@/lib/return-fields';
import { scoreField } from '@/lib/tender-evaluation-fields';
import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import * as bidStore from '@/lib/unresolved-bid';
import * as contractStore from '@/lib/unresolved-contract-command';
import * as disputeStore from '@/lib/unresolved-dispute';
import * as orderStore from '@/lib/unresolved-order';
import * as returnStore from '@/lib/unresolved-return';
import * as statementStore from '@/lib/unresolved-statement';
import * as ownerStore from '@/lib/unresolved-tender-command';
import { SESSION_PROBE_DEADLINE_MS } from '@/lib/session-refusal';
import {
  QUARANTINE_MARK,
  resetUnrecordedOutcomes,
  type Binding,
  type QuarantineSource,
} from '@/lib/unresolved-tenancy';
import type { Offer } from '@/server/marketplace';
import { OPEN_TENDER, TENDER_ID as BID_TENDER } from '@/test/bid-fixtures';
import { TENDER_ID as OWNER_TENDER } from '@/test/owner-fixtures';
import { CONTRACT_ID } from '@/test/statement-fixtures';
import { LINE_A, LINE_B, ORDER_ID } from '@/test/return-fixtures';
import { OTHER_PERSON, bindingOf, keyFor } from '@/test/unresolved-binding';

import { PlaceOrderForm } from './marketplace/[productId]/PlaceOrderForm';
import { DisputeCommands } from './transactions/[id]/DisputeCommands';
import { ReturnCommands } from './returns/ReturnCommands';
import { StatementCommands } from './contracts/[id]/StatementCommands';
import { ContractCommands } from './contracts/[id]/ContractCommands';
import { BidCommands } from './tenders/[id]/BidCommands';
import { OwnerCommands } from './tenders/[id]/OwnerCommands';
import { QUARANTINE_CONFIRM, QUARANTINE_CONTINUE, QUARANTINE_TITLE } from './UnresolvedQuarantine';

/**
 * PR 405 review 4, through the real command groups of all seven kinds, under
 * React 19 with the real `useActionState` — only the actions and
 * `/auth/session` are scripted.
 *
 * R4, the gate's admission lifecycle: a hold present at mount → acknowledged →
 * K2 sent, its outcome unknown → a later hold (a late K1 answer kept aside) →
 * acknowledged. K2's uncertainty view must still be there, its stored record
 * byte for byte; a refused re-send never clears it. A genuine remount restores
 * K2 from storage (order, dispute, return, statement, contract command: its
 * retryable view; bid and tender owner command, which keep markers only: the
 * view-only marker). A form drawn blank while K2 is unresolved under its own
 * key never sends — nothing under K2's key but K2's own body — and a definite
 * refusal never settles K2 (PM addendum A). Admission is kept for the same
 * person, organization and login only (addendum C).
 *
 * R5, one finalization boundary: K1 still out when its form goes away, K1 set
 * aside, K2 sent into the slot — then K1's transport call itself fails. K1's
 * outcome is shown (the fixed warning), K2 stays byte for byte, and nothing is
 * sent again under either key. `/auth/session` answering 503 or failing keeps
 * it uncertain; only 401 says the session ended (addendum F).
 *
 * Review 5, R6: the failed call is kept and shown BEFORE `/auth/session` is
 * asked. With the probe held open (fake timers), the hold and the warning —
 * or, in the form's own slot, its record and uncertainty view — are already
 * there; then a 401, 204, 503, network failure or no answer within the
 * deadline each leave exactly one record, K2 byte for byte. A 401 only adds
 * the "session ended" view to the form whose very send failed — never to
 * another identity's form, nor to a newer press (PM addenda B–F).
 */

jest.setTimeout(30_000);

const orderAction = jest.fn();
jest.mock('./marketplace/[productId]/place-order-actions', () => ({
  submitPlaceOrder: (...args: unknown[]) => orderAction(...args),
}));
const disputeAction = jest.fn();
jest.mock('./transactions/[id]/actions', () => ({
  submitDisputeCommand: (...args: unknown[]) => disputeAction(...args),
}));
const returnAction = jest.fn();
jest.mock('./returns/return-actions', () => ({
  submitReturnRequest: (...args: unknown[]) => returnAction(...args),
  submitReturnCommand: (...args: unknown[]) => returnAction(...args),
}));
const statementAction = jest.fn();
jest.mock('./contracts/[id]/statement-actions', () => ({
  submitStatementDraft: (...args: unknown[]) => statementAction(...args),
  submitStatementCommand: (...args: unknown[]) => statementAction(...args),
}));
const contractAction = jest.fn();
jest.mock('./contracts/[id]/contract-actions', () => ({
  submitContractCommand: (...args: unknown[]) => contractAction(...args),
}));
const bidAction = jest.fn();
jest.mock('./tenders/[id]/bid-actions', () => ({
  submitBidCommand: (...args: unknown[]) => bidAction(...args),
}));
const ownerAction = jest.fn();
jest.mock('./tenders/[id]/owner-actions', () => ({
  submitOwnerCommand: (...args: unknown[]) => ownerAction(...args),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const K0 = 'sub_HOLDKEYHOLDKEYHOLDKE';
const K1 = 'sub_FIRSTKEYFIRSTKEYFIRS';
const K2 = 'sub_SECONDKEYSECONDKEYSE';
const BINDING = bindingOf('owner-tag-A', 'session-tag-1');
const MAX_AGE = 12 * 60 * 60;
const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const RETRY = 'ارسال دوبارهٔ همین درخواست';
const REFUSED = { kind: 'REFUSED', reason: 'CSRF' } as const;
const lostResponse = () => new Error('An unexpected response was received from the server.');

type Variant = 'one' | 'two' | 'edited';

interface Group {
  readonly name: string;
  readonly action: jest.Mock;
  /** Where the slot of the drawn forms is, for `binding`. */
  slot(binding?: Binding): string;
  /** The real group as its page draws it, offering one fresh form with `id`. */
  page(id: string, binding?: Binding): ReactElement;
  fill(container: HTMLElement, variant: Variant): void;
  /** The body field that tells the variants apart, as sent. */
  distinct(form: FormData): string;
  /** What the action answers when the outcome is unknown. */
  unconfirmed(form: FormData, id: string, correlationId: string): unknown;
  /** A late answer still in doubt for `id`, whose slot is not its own: kept aside (a hold). */
  hold(id: string, binding?: Binding): void;
  /** The person's own "set it aside" of `id` (the control the uncertainty view draws). */
  release(id: string, binding?: Binding): void;
  /** Writes `id`'s unresolved entry as a first send would have, `variant` its body. */
  remember(id: string, binding?: Binding): void;
  /** Markers only: a genuine remount restores a view-only marker, never the body. */
  readonly markerOnly: boolean;
}

const formOf = (call: unknown[]) => call[call.length - 1] as FormData;
const sentIds = (group: Group) =>
  group.action.mock.calls.map((call) => formOf(call).get('submission'));
const setAside = () =>
  Object.keys(window.sessionStorage).filter((key) => key.includes(QUARANTINE_MARK));

const set = (container: HTMLElement, name: string, value: string) =>
  fireEvent.change(container.querySelector(`[name="${name}"]`)!, { target: { value } });

// ---------------------------------------------------------------------------
// The seven groups

const OFFER: Offer = {
  id: 'OFR_1',
  productId: 'PRD_1',
  supplierOrganizationId: 'ORG-DEH-0002',
  unitPriceMinor: '300000',
  currency: 'IRR',
  availableQuantity: 15,
  leadTimeDays: 5,
  minimumQuantity: 2,
  supplierQualification: 'UNAVAILABLE',
};
const QUANTITY: Record<Variant, string> = { one: '3', two: '7', edited: '9' };

const order: Group = {
  name: 'order',
  action: orderAction,
  markerOnly: false,
  slot: (b = BINDING) => keyFor('rasta.unresolved-order.', b, 'PRD_1'),
  page: (id, b = BINDING) => (
    <PlaceOrderForm
      offers={[OFFER]}
      csrfToken="csrf"
      submissionId={id}
      newOrderHref="/marketplace/PRD_1"
      productId="PRD_1"
      binding={b}
      sessionMaxAgeSeconds={MAX_AGE}
    />
  ),
  fill: (c, v) => {
    set(c, 'offerId', 'OFR_1');
    set(c, 'quantity', QUANTITY[v]);
  },
  distinct: (form) => String(form.get('quantity')),
  unconfirmed: (form, id, correlationId) => ({
    kind: 'UNCONFIRMED',
    correlationId,
    submissionId: id,
    values: { offerId: 'OFR_1', quantity: String(form.get('quantity')) },
  }),
  hold: (id, b = BINDING) =>
    void orderStore.answerUnresolvedOrder(
      'PRD_HOLD',
      { submissionId: id, values: { offerId: 'OFR_1', quantity: '1' }, correlationId: 'COR_H' },
      b,
    ),
  release: (id, b = BINDING) => orderStore.clearUnresolvedOrder('PRD_1', id, b),
  remember: (id, b = BINDING) => {
    const entry = { submissionId: id, values: { offerId: 'OFR_1', quantity: '7' } };
    orderStore.saveUnresolvedOrder('PRD_1', { ...entry, correlationId: null }, b);
    orderStore.answerUnresolvedOrder('PRD_1', { ...entry, correlationId: 'COR_K2' }, b);
  },
};

const REASONS: Record<Variant, string> = {
  one: 'کالا هرگز به انبار ما نرسید.',
  two: 'کالای رسیده با سفارش جور نبود.',
  edited: 'متن ویرایش‌شده‌ای برای همان شناسه.',
};

const dispute: Group = {
  name: 'dispute',
  action: disputeAction,
  markerOnly: false,
  slot: (b = BINDING) => keyFor('rasta.unresolved-dispute.', b, 'TXN_1'),
  page: (id, b = BINDING) => (
    <DisputeCommands
      transactionId="TXN_1"
      commands={['DISPUTE']}
      csrfToken="csrf"
      submissions={{ DISPUTE: { id, replay: STAMP } }}
      binding={b}
      sessionMaxAgeSeconds={MAX_AGE}
    />
  ),
  fill: (c, v) => set(c, 'reason', REASONS[v]),
  distinct: (form) => String(form.get('reason')),
  unconfirmed: (form, id, correlationId) => ({
    kind: 'UNCONFIRMED',
    command: 'DISPUTE',
    correlationId,
    submissionId: id,
    values: { ...EMPTY_DISPUTE_FORM, reason: String(form.get('reason')) },
    replay: STAMP,
  }),
  hold: (id, b = BINDING) =>
    void disputeStore.answerUnresolvedDispute(
      'TXN_HOLD',
      {
        command: 'DISPUTE',
        submissionId: id,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASONS.one },
        correlationId: 'COR_H',
        replay: STAMP,
      },
      b,
    ),
  release: (id, b = BINDING) => disputeStore.clearUnresolvedDispute('TXN_1', id, b),
  remember: (id, b = BINDING) => {
    const entry = {
      command: 'DISPUTE' as const,
      submissionId: id,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASONS.two },
      replay: STAMP,
    };
    disputeStore.saveUnresolvedDispute('TXN_1', { ...entry, correlationId: null }, b);
    disputeStore.answerUnresolvedDispute('TXN_1', { ...entry, correlationId: 'COR_K2' }, b);
  },
};

const RETURN_LINES = [
  { orderLineId: LINE_A, productName: 'شن و ماسه', sold: 10, available: 10 },
  { orderLineId: LINE_B, productName: 'سیمان', sold: 20, available: 20 },
];
const RETURN_SCOPE = { kind: 'ORDER' as const, orderId: ORDER_ID };

const returns: Group = {
  name: 'return',
  action: returnAction,
  markerOnly: false,
  slot: (b = BINDING) => keyFor('rasta.unresolved-return.', b, `order.${ORDER_ID}`),
  page: (id, b = BINDING) => (
    <ReturnCommands
      scope={RETURN_SCOPE}
      offered={[{ command: 'REQUEST', submission: { id, replay: STAMP } }]}
      csrfToken="csrf"
      binding={b}
      sessionMaxAgeSeconds={MAX_AGE}
      lines={RETURN_LINES}
      pageHref={`/orders/${ORDER_ID}`}
    />
  ),
  fill: (c, v) => {
    set(c, REASON_FIELD, REASONS[v]);
    set(c, quantityField(LINE_A), '۳');
  },
  distinct: (form) => String(form.get(REASON_FIELD)),
  unconfirmed: (form, id, correlationId) => ({
    kind: 'UNCONFIRMED',
    command: 'REQUEST',
    correlationId,
    submissionId: id,
    body: {
      reason: String(form.get(REASON_FIELD)),
      lines: [{ orderLineId: LINE_A, quantity: 3 }],
    },
    replay: STAMP,
  }),
  hold: (id, b = BINDING) =>
    void returnStore.answerUnresolvedReturn(
      { kind: 'RETURN', returnId: 'RET_HOLD' },
      {
        command: 'CANCEL',
        submissionId: id,
        correlationId: 'COR_H',
        body: null,
        replay: STAMP,
      },
      b,
    ),
  release: (id, b = BINDING) => returnStore.clearUnresolvedReturn(RETURN_SCOPE, id, b),
  remember: (id, b = BINDING) => {
    const entry = {
      command: 'REQUEST' as const,
      submissionId: id,
      body: { reason: REASONS.two, lines: [{ orderLineId: LINE_A, quantity: 3 }] },
      replay: STAMP,
    };
    returnStore.saveUnresolvedReturn(RETURN_SCOPE, { ...entry, correlationId: null }, b);
    returnStore.answerUnresolvedReturn(RETURN_SCOPE, { ...entry, correlationId: 'COR_K2' }, b);
  },
};

const DESCRIPTION: Record<Variant, string> = { one: 'آسفالت', two: 'زیرسازی', edited: 'ویرایش' };
const DRAFT_SCOPE = { contractId: CONTRACT_ID, statementId: null };

const statement: Group = {
  name: 'statement',
  action: statementAction,
  markerOnly: false,
  slot: (b = BINDING) => keyFor('rasta.unresolved-statement.', b, `${CONTRACT_ID}.draft`),
  page: (id, b = BINDING) => (
    <StatementCommands
      contractId={CONTRACT_ID}
      statementId={null}
      offered={[{ command: 'DRAFT', submission: { id, replay: STAMP } }]}
      csrfToken="csrf"
      binding={b}
      sessionMaxAgeSeconds={MAX_AGE}
      pageHref={`/contracts/${CONTRACT_ID}`}
    />
  ),
  fill: (c, v) => {
    set(c, lineField(0, 'description'), DESCRIPTION[v]);
    set(c, lineField(0, 'amount'), '۱٬۱۰۰٬۰۰۰٬۰۰۰');
  },
  distinct: (form) => String(form.get(lineField(0, 'description'))),
  unconfirmed: (form, id, correlationId) => ({
    kind: 'UNCONFIRMED',
    command: 'DRAFT',
    correlationId,
    submissionId: id,
    lines: [
      { description: String(form.get(lineField(0, 'description'))), amountMinor: '1100000000' },
    ],
    replay: STAMP,
  }),
  hold: (id, b = BINDING) =>
    void statementStore.answerUnresolvedStatement(
      { contractId: 'CTR_HOLD', statementId: 'STM_HOLD' },
      { command: 'SUBMIT', submissionId: id, correlationId: 'COR_H', lines: [], replay: STAMP },
      b,
    ),
  release: (id, b = BINDING) => statementStore.clearUnresolvedStatement(DRAFT_SCOPE, id, b),
  remember: (id, b = BINDING) => {
    const entry = {
      command: 'DRAFT' as const,
      submissionId: id,
      lines: [{ description: DESCRIPTION.two, amountMinor: '1100000000' }],
      replay: STAMP,
    };
    statementStore.saveUnresolvedStatement(DRAFT_SCOPE, { ...entry, correlationId: null }, b);
    statementStore.answerUnresolvedStatement(DRAFT_SCOPE, { ...entry, correlationId: 'COR_K2' }, b);
  },
};

const REASON_TEXT: Record<Variant, string> = {
  one: 'افزایش کار',
  two: 'کار بیشتر در بخش شمالی',
  edited: 'متن دیگری زیر همان شناسه',
};
const NEW_AMENDMENT = { contractId: CONTRACT_ID, slot: 'NEW_AMENDMENT' as const, subjectId: null };

const contract: Group = {
  name: 'contract command',
  action: contractAction,
  markerOnly: false,
  slot: (b = BINDING) => keyFor('rasta.unresolved-contract.', b, `${CONTRACT_ID}.NEW_AMENDMENT.-`),
  page: (id, b = BINDING) => (
    <ContractCommands
      contractId={CONTRACT_ID}
      slot="NEW_AMENDMENT"
      subjectId={null}
      offered={[
        {
          command: 'PROPOSE_AMENDMENT',
          submission: { id, replay: STAMP },
          reasons: [{ code: 'SCOPE_CHANGE', label: 'تغییر دامنهٔ کار' }],
        },
      ]}
      context={{
        csrfToken: 'csrf',
        binding: b,
        sessionMaxAgeSeconds: MAX_AGE,
        pageHref: `/contracts/${CONTRACT_ID}`,
      }}
    />
  ),
  fill: (c, v) => {
    set(c, 'deltaMinor', '۲٬۰۰۰٬۰۰۰');
    set(c, 'reasonCode', 'SCOPE_CHANGE');
    set(c, 'reasonText', REASON_TEXT[v]);
  },
  distinct: (form) => String(form.get('reasonText')),
  unconfirmed: (form, id, correlationId) => ({
    kind: 'UNCONFIRMED',
    command: 'PROPOSE_AMENDMENT',
    correlationId,
    submissionId: id,
    input: {
      deltaMinor: '2000000',
      reasonCode: 'SCOPE_CHANGE',
      reasonText: String(form.get('reasonText')),
    },
    replay: STAMP,
  }),
  hold: (id, b = BINDING) =>
    void contractStore.answerUnresolvedContractCommand(
      { contractId: 'CTR_HOLD', slot: 'CONTRACT', subjectId: null },
      { command: 'SIGN', submissionId: id, correlationId: 'COR_H', input: null, replay: STAMP },
      b,
    ),
  release: (id, b = BINDING) => contractStore.clearUnresolvedContractCommand(NEW_AMENDMENT, id, b),
  remember: (id, b = BINDING) => {
    const entry = {
      command: 'PROPOSE_AMENDMENT' as const,
      submissionId: id,
      input: { deltaMinor: '2000000', reasonCode: 'SCOPE_CHANGE', reasonText: REASON_TEXT.two },
      replay: STAMP,
    };
    contractStore.saveUnresolvedContractCommand(
      NEW_AMENDMENT,
      { ...entry, correlationId: null },
      b,
    );
    contractStore.answerUnresolvedContractCommand(
      NEW_AMENDMENT,
      { ...entry, correlationId: 'COR_K2' },
      b,
    );
  },
};

const BID_CRITERIA = OPEN_TENDER.criteria.map(({ code, label }) => ({ code, label }));
const ANSWER: Record<Variant, string> = {
  one: 'روش اجرا با ماشین‌آلات خودی',
  two: 'روش اجرا با پیمانکار جزء',
  edited: 'پاسخ ویرایش‌شده',
};

const bid: Group = {
  name: 'bid',
  action: bidAction,
  markerOnly: true,
  slot: (b = BINDING) => keyFor('rasta.unresolved-bid.', b, BID_TENDER),
  page: (id, b = BINDING) => (
    <BidCommands
      tenderId={BID_TENDER}
      offered={[{ command: 'SUBMIT', submission: { id, replay: STAMP } }]}
      criteria={BID_CRITERIA}
      csrfToken="csrf"
      account={b}
      pageHref={`/tenders/${BID_TENDER}?view=open`}
    />
  ),
  fill: (c, v) => {
    set(c, PRICE_FIELD, '۴٬۲۰۰٬۰۰۰٬۰۰۰');
    set(c, answerField(0), ANSWER[v]);
  },
  distinct: (form) => String(form.get(answerField(0))),
  unconfirmed: (form, id, correlationId) => ({
    kind: 'UNCONFIRMED',
    command: 'SUBMIT',
    correlationId,
    submissionId: id,
    values: {
      priceMinor: String(form.get(PRICE_FIELD)),
      note: '',
      answers: [{ criterionCode: 'technical', response: String(form.get(answerField(0))) }],
    },
    replay: STAMP,
  }),
  hold: (id, b = BINDING) =>
    void bidStore.answerUnresolvedBid(
      'TND_HOLD',
      { command: 'SUBMIT', submissionId: id, correlationId: 'COR_H' },
      b,
    ),
  release: (id, b = BINDING) => bidStore.clearUnresolvedBid(BID_TENDER, id, b),
  remember: (id, b = BINDING) => {
    bidStore.saveUnresolvedBid(
      BID_TENDER,
      { command: 'SUBMIT', submissionId: id, correlationId: null },
      b,
    );
    bidStore.answerUnresolvedBid(
      BID_TENDER,
      { command: 'SUBMIT', submissionId: id, correlationId: 'COR_K2' },
      b,
    );
  },
};

const SCORE: Record<Variant, string> = { one: '۷', two: '۸', edited: '۲' };
const SCORE_ROWS = [
  {
    cell: { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
    label: 'روش اجرا',
    current: null,
  },
];
const SCORE_BINDING = '{"scoring":[{"criterionCode":"technical"}],"award":null}';

const owner: Group = {
  name: 'tender owner command',
  action: ownerAction,
  markerOnly: true,
  slot: (b = BINDING) => keyFor('rasta.unresolved-tender-command.', b, OWNER_TENDER),
  page: (id, b = BINDING) => (
    <OwnerCommands
      tenderId={OWNER_TENDER}
      offered={[
        {
          command: 'SCORE',
          scoreRows: SCORE_ROWS,
          submission: { id, replay: STAMP, binding: SCORE_BINDING },
        },
      ]}
      csrfToken="csrf"
      account={b}
      pageHref={`/tenders/${OWNER_TENDER}?view=own`}
      showsRestored
    />
  ),
  fill: (c, v) => set(c, scoreField('technical'), SCORE[v]),
  distinct: (form) => String(form.get(scoreField('technical'))),
  unconfirmed: (form, id, correlationId) => ({
    kind: 'UNCONFIRMED',
    command: 'SCORE',
    correlationId,
    submissionId: id,
    values: {
      [scoreField('technical')]: String(form.get(scoreField('technical'))),
      binding: SCORE_BINDING,
    },
    replay: STAMP,
  }),
  hold: (id, b = BINDING) =>
    void ownerStore.answerUnresolvedOwnerCommand(
      'TND_HOLD',
      { command: 'PUBLISH', submissionId: id, correlationId: 'COR_H' },
      b,
    ),
  release: (id, b = BINDING) => ownerStore.clearUnresolvedOwnerCommand(OWNER_TENDER, id, b),
  remember: (id, b = BINDING) => {
    ownerStore.saveUnresolvedOwnerCommand(
      OWNER_TENDER,
      { command: 'SCORE', submissionId: id, correlationId: null },
      b,
    );
    ownerStore.answerUnresolvedOwnerCommand(
      OWNER_TENDER,
      { command: 'SCORE', submissionId: id, correlationId: 'COR_K2' },
      b,
    );
  },
};

const GROUPS: readonly Group[] = [order, dispute, returns, statement, contract, bid, owner];
const ALL_ACTIONS = GROUPS.map((group) => group.action);

// ---------------------------------------------------------------------------

/** An answer that arrives when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function submitIn(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

async function acknowledgeWarning() {
  fireEvent.click(screen.getByLabelText(QUARANTINE_CONFIRM));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: QUARANTINE_CONTINUE }));
  });
}

/** The person fills the form drawn for `id` and sends it; the action answers UNCONFIRMED. */
async function sendUnconfirmed(group: Group, container: HTMLElement, id: string, v: Variant) {
  group.action.mockImplementationOnce(async (...args: unknown[]) =>
    group.unconfirmed(formOf(args), id, `COR_${id}`),
  );
  group.fill(container, v);
  await submitIn(container);
}

let sessionStatus: number | 'NETWORK' = 204;

beforeEach(() => {
  for (const action of ALL_ACTIONS) action.mockReset();
  sessionStatus = 204;
  global.fetch = (async () => {
    if (sessionStatus === 'NETWORK') throw new TypeError('fetch failed');
    return { status: sessionStatus };
  }) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  orderStore.markAccountOpen();
  disputeStore.markDisputesOpen();
  returnStore.markReturnsOpen();
  statementStore.markStatementsOpen();
  contractStore.markContractCommandsOpen();
  bidStore.markBidsOpen();
  ownerStore.markOwnerCommandsOpen();
});

describe.each(GROUPS.map((group) => [group.name, group] as const))('%s', (_name, group) => {
  it('R4: initial hold → acknowledged → K2 unconfirmed → a later hold → acknowledged: K2 still shown, its record byte for byte, a refused re-send never clears it', async () => {
    group.hold(K0);
    const view = render(group.page(K2));
    expect(await screen.findByText(QUARANTINE_TITLE)).toBeInTheDocument();
    expect(view.container.querySelector('form [name="submission"]')).toBeNull();
    await acknowledgeWarning();

    await sendUnconfirmed(group, view.container, K2, 'two');
    const k2 = window.sessionStorage.getItem(group.slot());
    expect(JSON.parse(k2!)).toMatchObject({ submissionId: K2, correlationId: `COR_${K2}` });
    expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();

    // A late K1 answer is kept aside: a later hold of this kind.
    await act(async () => group.hold(K1));
    expect(await screen.findByText(QUARANTINE_TITLE)).toBeInTheDocument();
    // Beside the warning, not instead of it: K2's own uncertainty view stays mounted.
    expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
    await acknowledgeWarning();
    expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
    expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(group.slot())).toBe(k2);

    // The same request again, answered with a definite refusal: K2 is not cleared.
    group.action.mockResolvedValueOnce(REFUSED);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RETRY }));
    });
    expect(sentIds(group)).toEqual([K2, K2]);
    // The re-send carries K2's own body, in memory even where only a marker is stored.
    const [first, again] = group.action.mock.calls.map(formOf);
    expect(group.distinct(again!)).toBe(group.distinct(first!));
    expect(window.sessionStorage.getItem(group.slot())).toBe(k2);
  });

  it('R4: a genuine remount restores K2 from storage — never a blank form under its key', async () => {
    const first = render(group.page(K2));
    await sendUnconfirmed(group, first.container, K2, 'two');
    const k2 = window.sessionStorage.getItem(group.slot());
    first.unmount();

    const again = render(group.page(K2));
    await waitFor(() => expect(again.container.textContent).not.toBe(''));
    if (group.markerOnly) {
      // Markers only: view-only, nothing to send, no field to type into.
      expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
      expect(again.container.querySelector('textarea, input[type="text"], select')).toBeNull();
    } else {
      expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
    }
    expect(window.sessionStorage.getItem(group.slot())).toBe(k2);
  });

  it('R4: a form drawn blank while K2 is unresolved under its own key sends nothing, edits nothing and never settles K2', async () => {
    const view = render(group.page(K2));
    await waitFor(() => expect(view.container.querySelector('form')).not.toBeNull());
    // K2's record appears after the form was drawn blank (what a remount used to leave).
    group.remember(K2);
    const k2 = window.sessionStorage.getItem(group.slot());
    expect(k2).not.toBeNull();

    group.action.mockResolvedValue(REFUSED);
    group.fill(view.container, 'edited');
    await submitIn(view.container);

    expect(group.action).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(group.slot())).toBe(k2);
  });

  it.each([
    ['204', 204],
    ['503', 503],
    ['a network failure', 'NETWORK'],
    ['401', 401],
  ] as const)(
    'R5: K1 set aside, K2 sent, then K1’s call itself fails (/auth/session %s): K1 shown, K2 byte for byte, nothing re-sent',
    async (_label, status) => {
      const k1Answer = deferred<unknown>();
      group.action.mockImplementationOnce(() => k1Answer.promise);
      const first = render(group.page(K1));
      await waitFor(() => expect(first.container.querySelector('form')).not.toBeNull());
      group.fill(first.container, 'one');
      await submitIn(first.container);
      first.unmount();

      // The person sets K1 aside; K2 takes the slot, its outcome unknown too.
      group.release(K1);
      const second = render(group.page(K2));
      await waitFor(() => expect(second.container.querySelector('form')).not.toBeNull());
      await sendUnconfirmed(group, second.container, K2, 'two');
      const k2 = window.sessionStorage.getItem(group.slot());
      expect(JSON.parse(k2!)).toMatchObject({ submissionId: K2 });

      sessionStatus = status;
      await act(async () => {
        k1Answer.reject(lostResponse());
        await k1Answer.promise.catch(() => undefined);
      });

      // K1's outcome is unknown and shown: kept aside, the fixed warning at once.
      expect(setAside()).toHaveLength(1);
      expect(await screen.findByText(QUARANTINE_TITLE)).toBeInTheDocument();
      expect(window.sessionStorage.getItem(group.slot())).toBe(k2);
      // Nothing sent again; K1 never under K2's key nor K2 under K1's, bodies as typed.
      const calls = group.action.mock.calls.map(formOf);
      expect(calls.map((form) => form.get('submission'))).toEqual([K1, K2]);
      expect(calls.map((form) => group.distinct(form))).toEqual([
        group.distinct(calls[0]!),
        group.distinct(calls[1]!),
      ]);
      expect(group.distinct(calls[0]!)).not.toBe(group.distinct(calls[1]!));
    },
  );

  it.each([
    ['another person', bindingOf('owner-tag-A', 'session-tag-1', OTHER_PERSON)],
    ['another organization', bindingOf('owner-tag-B', 'session-tag-1')],
    ['another login', bindingOf('owner-tag-A', 'session-tag-2')],
  ] as const)(
    'addendum C: after %s takes the page, a later hold never keeps the first identity’s form state',
    async (_label, other) => {
      const view = render(group.page(K2));
      await waitFor(() => expect(view.container.querySelector('form')).not.toBeNull());
      await sendUnconfirmed(group, view.container, K2, 'two');
      expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();

      view.rerender(group.page(K2, other));
      await act(async () => group.hold(K1, other));
      if (screen.queryByText(QUARANTINE_TITLE)) await acknowledgeWarning();

      // The first identity's in-memory view — K2's retry with its body — is gone.
      expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
      expect(document.body.textContent).not.toContain(
        group.distinct(formOf(group.action.mock.calls[0]!)),
      );
    },
  );
});

describe('order: a retry whose answer is still in doubt goes through the same boundary', () => {
  it('K1 retried, set aside meanwhile and K2 in the slot, the retry answers UNCONFIRMED: K1 shown, K2 byte for byte', async () => {
    const view = render(order.page(K1));
    await sendUnconfirmed(order, view.container, K1, 'one');
    expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();

    const retried = deferred<unknown>();
    orderAction.mockImplementationOnce(() => retried.promise);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RETRY }));
    });
    // Meanwhile K1 is set aside and K2 takes the slot.
    order.release(K1);
    order.remember(K2);
    const k2 = window.sessionStorage.getItem(order.slot());

    await act(async () => {
      retried.resolve(order.unconfirmed(formOf(orderAction.mock.calls[1]!), K1, 'COR_RETRY'));
      await retried.promise;
    });
    expect(setAside()).toHaveLength(1);
    expect(await screen.findByText(QUARANTINE_TITLE)).toBeInTheDocument();
    expect(window.sessionStorage.getItem(order.slot())).toBe(k2);
    expect(sentIds(order)).toEqual([K1, K1]);
  });

  it('a retry answered UNCONFIRMED while K1 still holds the slot updates K1’s own entry, its first body kept', async () => {
    const view = render(order.page(K1));
    await sendUnconfirmed(order, view.container, K1, 'one');
    orderAction.mockImplementationOnce(async (...args: unknown[]) =>
      order.unconfirmed(formOf(args), K1, 'COR_RETRY'),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RETRY }));
    });
    expect(JSON.parse(window.sessionStorage.getItem(order.slot())!)).toMatchObject({
      submissionId: K1,
      correlationId: 'COR_RETRY',
      values: { offerId: 'OFR_1', quantity: '3' },
    });
    expect(setAside()).toEqual([]);
  });
});

describe('addendum B: command-specific replay prohibitions survive the shared path', () => {
  it.each(['REVISE', 'WITHDRAW'] as const)(
    'a bid %s whose call failed is never made replayable — not across a later hold, not on a remount',
    async (command) => {
      const page = () => (
        <BidCommands
          tenderId={BID_TENDER}
          offered={[{ command, submission: { id: K2, replay: STAMP } }]}
          criteria={BID_CRITERIA}
          csrfToken="csrf"
          account={BINDING}
          pageHref={`/tenders/${BID_TENDER}?view=open`}
        />
      );
      bidAction.mockRejectedValueOnce(lostResponse());
      const view = render(page());
      await waitFor(() => expect(view.container.querySelector('form')).not.toBeNull());
      if (command === 'REVISE') bid.fill(view.container, 'two');
      await submitIn(view.container);
      expect(window.sessionStorage.getItem(bid.slot())).not.toBeNull();
      expect(screen.queryByRole('button', { name: RETRY })).toBeNull();

      await act(async () => bid.hold(K1));
      await acknowledgeWarning();
      expect(screen.queryByRole('button', { name: RETRY })).toBeNull();

      view.unmount();
      const again = render(page());
      await waitFor(() => expect(again.container.textContent).not.toBe(''));
      expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
      expect(again.container.querySelector('textarea, input[type="text"]')).toBeNull();
      expect(sentIds(bid)).toEqual([K2]);
    },
  );

  it('a dispute whose replay was withdrawn stays withdrawn: a later answer, a later hold and a remount never restore the stamp', async () => {
    const view = render(dispute.page(K2));
    await sendUnconfirmed(dispute, view.container, K2, 'two');
    // The re-send is refused past its deadline: the stamp is withdrawn for good.
    disputeAction.mockImplementationOnce(async (...args: unknown[]) => ({
      ...(dispute.unconfirmed(formOf(args), K2, `COR_${K2}`) as object),
      replay: null,
      viewOnly: true,
      replayExpired: true,
    }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: RETRY }));
    });
    expect(JSON.parse(window.sessionStorage.getItem(dispute.slot())!)).toMatchObject({
      submissionId: K2,
      replay: null,
    });
    // A late answer still carrying the stamp does not bring it back.
    disputeStore.answerUnresolvedDispute(
      'TXN_1',
      {
        command: 'DISPUTE',
        submissionId: K2,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASONS.two },
        correlationId: 'COR_LATE',
        replay: STAMP,
      },
      BINDING,
    );
    expect(JSON.parse(window.sessionStorage.getItem(dispute.slot())!)).toMatchObject({
      replay: null,
    });

    await act(async () => dispute.hold(K1));
    await acknowledgeWarning();
    expect(screen.queryByRole('button', { name: RETRY })).toBeNull();

    view.unmount();
    render(dispute.page(K2));
    await waitFor(() => expect(document.body.textContent).not.toBe(''));
    expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
    expect(sentIds(dispute)).toEqual([K2, K2]);
  });

  it('an expired stamp is never restored as sendable: the remount is view-only', async () => {
    const entry = {
      command: 'DISPUTE' as const,
      submissionId: K2,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASONS.two },
      correlationId: 'COR_K2',
      replay: { token: 'signed-replay-stamp', until: Date.now() - 1000 },
    };
    disputeStore.saveUnresolvedDispute('TXN_1', entry, BINDING);
    const view = render(dispute.page(K2));
    await waitFor(() => expect(view.container.textContent).not.toBe(''));
    expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(disputeAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Review 5, R6: kept and shown first, the session asked after

describe('R6: a failed call is kept and shown before /auth/session answers', () => {
  const QUARANTINES: Record<string, QuarantineSource> = {
    order: orderStore.orderQuarantine,
    dispute: disputeStore.disputeQuarantine,
    return: returnStore.returnQuarantine,
    statement: statementStore.statementQuarantine,
    'contract command': contractStore.contractCommandQuarantine,
    bid: bidStore.bidQuarantine,
    'tender owner command': ownerStore.ownerCommandQuarantine,
  };
  const ENDED = /نشست شما پایان یافته است/;
  const OUTCOMES = [
    ['401', 401],
    ['204', 204],
    ['503', 503],
    ['a network failure', 'NETWORK'],
    ['no answer within the deadline', 'TIMEOUT'],
  ] as const;
  type Outcome = (typeof OUTCOMES)[number][1];

  /** `/auth/session`, held open until the test answers it. */
  let probe: {
    asked: number;
    signals: AbortSignal[];
    answers: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[];
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    probe = { asked: 0, signals: [], answers: [] };
    global.fetch = ((_url: string, init: RequestInit) => {
      probe.asked += 1;
      probe.signals.push(init.signal as AbortSignal);
      return new Promise((resolve, reject) => probe.answers.push({ resolve, reject }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    resetUnrecordedOutcomes();
  });

  /** Still asking: asked once, not answered, the deadline not reached (nothing aborted). */
  const stillAsking = () => {
    expect(probe.asked).toBe(1);
    expect(probe.signals[0]!.aborted).toBe(false);
  };

  async function answerProbe(outcome: Outcome) {
    await act(async () => {
      if (outcome === 'TIMEOUT') jest.advanceTimersByTime(SESSION_PROBE_DEADLINE_MS);
      else
        for (const answer of probe.answers) {
          if (outcome === 'NETWORK') answer.reject(new TypeError('fetch failed'));
          else answer.resolve({ status: outcome });
        }
    });
    if (outcome === 'TIMEOUT') {
      expect(probe.signals[0]!.aborted).toBe(true);
      // A 401 after the deadline, from a fetch that ignored the abort: ignored.
      await act(async () => {
        for (const answer of probe.answers) answer.resolve({ status: 401 });
      });
    }
  }

  const memoryHolds = (group: Group) =>
    QUARANTINES[group.name]!.held({ person: BINDING.person, legacy: BINDING.legacy }).filter(
      (held) => held.key.startsWith('memory:'),
    );

  /** Storage that refuses every set-aside record (a full quota): the memory fallback. */
  const refuseSetAside = () => {
    const setItem = Storage.prototype.setItem;
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.includes(QUARANTINE_MARK)) throw new DOMException('full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    });
  };

  /** The reviewer's case: K1 out, its form gone, K1 set aside, K2 in the slot — then K1's call fails. */
  async function k1FailsAfterK2(group: Group) {
    const k1Answer = deferred<unknown>();
    group.action.mockImplementationOnce(() => k1Answer.promise);
    const first = render(group.page(K1));
    await waitFor(() => expect(first.container.querySelector('form')).not.toBeNull());
    group.fill(first.container, 'one');
    await submitIn(first.container);
    first.unmount();
    group.release(K1);
    const second = render(group.page(K2));
    await waitFor(() => expect(second.container.querySelector('form')).not.toBeNull());
    await sendUnconfirmed(group, second.container, K2, 'two');
    const k2 = window.sessionStorage.getItem(group.slot());
    expect(JSON.parse(k2!)).toMatchObject({ submissionId: K2 });
    expect(probe.asked).toBe(0);
    await act(async () => {
      k1Answer.reject(lostResponse());
      await k1Answer.promise.catch(() => undefined);
    });
    return k2;
  }

  /** K1's own form, its call failing while K1 still holds the slot. */
  async function ownSendFails(group: Group) {
    group.action.mockRejectedValueOnce(lostResponse());
    const view = render(group.page(K1));
    await waitFor(() => expect(view.container.querySelector('form')).not.toBeNull());
    group.fill(view.container, 'one');
    await submitIn(view.container);
    return view;
  }

  describe.each(GROUPS.map((group) => [group.name, group] as const))('%s', (_name, group) => {
    it.each(OUTCOMES)(
      'K1 set aside, K2 sent, K1’s call fails: the hold and the warning are there while /auth/session is pending; then %s leaves exactly one record, K2 byte for byte',
      async (_label, outcome) => {
        const k2 = await k1FailsAfterK2(group);

        stillAsking();
        expect(setAside()).toHaveLength(1);
        expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
        expect(window.sessionStorage.getItem(group.slot())).toBe(k2);
        const record = setAside();

        await answerProbe(outcome);

        expect(setAside()).toEqual(record);
        expect(memoryHolds(group)).toEqual([]);
        expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
        expect(window.sessionStorage.getItem(group.slot())).toBe(k2);
        // K2's own view is K2's: no "session ended" from K1's probe; still retryable.
        expect(document.body.textContent).not.toMatch(ENDED);
        expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
        expect(sentIds(group)).toEqual([K1, K2]);
      },
    );

    it.each(OUTCOMES)(
      'the same with storage refusing the set-aside record: one memory hold and the warning while pending; then %s leaves exactly that one',
      async (_label, outcome) => {
        const k2 = await k1FailsAfterK2((refuseSetAside(), group));

        stillAsking();
        expect(setAside()).toEqual([]);
        expect(memoryHolds(group)).toHaveLength(1);
        expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
        const held = memoryHolds(group);

        await answerProbe(outcome);

        expect(memoryHolds(group)).toEqual(held);
        expect(setAside()).toEqual([]);
        expect(screen.getByText(QUARANTINE_TITLE)).toBeInTheDocument();
        expect(window.sessionStorage.getItem(group.slot())).toBe(k2);
        expect(document.body.textContent).not.toMatch(ENDED);
      },
    );

    it.each([
      ['in storage', false],
      ['in memory', true],
    ] as const)(
      'the warning acknowledged while /auth/session is pending (%s): a later 401 makes no new hold',
      async (_label, memory) => {
        if (memory) refuseSetAside();
        await k1FailsAfterK2(group);
        stillAsking();
        await acknowledgeWarning();
        expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();

        await answerProbe(401);

        expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
        expect(QUARANTINES[group.name]!.held({ person: BINDING.person, legacy: [] })).toEqual([]);
        expect(setAside()).toHaveLength(memory ? 0 : 1);
        expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
      },
    );

    it.each(OUTCOMES)(
      'K1’s own call fails while K1 holds the slot: its record and uncertainty view are there while pending; then %s — the view says “session ended” only for 401, the record byte for byte',
      async (_label, outcome) => {
        const view = await ownSendFails(group);

        stillAsking();
        const k1 = window.sessionStorage.getItem(group.slot());
        expect(JSON.parse(k1!)).toMatchObject({ submissionId: K1 });
        expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(ENDED);
        expect(setAside()).toEqual([]);

        await answerProbe(outcome);

        if (outcome === 401) {
          expect(document.body.textContent).toMatch(ENDED);
          expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
        } else {
          expect(document.body.textContent).not.toMatch(ENDED);
          expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
        }
        // Nothing written again, nothing held, nothing sent again.
        expect(window.sessionStorage.getItem(group.slot())).toBe(k1);
        expect(setAside()).toEqual([]);
        expect(memoryHolds(group)).toEqual([]);
        expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
        expect(sentIds(group)).toEqual([K1]);

        // Addendum E: a remount restores exactly what it would have — a marker stays view-only.
        view.unmount();
        const again = render(group.page(K1));
        await waitFor(() => expect(again.container.textContent).not.toBe(''));
        if (group.markerOnly) {
          expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
          expect(again.container.querySelector('textarea, input[type="text"], select')).toBeNull();
        } else {
          expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
        }
        expect(document.body.textContent).not.toMatch(ENDED);
        expect(window.sessionStorage.getItem(group.slot())).toBe(k1);
      },
    );

    it.each([
      ['another person', bindingOf('owner-tag-A', 'session-tag-1', OTHER_PERSON)],
      ['another organization', bindingOf('owner-tag-B', 'session-tag-1')],
      ['another login', bindingOf('owner-tag-A', 'session-tag-2')],
    ] as const)(
      'addendum D: %s takes the page while /auth/session is pending: the late 401 never reaches its form',
      async (_label, other) => {
        const view = await ownSendFails(group);
        stillAsking();
        view.rerender(group.page(K2, other));
        await waitFor(() => expect(view.container.textContent).not.toBe(''));

        await answerProbe(401);

        expect(document.body.textContent).not.toMatch(ENDED);
        expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
      },
    );

    it('addendum D: a newer press out when the 401 arrives — neither it nor its answer shows “session ended”', async () => {
      await ownSendFails(group);
      const k1 = window.sessionStorage.getItem(group.slot());
      const retried = deferred<unknown>();
      group.action.mockImplementationOnce(() => retried.promise);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: RETRY }));
      });

      await answerProbe(401);
      expect(document.body.textContent).not.toMatch(ENDED);

      await act(async () => {
        retried.resolve(group.unconfirmed(formOf(group.action.mock.calls[1]!), K1, 'COR_RETRY'));
        await retried.promise;
      });
      expect(document.body.textContent).not.toMatch(ENDED);
      expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
      expect(sentIds(group)).toEqual([K1, K1]);
      expect(setAside()).toEqual([]);
      expect(JSON.parse(window.sessionStorage.getItem(group.slot())!)).toMatchObject({
        submissionId: K1,
      });
      expect(window.sessionStorage.getItem(group.slot())).not.toBeNull();
      expect(k1).not.toBeNull();
    });
  });

  it('addendum E: a dispute stamp withdrawn while /auth/session is pending stays withdrawn after its 401', async () => {
    const view = await ownSendFails(dispute);
    stillAsking();
    expect(JSON.parse(window.sessionStorage.getItem(dispute.slot())!)).toMatchObject({
      replay: STAMP,
    });
    // The service withdraws the stamp meanwhile (a late answer past the deadline).
    disputeStore.answerUnresolvedDispute(
      'TXN_1',
      {
        command: 'DISPUTE',
        submissionId: K1,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASONS.one },
        correlationId: 'COR_LATE',
        replay: null,
      },
      BINDING,
    );
    const withdrawn = window.sessionStorage.getItem(dispute.slot());

    await answerProbe(401);

    expect(window.sessionStorage.getItem(dispute.slot())).toBe(withdrawn);
    expect(JSON.parse(withdrawn!)).toMatchObject({ replay: null, text: REASONS.one });
    expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
    view.unmount();
    render(dispute.page(K1));
    await waitFor(() => expect(document.body.textContent).not.toBe(''));
    expect(screen.queryByRole('button', { name: RETRY })).toBeNull();
    expect(sentIds(dispute)).toEqual([K1]);
  });
});
