import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { cleanup } from './helpers';
import {
  actor,
  apiTenant,
  multiMemberActor,
  platformAdmin,
  supplierActor,
  systemAdminWithoutTenant,
  startApi,
  type ApiHarness,
} from './api-helpers';

/**
 * Who reads what on a decided qualification (Codex review of PR 366, findings
 * 1 and 4), end to end through the HTTP surface and PostgreSQL.
 *
 *   the reviewer's note     platform reviewers only. Never the supplier's own
 *                           organization — whichever role its member holds,
 *                           a platform role included — and the key is absent,
 *                           not null, so "no note" and "not yours" differ.
 *   the rejection reason    written for the supplier: stored on the row and
 *                           returned to every reader of the private record.
 */
describe('a decided qualification, as each reader sees it', () => {
  let api: ApiHarness;
  const supplierOrg = apiTenant('VIS-SUPPLIER');
  const otherSupplierOrg = apiTenant('VIS-OTHER-SUPPLIER');
  const unionOrg = apiTenant('VIS-UNION');
  const organizations = [supplierOrg, otherSupplierOrg];

  const REJECT_REASON = 'The submitted trade licence has expired';
  const REJECT_NOTE = 'Registry clerk confirmed the licence lapsed in spring';
  const APPROVE_NOTE = 'Called the referee on the second document';

  let supplierId: string;
  let otherSupplierId: string;
  let rejectedId: string;
  let approvedId: string;
  let rejectAnswer: Record<string, unknown>;

  const http = () => request(api.app.getHttpServer());
  const reviewer = () => `Bearer ${platformAdmin(unionOrg)}`;
  /** A union administrator who also belongs to the supplier organization. */
  const memberReviewer = () =>
    `Bearer ${multiMemberActor(unionOrg, [supplierOrg], ['UNION_ADMIN'])}`;

  async function registerAndSubmit(org: string, capabilities: string[]) {
    const registered = await http()
      .post('/v1/suppliers')
      .set('authorization', `Bearer ${supplierActor(org)}`)
      .send({ displayName: 'A workshop', capabilities })
      .expect(201);
    const submitted: string[] = [];
    for (const capability of capabilities) {
      const response = await http()
        .post(`/v1/suppliers/${registered.body.id}/qualifications`)
        .set('authorization', `Bearer ${supplierActor(org)}`)
        .send({ capability, evidence: [{ documentId: `DOC-VIS-${capability}` }] })
        .expect(201);
      submitted.push(response.body.id);
    }
    return { id: registered.body.id as string, submitted };
  }

  beforeAll(async () => {
    api = await startApi();
    await cleanup(api.prisma, organizations);

    const supplier = await registerAndSubmit(supplierOrg, ['WORKSHOP_SERVICE', 'GOODS_SUPPLY']);
    supplierId = supplier.id;
    [rejectedId, approvedId] = supplier.submitted as [string, string];

    const rejected = await http()
      .post(`/v1/suppliers/${supplierId}/qualifications/${rejectedId}/reject`)
      .set('authorization', reviewer())
      .send({ reason: REJECT_REASON, note: REJECT_NOTE })
      .expect(200);
    rejectAnswer = rejected.body;
    await http()
      .post(`/v1/suppliers/${supplierId}/qualifications/${approvedId}/approve`)
      .set('authorization', reviewer())
      .send({ note: APPROVE_NOTE })
      .expect(200);

    const other = await registerAndSubmit(otherSupplierOrg, ['CONTRACTING']);
    otherSupplierId = other.id;
    await http()
      .post(`/v1/suppliers/${otherSupplierId}/qualifications/${other.submitted[0]}/reject`)
      .set('authorization', reviewer())
      .send({ reason: 'No contracting references were named', note: 'Second attempt' })
      .expect(200);
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });

  const read = async (token: string) =>
    (await http().get(`/v1/suppliers/${supplierId}`).set('authorization', token).expect(200))
      .body as { qualifications: Record<string, unknown>[] };
  const qualification = (body: { qualifications: Record<string, unknown>[] }, id: string) =>
    body.qualifications.find((row) => row.id === id)!;

  describe('the supplier’s own organization', () => {
    it.each([['SUPPLIER'], ['ORGANIZATION_ADMIN'], ['WORKSHOP']])(
      'as %s reads the rejection reason and no reviewer note',
      async (role) => {
        const body = await read(`Bearer ${actor(supplierOrg, [role])}`);

        expect(qualification(body, rejectedId).rejectionReason).toBe(REJECT_REASON);
        expect(qualification(body, approvedId).rejectionReason).toBeNull();
        for (const row of body.qualifications) {
          expect(Object.keys(row)).not.toContain('decisionNote');
        }
        expect(JSON.stringify(body)).not.toContain(REJECT_NOTE);
        expect(JSON.stringify(body)).not.toContain(APPROVE_NOTE);
      },
    );
  });

  describe('a platform reviewer', () => {
    it('reads both, from another organization', async () => {
      const body = await read(reviewer());

      expect(qualification(body, rejectedId)).toMatchObject({
        rejectionReason: REJECT_REASON,
        decisionNote: REJECT_NOTE,
      });
      expect(qualification(body, approvedId).decisionNote).toBe(APPROVE_NOTE);
    });

    it('reads both as a system administrator with no tenant', async () => {
      const body = await read(`Bearer ${systemAdminWithoutTenant()}`);

      expect(qualification(body, rejectedId).decisionNote).toBe(REJECT_NOTE);
    });

    it('is answered the note on the decision it just made', () => {
      expect(rejectAnswer).toMatchObject({
        id: rejectedId,
        state: 'REJECTED',
        rejectionReason: REJECT_REASON,
        decisionNote: REJECT_NOTE,
      });
    });

    it('reads no note on the record of a supplier it belongs to', async () => {
      // Platform scope, so the record is readable — but this is the supplier's
      // side reading its own file (the membership-set rule of self-judgement).
      const body = await read(memberReviewer());

      expect(qualification(body, rejectedId).rejectionReason).toBe(REJECT_REASON);
      expect(JSON.stringify(body)).not.toContain(REJECT_NOTE);
      expect(JSON.stringify(body)).not.toContain(APPROVE_NOTE);
    });

    it('reads, in the review queue, the notes of every supplier but the one it belongs to', async () => {
      const queue = async (token: string) => {
        const rows: Record<string, unknown>[] = [];
        let cursor: string | null = null;
        for (let pages = 0; pages < 200; pages += 1) {
          const response: request.Response = await http()
            .get(
              `/v1/suppliers/qualifications?state=REJECTED&limit=100${cursor ? `&cursor=${cursor}` : ''}`,
            )
            .set('authorization', token)
            .expect(200);
          rows.push(...response.body.items);
          if (!response.body.hasMore) break;
          cursor = response.body.nextCursor;
        }
        return rows;
      };

      const member = await queue(memberReviewer());
      const own = member.find((row) => row.id === rejectedId)!;
      const other = member.find((row) => row.supplierId === otherSupplierId)!;
      expect(Object.keys(own)).not.toContain('decisionNote');
      expect(own.rejectionReason).toBe(REJECT_REASON);
      expect(other.decisionNote).toBe('Second attempt');

      const unrelated = await queue(reviewer());
      expect(unrelated.find((row) => row.id === rejectedId)!.decisionNote).toBe(REJECT_NOTE);
    });
  });

  describe('the row', () => {
    it('stores the reason beside the private note', async () => {
      const row = await runUnscoped('the suite reads the row directly', () =>
        api.prisma.client.qualification.findUniqueOrThrow({ where: { id: rejectedId } }),
      );

      expect(row.rejectionReason).toBe(REJECT_REASON);
      expect(row.decisionNote).toBe(REJECT_NOTE);
    });

    it('refuses a new rejection without a reason, and a reason on anything but a rejection', async () => {
      const { submitted } = await registerAndSubmit(apiTenant('VIS-CHECKS'), ['GOODS_SUPPLY']);
      const id = submitted[0]!;
      const decide = (state: string, reason: string | null) =>
        runUnscoped(
          'the suite writes past the service to reach the constraint',
          () =>
            api.prisma.client.$executeRaw`
            UPDATE "qualification"
               SET "state" = ${state}::"QualificationState",
                   "decided_by" = 'USR-CHECK',
                   "decided_at" = now(),
                   "decided_correlation_id" = 'corr-check',
                   "rejection_reason" = ${reason}
             WHERE "id" = ${id}`,
        );

      await expect(decide('REJECTED', null)).rejects.toThrow(
        /ck_qualification_rejected_has_reason/,
      );
      await expect(decide('APPROVED', 'A reason on an approval')).rejects.toThrow(
        /ck_qualification_rejection_reason_shape/,
      );
      await expect(decide('REJECTED', '   ')).rejects.toThrow(
        /ck_qualification_rejection_reason_shape/,
      );
      await expect(decide('REJECTED', 'A real stated reason')).resolves.toBe(1);

      const organizationId = (
        await runUnscoped('cleanup of the extra tenant', () =>
          api.prisma.client.qualification.findUniqueOrThrow({ where: { id } }),
        )
      ).organizationId;
      await cleanup(api.prisma, [organizationId]);
    });
  });
});
