import { runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  assertNotAuditor,
  assertPlatformScope,
  assertTransactionVisible,
  assertWalletVisible,
  canCommitOrganization,
  hasPlatformScope,
} from './access';

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
    authType: 'USER',
    startedAt: Date.now(),
  };
}

function asService(callerService = 'marketplace-service'): RequestContext {
  return {
    correlationId: 'corr-1',
    requestId: 'req-1',
    organizationId: 'ORG-A',
    roles: ['SYSTEM'],
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

  it('permits a service caller, already authorised by @AllowService', () => {
    // marketplace-service settling an order it owns is the documented flow
    // (docs/08 § 8.6).
    expect(() => run(asService(), () => canCommitOrganization('ORG-Z'))).not.toThrow();
  });

  it('refuses a request with no organization at all before it can commit one', () => {
    // A context with no tenant reaches this only through a misconfiguration,
    // and the honest answer is a refusal rather than a commitment made on
    // behalf of nobody.
    const anonymous: RequestContext = {
      correlationId: 'corr-1',
      requestId: 'req-1',
      roles: ['ORGANIZATION_ADMIN'],
      authType: 'USER',
      startedAt: Date.now(),
    };
    expect(() => run(anonymous, () => canCommitOrganization('ORG-A'))).toThrow(
      expect.objectContaining({ code: 'TENANT_MISMATCH' }),
    );
  });

  it('refuses the oversight role even for its own organization', () => {
    expect(() => run(asUser(['AUDITOR']), () => canCommitOrganization('ORG-A'))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
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
