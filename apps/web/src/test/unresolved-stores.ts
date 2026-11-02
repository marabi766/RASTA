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
  FIRST_ATTEMPT,
  type AccountTags,
  type Attempt,
  type Binding,
  type QuarantineSource,
  type Settlement,
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
  /** Before the first send (`start`). */
  save(binding: Binding, id: string, correlationId?: string | null): string;
  /** A later answer still in doubt to send `attempt` (default the first): an `AnswerOutcome`. */
  answer(binding: Binding, id: string, correlationId?: string | null, attempt?: Attempt): string;
  /** A definite answer to send `attempt` (default the first, `REFUSED`). */
  settle(binding: Binding, id: string, attempt?: Attempt, settlement?: Settlement): void;
  /** Before a re-send (`advance`): the next generation, or null. */
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

export const STORES: StoreUnderTest[] = [
  {
    name: 'order',
    prefix: 'rasta.unresolved-order.',
    scope: 'PRD_1',
    holds: true,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      order.saveUnresolvedOrder(
        'PRD_1',
        { submissionId: id, values: { offerId: 'OFR_1', quantity: '3' }, correlationId },
        b,
      ),
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
      order.answerUnresolvedOrder(
        'PRD_1',
        { submissionId: id, values: { offerId: 'OFR_1', quantity: '3' }, correlationId },
        b,
        attempt,
      ),
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
      dispute.answerUnresolvedDispute('TXN_1', disputeEntry(id, correlationId), b, attempt),
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
      ret.answerUnresolvedReturn(
        RETURN_SCOPE,
        { command: 'AUTHORIZE', submissionId: id, body: null, correlationId, replay: STAMP },
        b,
        attempt,
      ),
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
      statement.answerUnresolvedStatement(
        STATEMENT_SCOPE,
        { command: 'APPROVE', submissionId: id, lines: [], correlationId, replay: STAMP },
        b,
        attempt,
      ),
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
      contract.answerUnresolvedContractCommand(
        CONTRACT_SCOPE,
        { command: 'SIGN', submissionId: id, input: null, correlationId, replay: STAMP },
        b,
        attempt,
      ),
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
      bid.answerUnresolvedBid(
        'TND_1',
        { command: 'SUBMIT', submissionId: id, correlationId },
        b,
        attempt,
      ),
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
      owner.answerUnresolvedOwnerCommand(
        'TND_1',
        { command: 'PUBLISH', submissionId: id, correlationId },
        b,
        attempt,
      ),
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
    answer: (b, id, correlationId = 'COR_LATE', attempt = FIRST_ATTEMPT) =>
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
    settle: (b, id, attempt = FIRST_ATTEMPT, settlement = 'REFUSED') =>
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
