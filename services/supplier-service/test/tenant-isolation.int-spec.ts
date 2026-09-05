import { runWithContext } from '@rasta/nest-common';
import {
  asOperator,
  asSupplier,
  cleanup,
  context,
  newOrganizationId,
  newUserId,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation (AGENTS.md § 4, ADR-011).
 *
 * **NOT RUN.** Prepared in a phase that may not touch shared infrastructure.
 * Running it is an Integration Handoff item, and nothing in the phase report
 * claims it passed.
 *
 * Every feature touching tenant data needs a test proving tenant A cannot read
 * or change tenant B's rows. This service makes that unusually interesting,
 * because it has a legitimate cross-tenant read — the directory — and the
 * question is therefore not "can A see B at all" but "what exactly can A see,
 * and which object is it".
 */
describe('tenant isolation', () => {
  let w: Wiring;
  const organizations: string[] = [];

  let orgA: string;
  let orgB: string;
  let supplierA: { id: string };
  let supplierB: { id: string };
  let qualificationA: { id: string };

  beforeAll(async () => {
    w = wire();

    orgA = newOrganizationId();
    orgB = newOrganizationId();
    organizations.push(orgA, orgB);

    supplierA = await asSupplier(orgA, () =>
      w.suppliers.register({ displayName: 'Workshop A', capabilities: ['WORKSHOP_SERVICE'] }),
    );
    supplierB = await asSupplier(orgB, () =>
      w.suppliers.register({ displayName: 'Workshop B', capabilities: ['WORKSHOP_SERVICE'] }),
    );

    qualificationA = await asSupplier(orgA, () =>
      w.qualifications.submit(supplierA.id, {
        capability: 'WORKSHOP_SERVICE',
        statement: 'Private statement A',
        evidence: [{ documentId: 'DOC_PRIVATE_A', label: 'Licence A' }],
      }),
    );
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  describe('the private record', () => {
    it("answers 404 when B reads A's profile", async () => {
      // Not 403: a 403 confirms the profile exists and that somebody else owns
      // it, which for a directory of named organizations is itself the leak.
      await expect(asSupplier(orgB, () => w.suppliers.get(supplierA.id))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('answers 404 for an id that does not exist at all', async () => {
      // The same shape, so a stranger cannot distinguish "missing" from "not
      // yours" by comparing the two responses.
      await expect(asSupplier(orgB, () => w.suppliers.get('SUP_NOPE'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('lets A read its own', async () => {
      await expect(asSupplier(orgA, () => w.suppliers.get(supplierA.id))).resolves.toMatchObject({
        id: supplierA.id,
      });
    });
  });

  describe('writes across the boundary', () => {
    it("refuses B submitting a qualification against A's profile", async () => {
      await expect(
        asSupplier(orgB, () =>
          w.qualifications.submit(supplierA.id, { capability: 'GOODS_SUPPLY', evidence: [] }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses B suspending A', async () => {
      await expect(
        asSupplier(orgB, () => w.suspensions.suspend(supplierA.id, { reason: 'A stated reason' })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses A deciding its own qualification even holding an operator role', async () => {
      // The case only the row can catch: this person legitimately holds
      // UNION_ADMIN and legitimately belongs to organization A.
      await expect(
        runWithContext(
          context({ organizationId: orgA, userId: newUserId(), roles: ['UNION_ADMIN'] }),
          () => w.qualifications.approve(supplierA.id, qualificationA.id, {}),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('refuses A suspending itself with SYSTEM_ADMIN', async () => {
      await expect(
        runWithContext(
          context({ organizationId: orgA, userId: newUserId(), roles: ['SYSTEM_ADMIN'] }),
          () => w.suspensions.suspend(supplierA.id, { reason: 'Lifting my own problem' }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it("refuses deciding A's qualification through B's supplier id in the path", async () => {
      // Otherwise a caller could slip past the self-judgement check by naming
      // an unrelated profile in the URL while acting on A's qualification.
      await expect(
        asOperator(() => w.qualifications.approve(supplierB.id, qualificationA.id, {})),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('the directory crosses the boundary on purpose, and carries nothing private', () => {
    it('lets B find A in the directory', async () => {
      const page = await asSupplier(orgB, () => w.suppliers.search({ limit: 200 }));

      expect(page.items.map((item) => item.id)).toContain(supplierA.id);
    });

    it("carries none of A's private material to B", async () => {
      const page = await asSupplier(orgB, () => w.suppliers.search({ limit: 200 }));
      const serialised = JSON.stringify(page.items);

      expect(serialised).not.toContain('DOC_PRIVATE_A');
      expect(serialised).not.toContain('Private statement A');
      expect(serialised).not.toContain('decisionNote');
      expect(serialised).not.toContain('registeredBy');
      // Not even that a submission exists: an in-progress application is not a
      // public fact.
      expect(serialised).not.toContain(qualificationA.id);
    });

    it('shows nothing as qualified until a platform operator has approved it', async () => {
      const page = await asSupplier(orgB, () => w.suppliers.search({ limit: 200 }));
      const a = page.items.find((item) => item.id === supplierA.id);

      expect(a?.capabilities).toEqual(['WORKSHOP_SERVICE']);
      expect(a?.qualifiedFor).toEqual([]);
    });
  });

  describe('the review queue', () => {
    it('is refused to a supplier-side caller in any organization', async () => {
      await expect(
        asSupplier(orgA, () => w.qualifications.reviewQueue({ state: 'SUBMITTED', limit: 25 })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('shows a platform operator submissions from every tenant, with their evidence', async () => {
      const page = await asOperator(() =>
        w.qualifications.reviewQueue({ state: 'SUBMITTED', limit: 200 }),
      );
      const entry = page.items.find((item) => item.id === qualificationA.id);

      expect(entry?.supplierOrganizationId).toBe(orgA);
      expect(entry?.evidence[0].documentId).toBe('DOC_PRIVATE_A');
    });
  });

  describe('the oversight role', () => {
    it('reaches nothing, in any organization', async () => {
      const asAuditor = <T>(fn: () => T) =>
        runWithContext(
          context({ organizationId: orgA, userId: newUserId(), roles: ['AUDITOR'] }),
          fn,
        );

      await expect(asAuditor(() => w.suppliers.get(supplierA.id))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(asAuditor(() => w.suppliers.search({ limit: 25 }))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});
