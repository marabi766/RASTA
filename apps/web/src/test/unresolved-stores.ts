import * as order from '@/lib/unresolved-order';
import * as dispute from '@/lib/unresolved-dispute';
import * as ret from '@/lib/unresolved-return';
import * as statement from '@/lib/unresolved-statement';
import * as contract from '@/lib/unresolved-contract-command';
import * as bid from '@/lib/unresolved-bid';
import * as owner from '@/lib/unresolved-tender-command';
import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import type { AccountTags, Binding, QuarantineSource } from '@/lib/unresolved-tenancy';

/**
 * The seven stores that keep an unresolved submission in `sessionStorage`,
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
  save(binding: Binding, id: string, correlationId?: string | null): string;
  restore(binding: Binding): { kind: Kind; id: string } | null;
  clear(binding: Binding, id: string): void;
  purgeForeign(tags: AccountTags): void;
  purgeAll(): void;
  open(): void;
  /** The store's own quarantine, as its form's gate reads it. */
  readonly quarantine: QuarantineSource;
}

const outcome = (saved: boolean | string): string =>
  saved === true ? 'SAVED' : saved === false ? 'UNAVAILABLE' : saved;

const STATEMENT_SCOPE = { contractId: 'CTR_1', statementId: 'STM_1' };
const CONTRACT_SCOPE = { contractId: 'CTR_1', slot: 'CONTRACT' as const, subjectId: null };
const RETURN_SCOPE = { kind: 'RETURN' as const, returnId: 'RET_1' };

export const STORES: StoreUnderTest[] = [
  {
    name: 'order',
    prefix: 'rasta.unresolved-order.',
    scope: 'PRD_1',
    holds: false,
    retries: true,
    save: (b, id, correlationId = 'COR') =>
      outcome(
        order.saveUnresolvedOrder(
          'PRD_1',
          { submissionId: id, values: { offerId: 'OFR_1', quantity: '3' }, correlationId },
          b,
        ),
      ),
    restore: (b) => {
      const found = order.restoreUnresolvedOrder('PRD_1', b, MAX_AGE);
      return found && { kind: found.kind, id: found.order.submissionId };
    },
    clear: (b) => order.clearUnresolvedOrder('PRD_1', b),
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
      outcome(
        dispute.saveUnresolvedDispute(
          'TXN_1',
          {
            command: 'DISPUTE',
            submissionId: id,
            values: { ...EMPTY_DISPUTE_FORM, reason: 'کالا نرسید' },
            correlationId,
            replay: STAMP,
          },
          b,
        ),
      ),
    restore: (b) => {
      const found = dispute.restoreUnresolvedDispute('TXN_1', b, MAX_AGE);
      return found && { kind: found.kind, id: found.dispute.submissionId };
    },
    clear: (b) => dispute.clearUnresolvedDispute('TXN_1', b),
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
];
