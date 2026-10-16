import { Logger } from '@nestjs/common';
import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  assertMayRefund,
  assertNotAuditor,
  assertPlatformScope,
  assertTransactionVisible,
  assertWalletVisible,
  canActFinanciallyFor,
  canCommitOrganization,
  hasPlatformScope,
  isIssuedSettlementBooks,
  recordFinancialCommand,
  settlementBooks,
  type FinancialCommand,
} from './access';
import type { HierarchyQuestion } from '../organization/organization-hierarchy';

/**
 * Object-level authorization — docs/09 § 9.3 calls it the most critical layer,
 * and in this service it is the difference between reading one organization's
 * balances and reading everybody's.
 *
 * The suite is organised around the one rule that is absolute:
 *
 * > **CONSTRAINT (product document, ch. 4):** the province oversight role has
 * > aggregate access only, "بدون دسترسی به جزئیات تراکنش‌های فردی".
 *
 * `AUDITOR` is therefore refused *every* entry point here, and each one is
 * asserted separately rather than through a loop over a list — because a loop
 * over a list is exactly what stops covering a function somebody adds later.
 */

function asUser(roles: string[], organizationId = 'ORG-A', userId = 'USR-1'): RequestContext {
  return {
    correlationId: 'corr-1',
    requestId: 'req-1',
    organizationId,
    userId,
    roles,
    organizationIds: [],
    authType: 'USER',
    startedAt: Date.now(),
  };
}

function asService(
  callerService = 'marketplace-service',
  organizationId = 'ORG-A',
): RequestContext {
  return {
    correlationId: 'corr-1',
    requestId: 'req-1',
    organizationId,
    roles: ['SYSTEM'],
    organizationIds: [],
    authType: 'SERVICE',
    callerService,
    startedAt: Date.now(),
  };
}

const run = <T>(context: RequestContext, fn: () => T): T => runWithContext(context, fn);

