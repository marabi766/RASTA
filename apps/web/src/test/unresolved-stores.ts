import * as order from '@/lib/unresolved-order';
import * as dispute from '@/lib/unresolved-dispute';
import * as ret from '@/lib/unresolved-return';
import * as statement from '@/lib/unresolved-statement';
import * as contract from '@/lib/unresolved-contract-command';
import * as bid from '@/lib/unresolved-bid';
import * as owner from '@/lib/unresolved-tender-command';
import * as inventory from '@/lib/unresolved-inventory';
import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import {
  type AccountTags,
  type Attempt,
  type Binding,
  type QuarantineSource,
  type Settlement,
  type StartOutcome,
} from '@/lib/unresolved-tenancy';

/**
 * The eight stores that keep an unresolved submission in `sessionStorage`,
 * driven through one shape so a spec can state a rule once for all of them
 * (`lib/unresolved-tenancy.spec.ts`, `lib/unresolved-quarantine.spec.ts`).
 */

export const MAX_AGE = 12 * 60 * 60;
export const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
export const K1 = 'sub_FIRSTKEYFIRSTKEYFIRS';
export const K2 = 'sub_SECONDKEYSECONDKEYSE';

export type Kind = 'RETRYABLE' | 'VIEW_ONLY';
export interface StoreUnderTest {
  readonly name: string;
  readonly prefix: string;
  readonly scope: string;
  /** Whether an unresolved entry holds its scope against another submission. */
  readonly holds: boolean;
  /** Whether a restored entry may be sent again at all (a marker store never). */
  readonly retries: boolean;
  /**
   * Before the first send (`start`): its outcome. A `SAVED` one's send identity
   * is kept here as the newest first send of `id` (`started`).
   */
  save(binding: Binding, id: string, correlationId?: string | null): string;
  /** The identity the slot wrote for the newest saved first send of `id`, whoever saved it. */
  started(binding: Binding, id: string): Attempt;
  /** A later answer still in doubt to send `attempt` (default `started`, or null when none was saved): an `AnswerOutcome`. */
  answer(
    binding: Binding,
    id: string,
    correlationId?: string | null,
    attempt?: Attempt | null,
  ): string;
  /** A definite answer to send `attempt` (default `started`, `REFUSED`). */
  settle(binding: Binding, id: string, attempt?: Attempt, settlement?: Settlement): void;
  /** Before a re-send (`advance`): its new identity, or null. */
  advance(binding: Binding, id: string): Attempt | null;
  restore(binding: Binding): { kind: Kind; id: string } | null;
  /** The person's own "set it aside" (`release`). */
  clear(binding: Binding, id: string): void;
  purgeForeign(tags: AccountTags): void;
  purgeAll(): void;
  open(): void;
  /** The store's own quarantine, as its form's gate reads it. */
  readonly quarantine: QuarantineSource;
}

/** A store as its module exports it: every answer names its send. */
interface RawStore extends Omit<StoreUnderTest, 'save' | 'started' | 'answer' | 'settle'> {
  save(binding: Binding, id: string, correlationId?: string | null): StartOutcome;
  answer(
    binding: Binding,
    id: string,
    correlationId: string | null | undefined,
    attempt: Attempt | null,
  ): string;
  settle(binding: Binding, id: string, attempt: Attempt, settlement?: Settlement): void;
}

/** Keeps every saved send's identity, as the submit path does (`lib/fenced-submission.ts`). */
function tracked(raw: RawStore): StoreUnderTest {
  const sends = new Map<string, Attempt>();
  // By submission id alone: an answer from another organization, person or
  // login then carries the real send's identity, so what refuses it is the
  // rest of the fence — never a mismatched identity.
  const at = (_binding: Binding, id: string) => id;
  const started = (binding: Binding, id: string): Attempt => {
    const attempt = sends.get(at(binding, id));
    if (attempt === undefined) throw new Error(`no saved send of ${id} in ${raw.name}`);
    return attempt;
  };
  return {
    ...raw,
    save(binding, id, correlationId) {
      const outcome = raw.save(binding, id, correlationId);
      if (outcome.outcome === 'SAVED') sends.set(at(binding, id), outcome.attempt);
      return outcome.outcome;
    },
    started,
    // No send of `id` saved here: an answer of a send nothing remembered (null).
    answer: (binding, id, correlationId, attempt) =>
      raw.answer(
        binding,
        id,
        correlationId,
        attempt === undefined ? (sends.get(at(binding, id)) ?? null) : attempt,
      ),
    settle: (binding, id, attempt, settlement) =>
      raw.settle(binding, id, attempt ?? started(binding, id), settlement),
  };
}

