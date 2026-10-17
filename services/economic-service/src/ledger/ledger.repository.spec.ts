import { currentUnscopedReason, runWithContext, type RequestContext } from '@rasta/nest-common';
import { LedgerRepository } from './ledger.repository';
import { settlementBooks, type SettlementBooks } from '../access/access';
import type { HierarchyQuestion } from '../organization/organization-hierarchy';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';

/**
 * The journal header's one tenant crossing (docs/23 D-054; review of #287 r4,
 * F3): a platform administrator acting for organization A settles B's
 * transaction, and the settlement journal is written on B's books.
 *
 * The real guard and database are exercised by
 * `test/platform-admin-settlement.int-spec.ts`; this pins which calls may
 * cross at all. The fake `tx` records whether `journal.create` ran with the
 * guard disabled, which is the whole of what the crossing changes.
 */
describe('LedgerRepository.createJournal', () => {
  const repository = new LedgerRepository({} as PrismaService);

  function fakeTx() {
    const writes: { organizationId: string; unscoped: string | undefined }[] = [];
    const tx = {
      journal: {
        create: ({ data }: { data: { organizationId: string } }) => {
          writes.push({ organizationId: data.organizationId, unscoped: currentUnscopedReason() });
          return Promise.resolve(data);
        },
      },
    } as unknown as ExtendedPrismaClient;
    return { tx, writes };
  }

  const acting = (organizationId: string, roles = ['SYSTEM_ADMIN']): RequestContext => ({
    correlationId: 'corr-1',
    requestId: 'req-1',
    organizationId,
    userId: 'USR-PLATFORM',
    roles,
    organizationIds: [],
    authType: 'USER',
    startedAt: Date.now(),
  });

  const journal = (
    organizationId: string,
    journalType: 'SETTLEMENT' | 'FUNDS_HELD' = 'SETTLEMENT',
  ) => ({
    id: 'JRN_1',
    organizationId,
    transactionId: 'TXN_1',
    journalType,
    description: 'Settlement of TXN_1',
    postedAt: new Date(),
    postedBy: 'USR-PLATFORM',
    correlationId: 'corr-1',
  });

  /** ORG-B is within the union ORG-A (docs/24 Q-136); a system administrator asks nothing. */
  const unionOfB: HierarchyQuestion = {
    withinVersion: async (scope, organizationId) =>
      scope === 'ORG-A' && organizationId === 'ORG-B' ? { hierarchyVersion: 3 } : null,
  };

  /** The leave `settlementBooks` issues to the context's caller for ORG-B's books. */
  const issue = async (payer = 'ORG-B') => (await settlementBooks(payer, unionOfB)).books;

  const create = (
    context: RequestContext,
    data: ReturnType<typeof journal>,
    books: () => Promise<SettlementBooks | undefined> | SettlementBooks | undefined,
  ) => {
    const { tx, writes } = fakeTx();
    const result = runWithContext(context, () =>
      Promise.resolve().then(async () => repository.createJournal(tx, data, await books())),
    );
    return { result, writes };
  };

  it('without leave, writes through the tenant guard as before', async () => {
    const { result, writes } = create(
      acting('ORG-B', ['ORGANIZATION_ADMIN']),
      journal('ORG-B'),
      () => undefined,
    );
    await result;
    expect(writes).toEqual([{ organizationId: 'ORG-B', unscoped: undefined }]);
  });

  it('with the leave issued for this request, writes the payer’s settlement journal across the guard', async () => {
    const { result, writes } = create(acting('ORG-A'), journal('ORG-B'), () => issue());
    await result;
    expect(writes).toEqual([
      { organizationId: 'ORG-B', unscoped: expect.stringContaining("posts the payer's journal") },
    ]);
  });

  it('writes a union administrator’s settlement for an organization of its union the same way', async () => {
    const { result, writes } = create(acting('ORG-A', ['UNION_ADMIN']), journal('ORG-B'), () =>
      issue(),
    );
    await result;
    expect(writes).toEqual([
      { organizationId: 'ORG-B', unscoped: expect.stringContaining("posts the payer's journal") },
    ]);
  });

  it('refuses a look-alike leave it was not issued', async () => {
    const { result, writes } = create(acting('ORG-A'), journal('ORG-B'), () => ({
      organizationId: 'ORG-B',
      actingOrganizationId: 'ORG-A',
    }));
    await expect(result).rejects.toThrow(/only as an issued settlement/);
    expect(writes).toEqual([]);
  });

  it('refuses any journal type but SETTLEMENT', async () => {
    const { result, writes } = create(acting('ORG-A'), journal('ORG-B', 'FUNDS_HELD'), () =>
      issue(),
    );
    await expect(result).rejects.toThrow(/only as an issued settlement/);
    expect(writes).toEqual([]);
  });

  it('refuses books other than the payer the leave names', async () => {
    const { result, writes } = create(acting('ORG-A'), journal('ORG-D'), () => issue());
    await expect(result).rejects.toThrow(/only as an issued settlement/);
    expect(writes).toEqual([]);
  });

  it('refuses a leave carried into a request acting for another organization', async () => {
    const issued = await runWithContext(acting('ORG-A'), () => issue());
    const { result, writes } = create(acting('ORG-C'), journal('ORG-B'), () => issued);
    await expect(result).rejects.toThrow(/only as an issued settlement/);
    expect(writes).toEqual([]);
  });
});
