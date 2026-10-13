import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { PlatformAdministratorRefused, type Acting } from '../access/access';
import type { ContractRepository } from '../contract/contract.repository';
import type { EventPublisher } from '../events/publisher';
import type { Contract } from '../generated/prisma';
import type { PrismaService } from '../prisma/prisma.service';
import type { RefusalFence } from '../shared/idempotency';
import { AuthorityRefusals } from './authority-refusals';

/**
 * The platform administrator's refusal, as a party's command records it: the branches that need
 * a database only to misbehave on cue. The behaviour over the real routes and database is in
 * `test/sign.int-spec.ts`, `cancel.int-spec.ts`, `amendment.int-spec.ts` and `milestone.int-spec.ts`.
 */

const EMPLOYER = 'ORG_EMPLOYER';
const CONTRACTOR = 'ORG_CONTRACTOR';
const contract = {
  id: 'CTR_1',
  organizationId: EMPLOYER,
  contractorOrganizationId: CONTRACTOR,
} as Contract;

const as = <T>(fn: () => T): T =>
  runWithContext(
    {
      requestId: 'r',
      correlationId: 'c',
      authType: 'USER',
      organizationId: EMPLOYER,
      userId: 'USR_ADMIN',
      roles: ['SYSTEM_ADMIN'],
      startedAt: Date.now(),
    } as unknown as RequestContext,
    fn,
  );

function harness(options: { found?: Contract | null; enqueue?: () => Promise<void> } = {}) {
  const enqueued: { eventName: string; payload: Record<string, unknown> }[] = [];
  const lookups: [string, string][] = [];
  const tx = { $queryRawUnsafe: async () => [{ now: new Date('2026-10-13T10:00:00.000Z') }] };
  const prisma = {
    transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const publisher = {
    enqueue:
      options.enqueue ??
      (async (_tx: unknown, event: (typeof enqueued)[number]) => {
        enqueued.push(event);
      }),
  } as unknown as EventPublisher;
  const contracts = {
    findParty: async (organizationId: string, id: string) => {
      lookups.push([organizationId, id]);
      return options.found === undefined ? contract : options.found;
    },
  } as unknown as ContractRepository;
  return { refusals: new AuthorityRefusals(prisma, publisher, contracts), enqueued, lookups };
}

const named = { action: 'CANCEL_CONTRACT', contractId: 'CTR_1', subjectId: null } as const;
const administrator = () => {
  throw new PlatformAdministratorRefused('The platform administrator does not', EMPLOYER);
};

describe('AuthorityRefusals.commandingCaller', () => {
  it('passes a caller the command accepts through, reading nothing', async () => {
    const { refusals, lookups, enqueued } = harness();
    const acting: Acting = { organizationId: EMPLOYER };
    await expect(as(() => refusals.commandingCaller(() => acting, named, undefined))).resolves.toBe(
      acting,
    );
    expect(lookups).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('lets every other refusal through untouched and unaudited: the oversight role, a service, no organization', async () => {
    const { refusals, lookups, enqueued } = harness();
    const other = RastaError.forbidden('The oversight role has aggregate access only');
    await expect(
      as(() =>
        refusals.commandingCaller(
          () => {
            throw other;
          },
          named,
          undefined,
        ),
      ),
    ).rejects.toBe(other);
    expect(lookups).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('records the platform administrator acting for a party, then answers the same 403', async () => {
    const { refusals, lookups, enqueued } = harness();
    await expect(
      as(() => refusals.commandingCaller(administrator, named, undefined)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(lookups).toEqual([[EMPLOYER, 'CTR_1']]);
    expect(enqueued.map((event) => [event.eventName, event.payload])).toEqual([
      [
        'CONTRACT_AUTHORITY_REFUSED',
        {
          contractId: 'CTR_1',
          organizationId: EMPLOYER,
          action: 'CANCEL_CONTRACT',
          side: 'EMPLOYER',
          subjectId: null,
          reason: 'PLATFORM_ADMINISTRATOR',
          policyId: null,
          refusedBy: 'USR_ADMIN',
          refusedAt: '2026-10-13T10:00:00.000Z',
        },
      ],
    ]);
  });

  it('answers the same 403, unrecorded, when the organization is no party to the contract', async () => {
    const { refusals, enqueued } = harness({ found: null });
    let refused: unknown;
    await as(() => refusals.commandingCaller(administrator, named, undefined)).catch(
      (error: unknown) => {
        refused = error;
      },
    );
    expect(refused).toBeInstanceOf(PlatformAdministratorRefused);
    expect(enqueued).toEqual([]);
  });

  it('writes no second event when the fence says the refusal was already audited', async () => {
    const { refusals, enqueued } = harness();
    const fence: RefusalFence = { firstRefusal: async () => false };
    await expect(
      as(() => refusals.commandingCaller(administrator, named, fence)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(enqueued).toEqual([]);
  });

  it('is a retryable 503, not the 403, when the refusal cannot be recorded', async () => {
    const { refusals } = harness({
      enqueue: async () => {
        throw new Error('outbox down');
      },
    });
    await expect(
      as(() => refusals.commandingCaller(administrator, named, undefined)),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryAfterSeconds: 1 });
  });
});
