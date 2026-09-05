import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { cleanup, newOrganizationId, newPrisma } from './helpers';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The invariants only PostgreSQL holds.
 *
 * **NOT RUN.** Prepared in a phase that may not touch shared infrastructure.
 * Running it is an Integration Handoff item, and nothing in the phase report
 * claims it passed.
 *
 * Every assertion here bypasses the domain services on purpose and writes
 * straight through Prisma. That is the whole point: the services already refuse
 * these shapes, and a test that went through them would prove the service, not
 * the schema. What has to be proven is that a *future* write path — a repair
 * script, a migration, the next feature — cannot produce them either.
 *
 * Two invariants are deliberately absent because PostgreSQL cannot express
 * them, and both are asserted in `supplier-lifecycle.int-spec.ts` instead:
 *
 *   Supplier.status agreeing with the suspension history — spans two tables.
 *   A decision being made by a different organization — needs the request
 *   context, which is `access.ts`'s job.
 */
describe('database invariants', () => {
  let prisma: PrismaService;
  const organizations: string[] = [];

  /** Writes a supplier the raw way, so the rows under test have a parent. */
  async function seedSupplier(): Promise<{ id: string; organizationId: string }> {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const id = `SUP_${ulid()}`;

    await runUnscoped('the constraint suite writes raw rows on purpose', () =>
      prisma.client.supplier.create({
        data: {
          id,
          organizationId,
          displayName: 'A supplier',
          registeredBy: `USR_${ulid()}`,
          registeredCorrelationId: ulid(),
        },
      }),
    );

    return { id, organizationId };
  }

  function raw<T>(fn: () => Promise<T>): Promise<T> {
    return runUnscoped('the constraint suite writes raw rows on purpose', fn);
  }

  beforeAll(() => {
    prisma = newPrisma();
  });

  afterAll(async () => {
    await cleanup(prisma, organizations);
    await prisma.onModuleDestroy();
  });

  describe('supplier', () => {
    it('refuses a blank display name', async () => {
      const organizationId = newOrganizationId();
      organizations.push(organizationId);

      await expect(
        raw(() =>
          prisma.client.supplier.create({
            data: {
              id: `SUP_${ulid()}`,
              organizationId,
              displayName: '   ',
              registeredBy: `USR_${ulid()}`,
              registeredCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow(/ck_supplier_display_name_not_blank|check constraint/i);
    });

    it('refuses a row that cannot name who created it', async () => {
      const organizationId = newOrganizationId();
      organizations.push(organizationId);

      await expect(
        raw(() =>
          prisma.client.supplier.create({
            data: {
              id: `SUP_${ulid()}`,
              organizationId,
              displayName: 'A supplier',
              registeredBy: '',
              registeredCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow(/ck_supplier_actor_recorded|check constraint/i);
    });

    it('refuses two profiles for one organization', async () => {
      const supplier = await seedSupplier();

      await expect(
        raw(() =>
          prisma.client.supplier.create({
            data: {
              id: `SUP_${ulid()}`,
              organizationId: supplier.organizationId,
              displayName: 'A second profile',
              registeredBy: `USR_${ulid()}`,
              registeredCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('capabilities', () => {
    it('refuses the same capability twice for one supplier', async () => {
      const supplier = await seedSupplier();
      const capability = {
        supplierId: supplier.id,
        organizationId: supplier.organizationId,
        capability: 'GOODS_SUPPLY' as const,
        declaredBy: `USR_${ulid()}`,
      };

      await raw(() =>
        prisma.client.supplierCapability.create({ data: { id: `SCP_${ulid()}`, ...capability } }),
      );

      await expect(
        raw(() =>
          prisma.client.supplierCapability.create({ data: { id: `SCP_${ulid()}`, ...capability } }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('qualification decisions', () => {
    async function seedQualification(state: 'SUBMITTED' = 'SUBMITTED') {
      const supplier = await seedSupplier();
      const id = `QLF_${ulid()}`;

      await raw(() =>
        prisma.client.qualification.create({
          data: {
            id,
            supplierId: supplier.id,
            organizationId: supplier.organizationId,
            capability: 'WORKSHOP_SERVICE',
            state,
            submittedBy: `USR_${ulid()}`,
            submittedCorrelationId: ulid(),
          },
        }),
      );

      return { id, supplier };
    }

    it('refuses a decided state with no actor', async () => {
      // "Decision records cannot omit actor or timestamp." Held by the table,
      // so a repair script cannot produce an approval nobody made.
      const { id } = await seedQualification();

      await expect(
        raw(() =>
          prisma.client.qualification.update({
            where: { id },
            data: { state: 'APPROVED', decidedAt: new Date(), decidedCorrelationId: ulid() },
          }),
        ),
      ).rejects.toThrow(/ck_qualification_decision_complete|check constraint/i);
    });

    it('refuses a decided state with no timestamp', async () => {
      const { id } = await seedQualification();

      await expect(
        raw(() =>
          prisma.client.qualification.update({
            where: { id },
            data: { state: 'REJECTED', decidedBy: `USR_${ulid()}`, decidedCorrelationId: ulid() },
          }),
        ),
      ).rejects.toThrow(/ck_qualification_decision_complete|check constraint/i);
    });

    it('refuses a SUBMITTED row carrying decision metadata', async () => {
      // The other direction: a row that has been decided must not still look
      // open, or a second reviewer could decide it again.
      const { id } = await seedQualification();

      await expect(
        raw(() =>
          prisma.client.qualification.update({
            where: { id },
            data: {
              decidedBy: `USR_${ulid()}`,
              decidedAt: new Date(),
              decidedCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow(/ck_qualification_decision_complete|check constraint/i);
    });

    it('refuses a decision that predates its submission', async () => {
      const { id } = await seedQualification();

      await expect(
        raw(() =>
          prisma.client.qualification.update({
            where: { id },
            data: {
              state: 'APPROVED',
              decidedBy: `USR_${ulid()}`,
              decidedAt: new Date('2020-01-01T00:00:00.000Z'),
              decidedCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow(/ck_qualification_decided_after_submitted|check constraint/i);
    });

    it('refuses a note on an undecided submission', async () => {
      const { id } = await seedQualification();

      await expect(
        raw(() =>
          prisma.client.qualification.update({
            where: { id },
            data: { decisionNote: 'A note about nothing' },
          }),
        ),
      ).rejects.toThrow(/ck_qualification_note_requires_decision|check constraint/i);
    });

    it('refuses two open submissions for one capability', async () => {
      // Two open submissions could be decided differently by two reviewers,
      // leaving the supplier both approved and rejected for one thing.
      const { supplier } = await seedQualification();

      await expect(
        raw(() =>
          prisma.client.qualification.create({
            data: {
              id: `QLF_${ulid()}`,
              supplierId: supplier.id,
              organizationId: supplier.organizationId,
              capability: 'WORKSHOP_SERVICE',
              submittedBy: `USR_${ulid()}`,
              submittedCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('refuses two approvals for one capability', async () => {
      const { id, supplier } = await seedQualification();
      const decided = {
        state: 'APPROVED' as const,
        decidedBy: `USR_${ulid()}`,
        decidedAt: new Date(),
        decidedCorrelationId: ulid(),
      };

      await raw(() => prisma.client.qualification.update({ where: { id }, data: decided }));

      await expect(
        raw(() =>
          prisma.client.qualification.create({
            data: {
              id: `QLF_${ulid()}`,
              supplierId: supplier.id,
              organizationId: supplier.organizationId,
              capability: 'WORKSHOP_SERVICE',
              submittedBy: `USR_${ulid()}`,
              submittedCorrelationId: ulid(),
              ...decided,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('allows repeated rejections — refusal is not a permanent bar', async () => {
      const { id, supplier } = await seedQualification();
      const rejected = {
        state: 'REJECTED' as const,
        decidedBy: `USR_${ulid()}`,
        decidedAt: new Date(),
        decidedCorrelationId: ulid(),
      };

      await raw(() => prisma.client.qualification.update({ where: { id }, data: rejected }));

      await expect(
        raw(() =>
          prisma.client.qualification.create({
            data: {
              id: `QLF_${ulid()}`,
              supplierId: supplier.id,
              organizationId: supplier.organizationId,
              capability: 'WORKSHOP_SERVICE',
              submittedBy: `USR_${ulid()}`,
              submittedCorrelationId: ulid(),
              ...rejected,
            },
          }),
        ),
      ).resolves.toBeTruthy();
    });
  });

  describe('evidence', () => {
    async function seedQualificationRow() {
      const supplier = await seedSupplier();
      const id = `QLF_${ulid()}`;

      await raw(() =>
        prisma.client.qualification.create({
          data: {
            id,
            supplierId: supplier.id,
            organizationId: supplier.organizationId,
            capability: 'GOODS_SUPPLY',
            submittedBy: `USR_${ulid()}`,
            submittedCorrelationId: ulid(),
          },
        }),
      );

      return { id, organizationId: supplier.organizationId };
    }

    it('refuses an empty document identifier', async () => {
      // "Evidence references cannot be empty strings."
      const qualification = await seedQualificationRow();

      await expect(
        raw(() =>
          prisma.client.qualificationEvidence.create({
            data: {
              id: `QEV_${ulid()}`,
              qualificationId: qualification.id,
              organizationId: qualification.organizationId,
              documentId: '',
              attachedBy: `USR_${ulid()}`,
            },
          }),
        ),
      ).rejects.toThrow(/ck_evidence_document_id_not_blank|check constraint/i);
    });

    it('refuses a whitespace-only document identifier', async () => {
      const qualification = await seedQualificationRow();

      await expect(
        raw(() =>
          prisma.client.qualificationEvidence.create({
            data: {
              id: `QEV_${ulid()}`,
              qualificationId: qualification.id,
              organizationId: qualification.organizationId,
              documentId: '  \t ',
              attachedBy: `USR_${ulid()}`,
            },
          }),
        ),
      ).rejects.toThrow(/ck_evidence_document_id_not_blank|check constraint/i);
    });

    it('refuses the same document attached twice to one submission', async () => {
      const qualification = await seedQualificationRow();
      const evidence = {
        qualificationId: qualification.id,
        organizationId: qualification.organizationId,
        documentId: 'DOC_SAME',
        attachedBy: `USR_${ulid()}`,
      };

      await raw(() =>
        prisma.client.qualificationEvidence.create({ data: { id: `QEV_${ulid()}`, ...evidence } }),
      );

      await expect(
        raw(() =>
          prisma.client.qualificationEvidence.create({
            data: { id: `QEV_${ulid()}`, ...evidence },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('suspension', () => {
    async function seedSuspension(supplierId: string, organizationId: string) {
      const id = `SSP_${ulid()}`;

      await raw(() =>
        prisma.client.suspension.create({
          data: {
            id,
            supplierId,
            organizationId,
            reason: 'A stated reason',
            suspendedBy: `USR_${ulid()}`,
            suspendedCorrelationId: ulid(),
          },
        }),
      );

      return id;
    }

    it('refuses a blank reason', async () => {
      const supplier = await seedSupplier();

      await expect(
        raw(() =>
          prisma.client.suspension.create({
            data: {
              id: `SSP_${ulid()}`,
              supplierId: supplier.id,
              organizationId: supplier.organizationId,
              reason: '  ',
              suspendedBy: `USR_${ulid()}`,
              suspendedCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow(/ck_suspension_text_not_blank|check constraint/i);
    });

    it('refuses two open episodes for one supplier', async () => {
      const supplier = await seedSupplier();
      await seedSuspension(supplier.id, supplier.organizationId);

      await expect(seedSuspension(supplier.id, supplier.organizationId)).rejects.toThrow();
    });

    it('allows a second episode once the first is closed', async () => {
      const supplier = await seedSupplier();
      const first = await seedSuspension(supplier.id, supplier.organizationId);

      await raw(() =>
        prisma.client.suspension.update({
          where: { id: first },
          data: {
            reinstatedBy: `USR_${ulid()}`,
            reinstatedAt: new Date(),
            reinstatedCorrelationId: ulid(),
          },
        }),
      );

      await expect(seedSuspension(supplier.id, supplier.organizationId)).resolves.toBeTruthy();
    });

    it('refuses a partial reinstatement', async () => {
      // Two of three is a record that cannot say who lifted the suspension, or
      // when.
      const supplier = await seedSupplier();
      const id = await seedSuspension(supplier.id, supplier.organizationId);

      await expect(
        raw(() =>
          prisma.client.suspension.update({
            where: { id },
            data: { reinstatedBy: `USR_${ulid()}`, reinstatedAt: new Date() },
          }),
        ),
      ).rejects.toThrow(/ck_suspension_reinstatement_complete|check constraint/i);
    });

    it('refuses a reinstatement that predates the suspension', async () => {
      const supplier = await seedSupplier();
      const id = await seedSuspension(supplier.id, supplier.organizationId);

      await expect(
        raw(() =>
          prisma.client.suspension.update({
            where: { id },
            data: {
              reinstatedBy: `USR_${ulid()}`,
              reinstatedAt: new Date('2020-01-01T00:00:00.000Z'),
              reinstatedCorrelationId: ulid(),
            },
          }),
        ),
      ).rejects.toThrow(/ck_suspension_reinstated_after_suspended|check constraint/i);
    });
  });

  describe('history cannot be erased by a cascade', () => {
    it('refuses deleting a supplier that has a qualification', async () => {
      // "No destructive cascade may erase qualification or suspension history
      // accidentally." A DELETE is a foreign key violation — a conversation
      // rather than a loss.
      const supplier = await seedSupplier();

      await raw(() =>
        prisma.client.qualification.create({
          data: {
            id: `QLF_${ulid()}`,
            supplierId: supplier.id,
            organizationId: supplier.organizationId,
            capability: 'CONTRACTING',
            submittedBy: `USR_${ulid()}`,
            submittedCorrelationId: ulid(),
          },
        }),
      );

      await expect(
        raw(() => prisma.client.supplier.delete({ where: { id: supplier.id } })),
      ).rejects.toThrow();
    });

    it('refuses deleting a supplier that has a suspension episode', async () => {
      const supplier = await seedSupplier();

      await raw(() =>
        prisma.client.suspension.create({
          data: {
            id: `SSP_${ulid()}`,
            supplierId: supplier.id,
            organizationId: supplier.organizationId,
            reason: 'A stated reason',
            suspendedBy: `USR_${ulid()}`,
            suspendedCorrelationId: ulid(),
          },
        }),
      );

      await expect(
        raw(() => prisma.client.supplier.delete({ where: { id: supplier.id } })),
      ).rejects.toThrow();
    });

    it('refuses deleting a qualification that has evidence', async () => {
      const supplier = await seedSupplier();
      const qualificationId = `QLF_${ulid()}`;

      await raw(() =>
        prisma.client.qualification.create({
          data: {
            id: qualificationId,
            supplierId: supplier.id,
            organizationId: supplier.organizationId,
            capability: 'CONTRACTING',
            submittedBy: `USR_${ulid()}`,
            submittedCorrelationId: ulid(),
          },
        }),
      );
      await raw(() =>
        prisma.client.qualificationEvidence.create({
          data: {
            id: `QEV_${ulid()}`,
            qualificationId,
            organizationId: supplier.organizationId,
            documentId: 'DOC_1',
            attachedBy: `USR_${ulid()}`,
          },
        }),
      );

      await expect(
        raw(() => prisma.client.qualification.delete({ where: { id: qualificationId } })),
      ).rejects.toThrow();
    });
  });
});
