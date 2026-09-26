import { eventEnvelopeSchema } from '@rasta/contracts';
import type { CreatePolicyDto } from '../src/approval/dto';
import {
  approvalsOf,
  asAdmin,
  asPlatform,
  asSetter,
  asUser,
  cleanup,
  newOrganizationId,
  newUserId,
  outboxFor,
  readyProject,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Q-70 (7), decided by the project owner 2026-09-26, against PostgreSQL:
 *
 * - a union administrator writes the approval policy of an organization under
 *   its union — never of one outside it — and an organization administrator
 *   never writes its own;
 * - a written policy governs nothing until a platform administrator approves
 *   it, and a rejected one never governs;
 * - approval swaps out the policy in force in one transaction, under four
 *   eyes;
 * - "the hierarchy could not be confirmed" refuses, never assumes.
 *
 * The hierarchy stands in for organization-service; its contract is proven on
 * both sides (organization-service's provider test, and
 * `organization-directory.int-spec.ts` here).
 */

describe('approval policy governance (Q-70 (7), decided)', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** A union with a county beneath it and a dehyari beneath that. */
  function tree(): { union: string; county: string; dehyari: string } {
    const union = org();
    const county = org();
    const dehyari = org();
    w.hierarchy.adopt(union, county);
    w.hierarchy.adopt(county, dehyari);
    return { union, county, dehyari };
  }

  const policyFor = (organizationId: string): CreatePolicyDto => ({
    organizationId,
    workflowKey: 'project.execution',
    label: 'Execution approval',
    rationale: 'Written by the governance suite',
    isSample: true,
    steps: [
      {
        approvalType: 'Council approval',
        authorityOrganizationId: organizationId,
        authorityRole: 'ORGANIZATION_ADMIN',
        authorityLabel: 'Council',
      },
    ],
  });

  const policyRow = (policyId: string) =>
    w.approvalRepository.findPolicy(w.prisma.client, policyId);

  beforeAll(() => {
    w = wire();
  });

  afterEach(() => {
    w.hierarchy.unavailable = false;
    w.hierarchy.timedOut = false;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  describe('who writes', () => {
    it('a union writes for a dehyari two levels beneath it, as its author', async () => {
      const { union, dehyari } = tree();
      const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
      expect(policy).toMatchObject({
        status: 'DRAFT',
        organizationId: dehyari,
        authorOrganizationId: union,
        authorRole: 'UNION_ADMIN',
      });
      expect(w.hierarchy.asked).toContainEqual([union, dehyari]);

      const [created] = (await outboxFor(w.prisma, dehyari)).filter(
        (row) => row.eventName === 'APPROVAL_POLICY_CREATED',
      );
      expect(eventEnvelopeSchema.parse(created!.payload).payload).toMatchObject({
        organizationId: dehyari,
        authorOrganizationId: union,
        authorRole: 'UNION_ADMIN',
      });
      expect(JSON.stringify(created!.payload)).not.toContain('Execution approval');
    });

    it('a union writes for its own organization', async () => {
      const union = org();
      await expect(
        asSetter(union, () => w.policies.create(policyFor(union))),
      ).resolves.toMatchObject({ organizationId: union, authorOrganizationId: union });
    });

    it('a union is refused for an organization outside it, and nothing is written', async () => {
      const { union } = tree();
      const stranger = org();
      await expect(
        asSetter(union, () => w.policies.create(policyFor(stranger))),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await outboxFor(w.prisma, stranger)).toEqual([]);
    });

    it('a union beneath another is refused upward', async () => {
      const { union, county } = tree();
      await expect(
        asSetter(county, () => w.policies.create(policyFor(union))),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('an organization administrator never writes its own policy', async () => {
      const { dehyari } = tree();
      await expect(
        asAdmin(dehyari, () => w.policies.create(policyFor(dehyari))),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    });

    it('a platform administrator writes for any organization organization-service knows', async () => {
      const target = org();
      const policy = await asPlatform(() => w.policies.create(policyFor(target)));
      expect(policy).toMatchObject({ organizationId: target, authorRole: 'SYSTEM_ADMIN' });
      expect(w.hierarchy.asked).toContainEqual([target, target]);
    });

    it('refuses — never assumes — when the hierarchy cannot be confirmed', async () => {
      const { union, dehyari } = tree();
      w.hierarchy.unavailable = true;
      await expect(
        asSetter(union, () => w.policies.create(policyFor(dehyari))),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      w.hierarchy.unavailable = false;
      w.hierarchy.timedOut = true;
      await expect(
        asSetter(union, () => w.policies.create(policyFor(dehyari))),
      ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
      expect(await outboxFor(w.prisma, dehyari)).toEqual([]);
    });
  });

  describe('what governs', () => {
    it('a pending policy does not govern; the platform approval puts it in force', async () => {
      const { union, dehyari } = tree();
      const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
      const project = await readyProject(w, dehyari);

      const refuse = () =>
        expect(
          asAdmin(dehyari, () =>
            w.approvals.request(project.id, { expectedVersion: project.version }),
          ),
        ).rejects.toThrow(/never approves by default/);

      await refuse(); // DRAFT
      await asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
      await refuse(); // PENDING_PLATFORM_APPROVAL

      const approved = await asPlatform(() =>
        w.policies.approve(policy.id, { expectedVersion: 2 }),
      );
      expect(approved).toMatchObject({ status: 'ACTIVE', version: 3 });
      expect(approved.activatedBy).toBeTruthy();

      await asAdmin(dehyari, () =>
        w.approvals.request(project.id, { expectedVersion: project.version }),
      );
      expect(await approvalsOf(w, dehyari, project.id)).toHaveLength(1);
    });

    it('a rejected policy never governs, and keeps its reason off the event', async () => {
      const { union, dehyari } = tree();
      const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
      await asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
      const rejected = await asPlatform(() =>
        w.policies.reject(policy.id, { expectedVersion: 2, reason: 'The council is not named' }),
      );
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'The council is not named',
      });

      const project = await readyProject(w, dehyari);
      await expect(
        asAdmin(dehyari, () =>
          w.approvals.request(project.id, { expectedVersion: project.version }),
        ),
      ).rejects.toThrow(/never approves by default/);
      await expect(
        asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 3 })),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

      const names = (await outboxFor(w.prisma, dehyari)).map((row) => row.eventName);
      expect(names).toEqual([
        'APPROVAL_POLICY_CREATED',
        'APPROVAL_POLICY_SUBMITTED',
        'APPROVAL_POLICY_REJECTED',
        ...names.slice(3),
      ]);
      expect(
        JSON.stringify((await outboxFor(w.prisma, dehyari)).map((row) => row.payload)),
      ).not.toContain('The council is not named');
    });

    it('approval retires the policy in force for that organization, in one transaction', async () => {
      const { union, dehyari } = tree();
      const write = async () => {
        const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
        await asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
        return policy.id;
      };
      const first = await write();
      await asPlatform(() => w.policies.approve(first, { expectedVersion: 2 }));
      const second = await write();
      await asPlatform(() => w.policies.approve(second, { expectedVersion: 2 }));

      expect((await policyRow(first))?.status).toBe('RETIRED');
      expect((await policyRow(second))?.status).toBe('ACTIVE');
      const activated = (await outboxFor(w.prisma, dehyari)).filter(
        (row) => row.eventName === 'APPROVAL_POLICY_ACTIVATED',
      );
      expect(eventEnvelopeSchema.parse(activated[1]!.payload).payload).toMatchObject({
        policyId: second,
        retiredPolicyId: first,
      });
    });
  });

  describe('who approves', () => {
    it('only a platform administrator approves or rejects', async () => {
      const { union, dehyari } = tree();
      const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
      await asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
      for (const as of [
        <T>(fn: () => T) => asSetter(union, fn),
        <T>(fn: () => T) => asAdmin(dehyari, fn),
      ]) {
        await expect(
          as(() => w.policies.approve(policy.id, { expectedVersion: 2 })),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
        await expect(
          as(() => w.policies.reject(policy.id, { expectedVersion: 2, reason: 'Not mine to do' })),
        ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
      }
      expect((await policyRow(policy.id))?.status).toBe('PENDING_PLATFORM_APPROVAL');
    });

    it('four eyes: a platform administrator does not approve a policy it wrote or submitted', async () => {
      const target = org();
      const author = newUserId();
      const policy = await asPlatform(() => w.policies.create(policyFor(target)), author);
      await asPlatform(() => w.policies.submit(policy.id, { expectedVersion: 1 }), author);
      await expect(
        asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 2 }), author),
      ).rejects.toThrow(/different platform administrator/);
      await expect(
        asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 2 })),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
    });

    it('four eyes can be switched off where the platform has one administrator (recorded choice)', async () => {
      const single = wire(testEnv({ CONSTRUCTION_POLICY_FOUR_EYES: 'false' }));
      try {
        const target = org();
        const only = newUserId();
        const policy = await asPlatform(() => single.policies.create(policyFor(target)), only);
        await asPlatform(() => single.policies.submit(policy.id, { expectedVersion: 1 }), only);
        await expect(
          asPlatform(() => single.policies.approve(policy.id, { expectedVersion: 2 }), only),
        ).resolves.toMatchObject({ status: 'ACTIVE' });
      } finally {
        await single.close();
      }
    });

    it('re-checks the hierarchy at submit and approval: a moved organization is refused', async () => {
      const { union, county, dehyari } = tree();
      const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
      w.hierarchy.disown(dehyari);
      await expect(
        asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      w.hierarchy.adopt(county, dehyari);
      await asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
      w.hierarchy.unavailable = true;
      await expect(
        asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 2 })),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect((await policyRow(policy.id))?.status).toBe('PENDING_PLATFORM_APPROVAL');
    });

    it('only the author organization submits; another union learns nothing', async () => {
      const { union, dehyari } = tree();
      const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
      await expect(
        asSetter(org(), () => w.policies.submit(policy.id, { expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // The governed organization sees it, and is told it may not submit it.
      await expect(
        asUser(dehyari, ['ORGANIZATION_ADMIN', 'UNION_ADMIN'], () =>
          w.policies.submit(policy.id, { expectedVersion: 1 }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('the platform queue shows every organization’s pending policies, to SYSTEM_ADMIN only', async () => {
      const first = tree();
      const second = tree();
      const ids: string[] = [];
      for (const { union, dehyari } of [first, second]) {
        const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
        await asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
        ids.push(policy.id);
      }
      const queue = await asPlatform(() => w.policies.platformQueue({ limit: 200 }));
      expect(queue.items.map((item) => item.id)).toEqual(expect.arrayContaining(ids));
      expect(queue.items.every((item) => item.status === 'PENDING_PLATFORM_APPROVAL')).toBe(true);
      await expect(
        asSetter(first.union, () => w.policies.platformQueue({ limit: 10 })),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    });

    it('lists what an organization governs by or wrote, and nothing else', async () => {
      const { union, dehyari } = tree();
      const policy = await asSetter(union, () => w.policies.create(policyFor(dehyari)));
      const byAuthor = await asSetter(union, () => w.policies.list({ limit: 50 }));
      const byGoverned = await asAdmin(dehyari, () => w.policies.list({ limit: 50 }));
      const byStranger = await asSetter(org(), () => w.policies.list({ limit: 50 }));
      expect(byAuthor.items.map((item) => item.id)).toContain(policy.id);
      expect(byGoverned.items.map((item) => item.id)).toContain(policy.id);
      expect(byStranger.items.map((item) => item.id)).not.toContain(policy.id);
    });
  });
});
