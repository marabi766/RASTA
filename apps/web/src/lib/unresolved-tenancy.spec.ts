/**
 * Every unresolved store keeps its entries per person and organization (task
 * 100, PR 405 review 1 F1) — the seven of them, through one table, with the
 * tags the server really computes (`submissionBinding`) for one person who
 * acts for A, switches to B and comes back.
 *
 * - B's pages neither show nor resolve A's entry, and B's own entry in the same
 *   scope is not held by it;
 * - nothing of A's is removed by B's account boundary, and back on A it is all
 *   there, exactly as it could act before (retryable only where it was);
 * - an answer of A's that lands after the switch is A's, never B's;
 * - another person's page removes everything, and a logout empties or reduces
 *   everything, as before;
 * - an entry from before entries were kept per organization is never retagged
 *   and never re-sent: shown view-only and holding its scope, kept for its
 *   person only.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { submissionBinding } =
  require('@/server/submission') as typeof import('@/server/submission');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
const order = require('./unresolved-order') as typeof import('./unresolved-order');
const dispute = require('./unresolved-dispute') as typeof import('./unresolved-dispute');
const ret = require('./unresolved-return') as typeof import('./unresolved-return');
const statement = require('./unresolved-statement') as typeof import('./unresolved-statement');
const contract =
  require('./unresolved-contract-command') as typeof import('./unresolved-contract-command');
const bid = require('./unresolved-bid') as typeof import('./unresolved-bid');
const owner =
  require('./unresolved-tender-command') as typeof import('./unresolved-tender-command');
const { EMPTY_DISPUTE_FORM } =
  require('./transaction-dispute-fields') as typeof import('./transaction-dispute-fields');
const { legacyKey, tenantKey } =
  require('./unresolved-tenancy') as typeof import('./unresolved-tenancy');
/* eslint-enable @typescript-eslint/no-require-imports */

type Binding = import('./unresolved-tenancy').Binding;
type AccountTags = import('./unresolved-tenancy').AccountTags;
type WebSession = import('@/server/session').WebSession;

const A = 'ORG-DEH-0001';
const B = 'ORG-DEH-0002';
const MAX_AGE = 12 * 60 * 60;
const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const K1 = 'sub_FIRSTKEYFIRSTKEYFIRS';
const K2 = 'sub_SECONDKEYSECONDKEYSE';

function sessionFor(org: string, subject = 'USR_1'): WebSession {
  return {
    subject,
    username: 'u',
    organizationId: org,
    // A member of both: the token lists both, and acts for one.
    accessToken: actingAccessToken(org, ['ORGANIZATION_ADMIN'], { org_ids: [A, B] }),
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'r',
    csrfToken: 'one-login',
    issuedAt: 1_900_000_000,
  };
}

const inA = submissionBinding(sessionFor(A));
const inB = submissionBinding(sessionFor(B));
const someoneElse = submissionBinding(sessionFor(A, 'USR_2'));
const tagsOf = (binding: Binding): AccountTags => ({
  person: binding.person,
  legacy: binding.legacy,
});

type Kind = 'RETRYABLE' | 'VIEW_ONLY';
interface StoreUnderTest {
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
}

const outcome = (saved: boolean | string): string =>
  saved === true ? 'SAVED' : saved === false ? 'UNAVAILABLE' : saved;

const STATEMENT_SCOPE = { contractId: 'CTR_1', statementId: 'STM_1' };
const CONTRACT_SCOPE = { contractId: 'CTR_1', slot: 'CONTRACT' as const, subjectId: null };
const RETURN_SCOPE = { kind: 'RETURN' as const, returnId: 'RET_1' };

const STORES: StoreUnderTest[] = [
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
  },
];

const keys = () => Object.keys(window.sessionStorage).sort();

beforeEach(() => {
  window.sessionStorage.clear();
  for (const store of STORES) store.open();
});

it('one person acting for A and for B: one person tag, two owners, two login tags', () => {
  expect(inB.person).toBe(inA.person);
  expect(inB.owner).not.toBe(inA.owner);
  expect(inB.session).not.toBe(inA.session);
  expect(someoneElse.person).not.toBe(inA.person);
  // Entries from before: either organization's old tag is this person's.
  expect(inB.legacy).toContain(inA.owner);
  expect(inB.legacy).not.toContain(someoneElse.owner);
});