const disputeEntry = (id: string, correlationId: string | null) =>
  ({
    command: 'DISPUTE',
    submissionId: id,
    values: { ...EMPTY_DISPUTE_FORM, reason: 'کالا نرسید' },
    correlationId,
    replay: STAMP,
  }) as const;

const STATEMENT_SCOPE = { contractId: 'CTR_1', statementId: 'STM_1' };
const CONTRACT_SCOPE = { contractId: 'CTR_1', slot: 'CONTRACT' as const, subjectId: null };
const RETURN_SCOPE = { kind: 'RETURN' as const, returnId: 'RET_1' };
const INVENTORY_SCOPE = { kind: 'SHIPMENT' as const, shipmentId: 'SHP_1' };

const RAW_STORES: RawStore[] = [
  {
    name: 'order',
    prefix: 'rasta.unresolved-order.',
    scope: 'PRD_1',
    holds: true,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      order.saveUnresolvedOrder(
        'PRD_1',
        {
          submissionId: id,
          values: { offerId: 'OFR_1', quantity: '3', offerStamp: 'stamp-OFR_1' },
          correlationId,
        },
        b,
      ),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      order.answerUnresolvedOrder(
        'PRD_1',
        {
          submissionId: id,
          values: { offerId: 'OFR_1', quantity: '3', offerStamp: 'stamp-OFR_1' },
          correlationId,
        },
        b,
        attempt,
      ),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      order.settleUnresolvedOrder('PRD_1', id, b, attempt, settlement),
    advance: (b, id) => order.advanceUnresolvedOrder('PRD_1', id, b),
    restore: (b) => {
      const found = order.restoreUnresolvedOrder('PRD_1', b, MAX_AGE);
      return found && { kind: found.kind, id: found.order.submissionId };
    },
    clear: (b, id) => order.clearUnresolvedOrder('PRD_1', id, b),
    purgeForeign: order.purgeForeignUnresolvedOrders,
    purgeAll: order.purgeAllUnresolvedOrders,
    open: order.markAccountOpen,
    quarantine: order.orderQuarantine,
  },
  {
    name: 'dispute',
    prefix: 'rasta.unresolved-dispute.',
    scope: 'TXN_1',
    holds: true,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      dispute.saveUnresolvedDispute('TXN_1', disputeEntry(id, correlationId), b),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      dispute.answerUnresolvedDispute('TXN_1', disputeEntry(id, correlationId), b, attempt),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      dispute.settleUnresolvedDispute('TXN_1', id, b, attempt, settlement),
    advance: (b, id) => dispute.advanceUnresolvedDispute('TXN_1', id, b),
    restore: (b) => {
      const found = dispute.restoreUnresolvedDispute('TXN_1', b, MAX_AGE);
      return found && { kind: found.kind, id: found.dispute.submissionId };
    },
    clear: (b, id) => dispute.clearUnresolvedDispute('TXN_1', id, b),
    purgeForeign: dispute.purgeForeignUnresolvedDisputes,
    purgeAll: dispute.purgeAllUnresolvedDisputes,
    open: dispute.markDisputesOpen,
    quarantine: dispute.disputeQuarantine,
  },
  {
    name: 'return',
    prefix: 'rasta.unresolved-return.',
    scope: 'return.RET_1',
    holds: true,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      ret.saveUnresolvedReturn(
        RETURN_SCOPE,
        { command: 'AUTHORIZE', submissionId: id, body: null, correlationId, replay: STAMP },
        b,
      ),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      ret.answerUnresolvedReturn(
        RETURN_SCOPE,
        { command: 'AUTHORIZE', submissionId: id, body: null, correlationId, replay: STAMP },
        b,
        attempt,
      ),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      ret.settleUnresolvedReturn(RETURN_SCOPE, id, b, attempt, settlement),
    advance: (b, id) => ret.advanceUnresolvedReturn(RETURN_SCOPE, id, b),
    restore: (b) => {
      const found = ret.restoreUnresolvedReturn(RETURN_SCOPE, b, MAX_AGE);
      return found && { kind: found.kind, id: found.entry.submissionId };
    },
    clear: (b, id) => ret.clearUnresolvedReturn(RETURN_SCOPE, id, b),
    purgeForeign: ret.purgeForeignUnresolvedReturns,
    purgeAll: ret.purgeAllUnresolvedReturns,
    open: ret.markReturnsOpen,
    quarantine: ret.returnQuarantine,
  },
  {
    name: 'statement',
    prefix: 'rasta.unresolved-statement.',
    scope: 'CTR_1.STM_1',
    holds: true,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      statement.saveUnresolvedStatement(
        STATEMENT_SCOPE,
        { command: 'APPROVE', submissionId: id, lines: [], correlationId, replay: STAMP },
        b,
      ),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      statement.answerUnresolvedStatement(
        STATEMENT_SCOPE,
        { command: 'APPROVE', submissionId: id, lines: [], correlationId, replay: STAMP },
        b,
        attempt,
      ),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      statement.settleUnresolvedStatement(STATEMENT_SCOPE, id, b, attempt, settlement),
    advance: (b, id) => statement.advanceUnresolvedStatement(STATEMENT_SCOPE, id, b),
    restore: (b) => {
      const found = statement.restoreUnresolvedStatement(STATEMENT_SCOPE, b, MAX_AGE);
      return found && { kind: found.kind, id: found.entry.submissionId };
    },
    clear: (b, id) => statement.clearUnresolvedStatement(STATEMENT_SCOPE, id, b),
    purgeForeign: statement.purgeForeignUnresolvedStatements,
    purgeAll: statement.purgeAllUnresolvedStatements,
    open: statement.markStatementsOpen,
    quarantine: statement.statementQuarantine,
  },
  {
    name: 'contract command',
    prefix: 'rasta.unresolved-contract.',
    scope: 'CTR_1.CONTRACT.-',
    holds: true,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      contract.saveUnresolvedContractCommand(
        CONTRACT_SCOPE,
        { command: 'SIGN', submissionId: id, input: null, correlationId, replay: STAMP },
        b,
      ),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      contract.answerUnresolvedContractCommand(
        CONTRACT_SCOPE,
        { command: 'SIGN', submissionId: id, input: null, correlationId, replay: STAMP },
        b,
        attempt,
      ),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      contract.settleUnresolvedContractCommand(CONTRACT_SCOPE, id, b, attempt, settlement),
    advance: (b, id) => contract.advanceUnresolvedContractCommand(CONTRACT_SCOPE, id, b),
    restore: (b) => {
      const found = contract.restoreUnresolvedContractCommand(CONTRACT_SCOPE, b, MAX_AGE);
      return found && { kind: found.kind, id: found.entry.submissionId };
    },
    clear: (b, id) => contract.clearUnresolvedContractCommand(CONTRACT_SCOPE, id, b),
    purgeForeign: contract.purgeForeignUnresolvedContractCommands,
    purgeAll: contract.purgeAllUnresolvedContractCommands,
    open: contract.markContractCommandsOpen,
    quarantine: contract.contractCommandQuarantine,
  },
  {
    name: 'bid',
    prefix: 'rasta.unresolved-bid.',
    scope: 'TND_1',
    holds: true,
    retries: false,
    save: (b, id, correlationId = 'COR') =>
      bid.saveUnresolvedBid('TND_1', { command: 'SUBMIT', submissionId: id, correlationId }, b),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      bid.answerUnresolvedBid(
        'TND_1',
        { command: 'SUBMIT', submissionId: id, correlationId },
        b,
        attempt,
      ),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      bid.settleUnresolvedBid('TND_1', id, b, attempt, settlement),
    advance: (b, id) => bid.advanceUnresolvedBid('TND_1', id, b),
    restore: (b) => {
      const found = bid.restoreUnresolvedBid('TND_1', b);
      return found && { kind: 'VIEW_ONLY', id: found.submissionId };
    },
    clear: (b, id) => bid.clearUnresolvedBid('TND_1', id, b),
    purgeForeign: bid.purgeForeignUnresolvedBids,
    purgeAll: bid.purgeAllUnresolvedBids,
    open: bid.markBidsOpen,
    quarantine: bid.bidQuarantine,
  },
  {
    name: 'tender owner command',
    prefix: 'rasta.unresolved-tender-command.',
    scope: 'TND_1',
    holds: true,
    retries: false,
    save: (b, id, correlationId = 'COR') =>
      owner.saveUnresolvedOwnerCommand(
        'TND_1',
        { command: 'PUBLISH', submissionId: id, correlationId },
        b,
      ),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      owner.answerUnresolvedOwnerCommand(
        'TND_1',
        { command: 'PUBLISH', submissionId: id, correlationId },
        b,
        attempt,
      ),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      owner.settleUnresolvedOwnerCommand('TND_1', id, b, attempt, settlement),
    advance: (b, id) => owner.advanceUnresolvedOwnerCommand('TND_1', id, b),
    restore: (b) => {
      const found = owner.restoreUnresolvedOwnerCommand('TND_1', b);
      return found && { kind: 'VIEW_ONLY', id: found.submissionId };
    },
    clear: (b, id) => owner.clearUnresolvedOwnerCommand('TND_1', id, b),
    purgeForeign: owner.purgeForeignUnresolvedOwnerCommands,
    purgeAll: owner.purgeAllUnresolvedOwnerCommands,
    open: owner.markOwnerCommandsOpen,
    quarantine: owner.ownerCommandQuarantine,
  },
  {
    name: 'inventory',
    prefix: 'rasta.unresolved-inventory.',
    scope: 'shipment.SHP_1',
    holds: true,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      inventory.saveUnresolvedInventory(
        INVENTORY_SCOPE,
        {
          command: 'DISPATCH_SHIPMENT',
          submissionId: id,
          body: null,
          correlationId,
          replay: STAMP,
        },
        b,
      ),
    answer: (b, id, correlationId = 'COR_LATE', attempt) =>
      inventory.answerUnresolvedInventory(
        INVENTORY_SCOPE,
        {
          command: 'DISPATCH_SHIPMENT',
          submissionId: id,
          body: null,
          correlationId,
          replay: STAMP,
        },
        b,
        attempt,
      ),
    settle: (b, id, attempt, settlement = 'REFUSED') =>
      inventory.settleUnresolvedInventory(INVENTORY_SCOPE, id, b, attempt, settlement),
    advance: (b, id) => inventory.advanceUnresolvedInventory(INVENTORY_SCOPE, id, b),
    restore: (b) => {
      const found = inventory.restoreUnresolvedInventory(INVENTORY_SCOPE, b, MAX_AGE);
      return found && { kind: found.kind, id: found.entry.submissionId };
    },
    clear: (b, id) => inventory.clearUnresolvedInventory(INVENTORY_SCOPE, id, b),
    purgeForeign: inventory.purgeForeignUnresolvedInventory,
    purgeAll: inventory.purgeAllUnresolvedInventory,
    open: inventory.markInventoryOpen,
    quarantine: inventory.inventoryQuarantine,
  },
];

export const STORES: StoreUnderTest[] = RAW_STORES.map(tracked);

/** A first send's identity, from a store's `save` that must have saved (`StartOutcome`). */
export function savedAttempt(outcome: StartOutcome): Attempt {
  if (outcome.outcome !== 'SAVED') throw new Error(`not saved: ${outcome.outcome}`);
  return outcome.attempt;
}

/** The send identity the slot wrote into the entry under `key` — as a mounted form's send left it. */
export function attemptAt(key: string): Attempt {
  const raw = window.sessionStorage.getItem(key);
  const attempt = raw === null ? undefined : (JSON.parse(raw) as { attempt?: unknown }).attempt;
  if (typeof attempt !== 'string') throw new Error(`no send identity under ${key}`);
  return attempt as Attempt;
}