describe('the oversight role reaches nothing in this service', () => {
  const auditor = asUser(['AUDITOR']);

  it('is refused outright', () => {
    expect(() => run(auditor, () => assertNotAuditor())).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('is refused the trial balance', () => {
    expect(() => run(auditor, () => assertPlatformScope('The trial balance'))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('is refused a wallet it would otherwise own', () => {
    expect(() =>
      run(auditor, () => assertWalletVisible({ id: 'WLT_1', organizationId: 'ORG-A' })),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('is refused a transaction it would otherwise be party to', () => {
    expect(() =>
      run(auditor, () =>
        assertTransactionVisible({
          id: 'TXN_1',
          organizationId: 'ORG-A',
          counterpartyOrganizationId: null,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('is refused the ability to commit its own organization', () => {
    expect(() => run(auditor, () => canCommitOrganization('ORG-A'))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('is refused even when it also holds an administrative role', () => {
    // The check is on the presence of AUDITOR, not on the absence of anything
    // else. A user carrying both must not get row-level financial data.
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN', 'AUDITOR']), () => canCommitOrganization('ORG-A')),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('never gains platform scope', () => {
    expect(run(auditor, () => hasPlatformScope())).toBe(false);
  });
});

describe('platform scope', () => {
  it('is held by SYSTEM_ADMIN and UNION_ADMIN', () => {
    // docs/09 § 9.3 lists both as Platform-scope roles, which is what makes
    // the platform-wide trial balance legitimately theirs.
    expect(run(asUser(['SYSTEM_ADMIN']), () => hasPlatformScope())).toBe(true);
    expect(run(asUser(['UNION_ADMIN']), () => hasPlatformScope())).toBe(true);
  });

  it('is not held by an organization administrator', () => {
    expect(run(asUser(['ORGANIZATION_ADMIN']), () => hasPlatformScope())).toBe(false);
    expect(() => run(asUser(['ORGANIZATION_ADMIN']), () => assertPlatformScope('x'))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('is not granted to a service caller', () => {
    // `@AllowService` established that the calling *service* may use the
    // endpoint. Whether a cross-tenant report of every organization's balances
    // should be readable over an internal call is a different question, and the
    // conservative answer is the right one.
    expect(run(asService(), () => hasPlatformScope())).toBe(false);
    expect(() => run(asService(), () => assertPlatformScope('The trial balance'))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

describe('canCommitOrganization', () => {
  it('permits an organization administrator over their own organization', () => {
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN']), () => canCommitOrganization('ORG-A')),
    ).not.toThrow();
  });

  it('refuses an operator, who may report but not pay', () => {
    // The same narrowing maintenance-service applied for the same reason
    // (ADR-029): reporting a breakdown and authorising the payment for it are
    // different authorities.
    for (const role of ['OPERATOR', 'DRIVER', 'FLEET_MANAGER', 'WORKSHOP', 'SUPPLIER']) {
      expect(() => run(asUser([role]), () => canCommitOrganization('ORG-A'))).toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
    }
  });

  it('refuses an administrator acting for another organization', () => {
    // 403 rather than 404 here, because the caller already knows which
    // organization they asked to act for — nothing is disclosed by saying no.
    expect(() => run(asUser(['ORGANIZATION_ADMIN']), () => canCommitOrganization('ORG-B'))).toThrow(
      expect.objectContaining({ code: 'TENANT_MISMATCH' }),
    );
  });

  it('permits a platform administrator to act for another organization', () => {
    // What makes a stuck settlement resolvable at all.
    expect(() => run(asUser(['UNION_ADMIN']), () => canCommitOrganization('ORG-B'))).not.toThrow();
  });

  it('permits a service caller to commit the organization its token names', () => {
    // marketplace-service settling an order it owns is the documented flow
    // (docs/08 § 8.6). `asService()` carries a token signed for ORG-A.
    expect(() => run(asService(), () => canCommitOrganization('ORG-A'))).not.toThrow();
  });

  it('refuses a service caller acting for an organization its token does not name', () => {
    // ADR-035. `@AllowService` exempts a service from the *role* check and
    // from nothing else: its signed `org_id` is the organization it may commit,
    // and one signed for ORG-A cannot move ORG-Z's money.
    expect(() => run(asService(), () => canCommitOrganization('ORG-Z'))).toThrow(
      expect.objectContaining({ code: 'TENANT_MISMATCH' }),
    );
  });

  it('refuses a service caller whose token carries no organization at all', () => {
    // The claim-less token a platform-wide internal operation would use. It
    // reaches a tenant-scoped commit and is refused with the platform's own
    // 403 rather than an unhandled error.
    const tenantless: RequestContext = {
      correlationId: 'corr-1',
      requestId: 'req-1',
      roles: ['SERVICE'],
      organizationIds: [],
      authType: 'SERVICE',
      callerService: 'marketplace-service',
      startedAt: Date.now(),
    };
    expect(() => run(tenantless, () => canCommitOrganization('ORG-A'))).toThrow(
      expect.objectContaining({ code: 'SERVICE_TENANT_CONTEXT_INVALID' }),
    );
  });

  it('refuses a user request with no organization at all, and loudly', () => {
    // A user context with no tenant reaches this only through a
    // misconfiguration — the guard resolves one for every authenticated user —
    // so it stays a raw error rather than becoming an ordinary-looking 403
    // that somebody could mistake for a normal authorization outcome.
    const anonymous: RequestContext = {
      correlationId: 'corr-1',
      requestId: 'req-1',
      roles: ['ORGANIZATION_ADMIN'],
      organizationIds: [],
      authType: 'USER',
      startedAt: Date.now(),
    };
    expect(() => run(anonymous, () => canCommitOrganization('ORG-A'))).toThrow(
      /tenant-scoped data was accessed/,
    );
  });

  it('refuses the oversight role even for its own organization', () => {
    expect(() => run(asUser(['AUDITOR']), () => canCommitOrganization('ORG-A'))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

/**
 * organization-service's hierarchy as these tests need it: ORG-U is a union
 * with ORG-B beneath it (through ORG-COUNTY); ORG-S is another union with
 * nothing of these beneath it. Every question is recorded.
 */
function hierarchy(): HierarchyQuestion & { asked: [string, string][] } {
  const parent: Record<string, string> = { 'ORG-B': 'ORG-COUNTY', 'ORG-COUNTY': 'ORG-U' };
  const asked: [string, string][] = [];
  return {
    asked,
    withinVersion: async (scope, organizationId) => {
      asked.push([scope, organizationId]);
      for (let at: string | undefined = organizationId; at; at = parent[at]) {
        if (at === scope) return { hierarchyVersion: 7 };
      }
      return null;
    },
  };
}

/** organization-service cannot be reached. */
const unreachable: HierarchyQuestion = {
  withinVersion: () => Promise.reject(RastaError.upstreamUnavailable('organization-service')),
};

const OUTSIDE =
  "Acting financially for another organization is limited to the organizations within your union's subtree";

const COMMANDS: FinancialCommand[] = [
  'SETTLE',
  'AUTHORISE_SETTLEMENT',
  'DISPUTE',
  'RESOLVE_DISPUTE',
  'CANCEL',
  'REFUND',
];

describe('canActFinanciallyFor (docs/24 Q-136)', () => {
  // ORG-B's books; the request acts for whichever organization the context names.
  const act = (
    context: RequestContext,
    tree: HierarchyQuestion = hierarchy(),
    command: FinancialCommand = 'SETTLE',
  ) => run(context, () => canActFinanciallyFor(command, 'ORG-B', tree));

  it.each(['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN'])(
    'leaves %s acting for its own organization exactly as before, asking nothing',
    async (role) => {
      const tree = hierarchy();
      await expect(act(asUser([role], 'ORG-B'), tree)).resolves.toMatchObject({
        basis: 'OWN_ORGANIZATION',
        actingOrganizationId: 'ORG-B',
        booksOrganizationId: 'ORG-B',
        hierarchyVersion: null,
      });
      expect(tree.asked).toEqual([]);
    },
  );

  it.each([['SYSTEM_ADMIN'], ['SYSTEM_ADMIN', 'UNION_ADMIN']])(
    'admits %s acting for any other organization, unchanged, asking nothing',
    async (...roles) => {
      const tree = hierarchy();
      await expect(act(asUser(roles, 'ORG-S'), tree)).resolves.toMatchObject({
        basis: 'SYSTEM_ADMIN',
        actingOrganizationId: 'ORG-S',
        booksOrganizationId: 'ORG-B',
      });
      expect(tree.asked).toEqual([]);
    },
  );

  it.each(COMMANDS)(
    'admits a union administrator for an organization within its union, for %s',
    async (command) => {
      const tree = hierarchy();
      await expect(
        act(asUser(['UNION_ADMIN'], 'ORG-U', 'USR-UNION'), tree, command),
      ).resolves.toEqual({
        command,
        basis: 'UNION_SUBTREE',
        actor: 'USR-UNION',
        actingOrganizationId: 'ORG-U',
        booksOrganizationId: 'ORG-B',
        hierarchyVersion: 7,
      });
      // Asked of the owner, for the organization the request acts for — the
      // union — never from anything the client sent.
      expect(tree.asked).toEqual([['ORG-U', 'ORG-B']]);
    },
  );

  it.each(COMMANDS)(
    'refuses a union administrator outside its union with 403 FORBIDDEN, for %s',
    async (command) => {
      const tree = hierarchy();
      await expect(act(asUser(['UNION_ADMIN'], 'ORG-S'), tree, command)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: OUTSIDE,
      });
      expect(tree.asked).toEqual([['ORG-S', 'ORG-B']]);
    },
  );

  it('refuses upward: a union administrator of a member is not within it the other way', async () => {
    const tree = hierarchy();
    await expect(
      run(asUser(['UNION_ADMIN'], 'ORG-B'), () => canActFinanciallyFor('SETTLE', 'ORG-U', tree)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: OUTSIDE });
  });

  it('fails closed when organization-service cannot answer: 503, never "within"', async () => {
    await expect(act(asUser(['UNION_ADMIN'], 'ORG-U'), unreachable)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('refuses everyone else as canCommitOrganization does, asking nothing', async () => {
    const tree = hierarchy();
    await expect(act(asUser(['ORGANIZATION_ADMIN'], 'ORG-U'), tree)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
    await expect(act(asService('marketplace-service', 'ORG-U'), tree)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
    await expect(act(asService('marketplace-service', 'ORG-B'), tree)).resolves.toMatchObject({
      basis: 'OWN_ORGANIZATION',
      actor: 'marketplace-service',
    });
    await expect(act(asUser(['UNION_ADMIN', 'AUDITOR'], 'ORG-U'), tree)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(tree.asked).toEqual([]);
  });

  it('logs a refusal outside the union with actor, acting organization and books', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        run(asUser(['UNION_ADMIN'], 'ORG-S', 'USR-UNION'), () =>
          canActFinanciallyFor('DISPUTE', 'ORG-B', hierarchy()),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(warn).toHaveBeenCalledWith(
        'Financial command DISPUTE refused: actor=USR-UNION actingOrganization=ORG-S ' +
          'booksOrganization=ORG-B reason=OUTSIDE_UNION_SUBTREE',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('recordFinancialCommand', () => {
  it('records who acted, for which organization, on whose books and on what authority', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const authority = await run(asUser(['UNION_ADMIN'], 'ORG-U', 'USR-UNION'), () =>
        canActFinanciallyFor('CANCEL', 'ORG-B', hierarchy()),
      );
      recordFinancialCommand('TXN_1', authority);
      const own = await run(asUser(['ORGANIZATION_ADMIN'], 'ORG-B', 'USR-OWN'), () =>
        canActFinanciallyFor('SETTLE', 'ORG-B', hierarchy()),
      );
      recordFinancialCommand('TXN_2', own);
      expect(log.mock.calls).toEqual([
        [
          'Financial command CANCEL on TXN_1: actor=USR-UNION actingOrganization=ORG-U ' +
            'booksOrganization=ORG-B authority=UNION_SUBTREE hierarchyVersion=7',
        ],
        [
          'Financial command SETTLE on TXN_2: actor=USR-OWN actingOrganization=ORG-B ' +
            'booksOrganization=ORG-B authority=OWN_ORGANIZATION',
        ],
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('settlementBooks (docs/23 D-054)', () => {
  // ORG-B pays; the request acts for whichever organization the context names.
  const books = (context: RequestContext, tree: HierarchyQuestion = hierarchy()) =>
    run(context, () => settlementBooks('ORG-B', tree));

  it('is nothing to cross when the caller acts for the payer', async () => {
    for (const context of [
      asUser(['ORGANIZATION_ADMIN'], 'ORG-B'),
      asUser(['SYSTEM_ADMIN'], 'ORG-B'),
      asService('marketplace-service', 'ORG-B'),
    ]) {
      const { books: issued, authority } = await books(context);
      expect(issued).toBeUndefined();
      expect(authority).toMatchObject({ command: 'SETTLE', basis: 'OWN_ORGANIZATION' });
    }
  });

  it.each([
    { roles: ['SYSTEM_ADMIN'], acting: 'ORG-S', basis: 'SYSTEM_ADMIN' },
    { roles: ['SYSTEM_ADMIN', 'UNION_ADMIN'], acting: 'ORG-S', basis: 'SYSTEM_ADMIN' },
    { roles: ['UNION_ADMIN'], acting: 'ORG-U', basis: 'UNION_SUBTREE' },
  ])(
    'issues $roles acting for $acting the payer’s books, naming both',
    async ({ roles, acting, basis }) => {
      const { books: issued, authority } = await books(asUser(roles, acting));
      expect(issued).toEqual({ organizationId: 'ORG-B', actingOrganizationId: acting });
      expect(isIssuedSettlementBooks(issued!)).toBe(true);
      expect(Object.isFrozen(issued)).toBe(true);
      expect(authority.basis).toBe(basis);
    },
  );

  it('refuses a union administrator outside its union (docs/24 Q-136)', async () => {
    await expect(books(asUser(['UNION_ADMIN'], 'ORG-S'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE,
    });
  });

  it('fails closed when organization-service cannot answer', async () => {
    await expect(books(asUser(['UNION_ADMIN'], 'ORG-U'), unreachable)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('refuses an organization administrator of another organization', async () => {
    await expect(books(asUser(['ORGANIZATION_ADMIN'], 'ORG-U'))).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });

  it('refuses a service whose token names another organization', async () => {
    await expect(books(asService('marketplace-service', 'ORG-U'))).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });

  it('refuses the oversight role, even holding a platform role', async () => {
    await expect(books(asUser(['SYSTEM_ADMIN', 'AUDITOR'], 'ORG-S'))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not recognise a look-alike it did not issue', () => {
    expect(
      isIssuedSettlementBooks({ organizationId: 'ORG-B', actingOrganizationId: 'ORG-U' }),
    ).toBe(false);
  });
});

describe('assertTransactionVisible', () => {
  const transaction = {
    id: 'TXN_1',
    organizationId: 'ORG-A',
    counterpartyOrganizationId: 'ORG-B',
  };

  it('shows a transaction to its payer', () => {
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN'], 'ORG-A'), () => assertTransactionVisible(transaction)),
    ).not.toThrow();
  });

  it('shows a transaction to its payee', () => {
    // The reason this check exists at all: a row naming two organizations
    // cannot be authorised by a single-tenant filter, which would hide it from
    // the party being paid.
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN'], 'ORG-B'), () => assertTransactionVisible(transaction)),
    ).not.toThrow();
  });

  it('hides it from everybody else — as 404, never 403', () => {
    // A 403 confirms the record exists, and an attacker walking identifiers
    // could map which organizations trade with which (docs/09).
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN'], 'ORG-C'), () => assertTransactionVisible(transaction)),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('does not leak the transaction id into the message', () => {
    try {
      run(asUser(['ORGANIZATION_ADMIN'], 'ORG-C'), () => assertTransactionVisible(transaction));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toBe('Transaction not found');
    }
  });

  it('shows it to a platform administrator', () => {
    expect(() =>
      run(asUser(['SYSTEM_ADMIN'], 'ORG-C'), () => assertTransactionVisible(transaction)),
    ).not.toThrow();
  });
});

describe('assertWalletVisible', () => {
  it('shows a wallet only to the organization that owns it', () => {
    const wallet = { id: 'WLT_1', organizationId: 'ORG-A' };
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN'], 'ORG-A'), () => assertWalletVisible(wallet)),
    ).not.toThrow();
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN'], 'ORG-B'), () => assertWalletVisible(wallet)),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('hides a wallet even from a counterparty', () => {
    // There is no "read the other side's wallet" path, not even for the party
    // being paid: a payee learns what it will receive from the transaction and
    // from its own wallet, never from the payer's balance.
    const wallet = { id: 'WLT_PAYER', organizationId: 'ORG-A' };
    expect(() =>
      run(asUser(['ORGANIZATION_ADMIN'], 'ORG-B'), () => assertWalletVisible(wallet)),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('shows any wallet to a platform administrator', () => {
    // The crossing an operator needs to diagnose a wallet that disagrees with
    // its ledger. Narrow and explicit: platform scope, and nothing below it.
    const wallet = { id: 'WLT_1', organizationId: 'ORG-A' };
    expect(() =>
      run(asUser(['UNION_ADMIN'], 'ORG-B'), () => assertWalletVisible(wallet)),
    ).not.toThrow();
  });

  it('shows any wallet to a service caller, already authorised by @AllowService', () => {
    // The calling *service* has been authorised for the endpoint; the wallet
    // check is not the place to re-litigate that decision.
    const wallet = { id: 'WLT_1', organizationId: 'ORG-A' };
    expect(() => run(asService(), () => assertWalletVisible(wallet))).not.toThrow();
  });

  it('refuses the oversight role a wallet it would otherwise own', () => {
    // Ownership does not help: the constraint is on the role, not on the row.
    const wallet = { id: 'WLT_1', organizationId: 'ORG-A' };
    expect(() => run(asUser(['AUDITOR'], 'ORG-A'), () => assertWalletVisible(wallet))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

describe('assertMayRefund (docs/24 Q-62, Q-136)', () => {
  // ORG-B pays, ORG-P is paid, ORG-C is a stranger to the transaction; ORG-U is
  // the union ORG-B sits under, ORG-S a union it does not.
  const REFUNDABLE = ['HELD', 'PENDING_SETTLEMENT', 'DISPUTED'] as const;
  const txn = (status: string) => ({
    id: 'TXN_1',
    organizationId: 'ORG-B',
    counterpartyOrganizationId: 'ORG-P',
    status,
  });
  const allowed = { payeeMayRefund: true };
  const refund = (
    context: RequestContext,
    status: string,
    policy = allowed,
    tree: HierarchyQuestion = hierarchy(),
  ) => run(context, () => assertMayRefund(txn(status), policy, tree));

  describe.each(REFUNDABLE)('from %s', (status) => {
    it('refuses the payer’s own administrator', async () => {
      await expect(refund(asUser(['ORGANIZATION_ADMIN'], 'ORG-B'), status)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('refuses the payer even with platform roles', async () => {
      // A platform administrator acting as the payer is still the payer: the
      // conflict of interest is the same one the rule exists to close.
      await expect(refund(asUser(['SYSTEM_ADMIN'], 'ORG-B'), status)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('permits a system administrator acting for any other organization', async () => {
      await expect(refund(asUser(['SYSTEM_ADMIN'], 'ORG-S'), status)).resolves.toMatchObject({
        command: 'REFUND',
        basis: 'SYSTEM_ADMIN',
        booksOrganizationId: 'ORG-B',
      });
    });

    it('permits a union administrator whose union holds the payer', async () => {
      await expect(refund(asUser(['UNION_ADMIN'], 'ORG-U'), status)).resolves.toMatchObject({
        basis: 'UNION_SUBTREE',
        actingOrganizationId: 'ORG-U',
        booksOrganizationId: 'ORG-B',
        hierarchyVersion: 7,
      });
    });

    it('refuses a union administrator outside the payer’s union — 403', async () => {
      await expect(refund(asUser(['UNION_ADMIN'], 'ORG-S'), status)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: OUTSIDE,
      });
    });

    it('fails closed for a union administrator when organization-service cannot answer', async () => {
      await expect(
        refund(asUser(['UNION_ADMIN'], 'ORG-U'), status, allowed, unreachable),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    });

    it('permits the order saga, whose token names the payer', async () => {
      await expect(
        refund(asService('marketplace-service', 'ORG-B'), status),
      ).resolves.toMatchObject({ basis: 'OWN_ORGANIZATION', actor: 'marketplace-service' });
    });

    it('hides the transaction from a service token for a non-party — 404', async () => {
      await expect(refund(asService('marketplace-service', 'ORG-C'), status)).rejects.toMatchObject(
        { code: 'NOT_FOUND' },
      );
    });

    it('hides the transaction from a stranger administrator — 404, never 403', async () => {
      await expect(refund(asUser(['ORGANIZATION_ADMIN'], 'ORG-C'), status)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses a payee member without a financial role', async () => {
      await expect(refund(asUser(['OPERATOR'], 'ORG-P'), status)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('refuses the oversight role even as the payee', async () => {
      await expect(
        refund(asUser(['AUDITOR', 'ORGANIZATION_ADMIN'], 'ORG-P'), status),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe.each(['HELD', 'PENDING_SETTLEMENT'] as const)('from %s', (status) => {
    it('permits the payee’s administrator — a voluntary return', async () => {
      await expect(refund(asUser(['ORGANIZATION_ADMIN'], 'ORG-P'), status)).resolves.toMatchObject({
        basis: 'PAYEE',
        actingOrganizationId: 'ORG-P',
      });
    });

    it('refuses the payee’s administrator when configuration turns it off', async () => {
      await expect(
        refund(asUser(['ORGANIZATION_ADMIN'], 'ORG-P'), status, { payeeMayRefund: false }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('lets a union administrator of the payee return as the payee does, asking nothing', async () => {
      const tree = hierarchy();
      await expect(
        refund(asUser(['UNION_ADMIN'], 'ORG-P'), status, allowed, tree),
      ).resolves.toMatchObject({ basis: 'PAYEE' });
      expect(tree.asked).toEqual([]);
    });
  });

  it('refuses the payee’s administrator once the transaction is disputed', async () => {
    // Only a platform decision on the dispute, or the saga mirroring one, may
    // return disputed funds — never either party alone (docs/10 § 10.5).
    await expect(refund(asUser(['ORGANIZATION_ADMIN'], 'ORG-P'), 'DISPUTED')).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
  });

  it('holds a union administrator of the payee to its union once disputed (Q-136)', async () => {
    // ORG-P's union does not hold the payer ORG-B: the platform decision on a
    // dispute is not its to make.
    await expect(refund(asUser(['UNION_ADMIN'], 'ORG-P'), 'DISPUTED')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OUTSIDE,
    });
  });
});