describe.each(STORES)('the $name store', (store) => {
  const keyIn = (binding: Binding) => tenantKey(store.prefix, binding, store.scope);
  const retryable: Kind = store.retries ? 'RETRYABLE' : 'VIEW_ONLY';

  it('A → B → A: B neither shows nor clears A’s entry; back on A it is there as it was', () => {
    expect(store.save(inA, K1)).toBe('SAVED');

    // On B: not shown, and B's account boundary removes nothing of A's.
    expect(store.restore(inB)).toBeNull();
    store.purgeForeign(tagsOf(inB));
    expect(keys()).toEqual([keyIn(inA)]);
    // B's own command in the same scope is B's: not held by A's.
    expect(store.save(inB, K2)).toBe('SAVED');
    expect(store.restore(inB)).toEqual({ kind: retryable, id: K2 });
    // B setting its own aside never touches A's.
    store.clear(inB, K2);
    store.clear(inB, K1);
    expect(keys()).toEqual([keyIn(inA)]);

    // Back on A: the same entry, with what it could do before — and no more.
    store.purgeForeign(tagsOf(inA));
    expect(store.restore(inA)).toEqual({ kind: retryable, id: K1 });
  });

  it('an answer of A’s that lands after the switch is stored as A’s, never shown on B', () => {
    // B's page is up; A's form, still mounted elsewhere, gets its late answer.
    expect(store.restore(inB)).toBeNull();
    store.save(inA, K1, null);
    store.save(inA, K1, 'COR_LATE');
    expect(store.restore(inB)).toBeNull();
    expect(keys()).toEqual([keyIn(inA)]);
    expect(store.restore(inA)?.id).toBe(K1);
  });

  it('another person’s page removes every entry of this person, every organization’s', () => {
    store.save(inA, K1);
    store.save(inB, K2);
    store.purgeForeign(tagsOf(someoneElse));
    expect(keys()).toEqual([]);
  });

  it('a logout leaves nothing that can be sent again, in either organization', () => {
    store.save(inA, K1);
    store.save(inB, K2);
    store.purgeAll();
    store.open();
    for (const binding of [inA, inB]) {
      expect(store.restore(binding)?.kind ?? 'GONE').not.toBe('RETRYABLE');
    }
  });

  describe('an entry from before entries were kept per organization', () => {
    /** Written by the old code: the same content, under the key with no person or owner. */
    function legacyEntry(binding: Binding, id: string): string {
      store.save(binding, id);
      const raw = window.sessionStorage.getItem(keyIn(binding))!;
      window.sessionStorage.removeItem(keyIn(binding));
      window.sessionStorage.setItem(legacyKey(store.prefix, store.scope), raw);
      return raw;
    }

    it('is shown view-only in either organization — never re-sent, even by the login that wrote it', () => {
      const raw = legacyEntry(inA, K1);
      expect(store.restore(inA)).toEqual({ kind: 'VIEW_ONLY', id: K1 });
      expect(store.restore(inB)).toEqual({ kind: 'VIEW_ONLY', id: K1 });
      // Never retagged.
      expect(window.sessionStorage.getItem(legacyKey(store.prefix, store.scope))).toBe(raw);
    });

    if (store.holds) {
      it('holds its scope: no other submission is sent over it', () => {
        legacyEntry(inA, K1);
        expect(store.save(inB, K2)).not.toBe('SAVED');
        expect(store.save(inA, K1)).not.toBe('SAVED');
        expect(keys()).toEqual([legacyKey(store.prefix, store.scope)]);
      });
    }

    it('is kept by this person’s pages, removed by another person’s', () => {
      legacyEntry(inA, K1);
      store.purgeForeign(tagsOf(inB));
      expect(keys()).toEqual([legacyKey(store.prefix, store.scope)]);
      store.purgeForeign(tagsOf(someoneElse));
      expect(keys()).toEqual([]);
    });

    it('another person’s is not shown and is removed', () => {
      legacyEntry(someoneElse, K1);
      expect(store.restore(inA)).toBeNull();
      expect(keys()).toEqual([]);
    });
  });
});

export {};
