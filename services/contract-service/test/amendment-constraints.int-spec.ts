import { runUnscoped } from '@rasta/nest-common';
import { startApi, type ApiHarness } from './api-helpers';
import { seedSigned } from './amendment-helpers';
import { cleanup, newOrganizationId, seedDraft, wire, type Wiring } from './helpers';
import { ulid } from 'ulid';

/**
 * What PostgreSQL keeps of amendments, whatever the code forgets (CON-003 PR 3): the cap counters
 * of ADR-068 § 5, the amendment's lifecycle and immutability, the signature's authority and
 * separation of duties, and the agreement between the contract's total and the amendments that
 * made it — checked at commit. Raw SQL as the runtime role, so no guard of the application is in
 * the way.
 */
describe('the database keeps the amendments and the cap counters', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];
  const MAX = '9223372036854775807';

  const exec = (sql: string, ...params: unknown[]) =>
    w.prisma.client.$executeRawUnsafe(sql, ...params);
  const refuses = (sql: string, pattern: RegExp, ...params: unknown[]) =>
    expect(exec(sql, ...params)).rejects.toThrow(pattern);

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  const contractInsert = (overrides: Record<string, string | number> = {}) => {
    const row: Record<string, string | number> = {
      id: `CTR_${ulid()}`,
      organization_id: newOrganizationId(),
      tender_id: `TND_${ulid()}`,
      amount_minor: 1000,
      amendments_total_minor: 0,
      approved_total_minor: 0,
      ...overrides,
    };
    organizations.push(String(row.organization_id));
    return {
      sql: `INSERT INTO contract
        (id, organization_id, tender_id, project_id, winning_bid_id, contractor_organization_id,
         amount_minor, amendments_total_minor, approved_total_minor, matrix_digest, awarded_by,
         awarded_at, status, status_changed_at, status_changed_by, source_event_id, created_at,
         created_by, created_correlation_id, updated_at)
        VALUES ('${row.id}', '${row.organization_id}', '${row.tender_id}', 'PRJ_1', 'BID_1', 'ORG_C',
                ${row.amount_minor}, ${row.amendments_total_minor}, ${row.approved_total_minor},
                repeat('a', 64), 'USR_1', now(), 'SIGNED', now(), 'system', 'EVT_1', now(),
                'system', 'COR_1', now())`,
      row,
    };
  };

  describe('the cap counters (ADR-068 § 5)', () => {
    it('refuse an amendments total or an approved total that breaks the cap — and name the constraint, not an arithmetic error', async () => {
      const ok = (overrides: Record<string, string | number>) =>
        exec(contractInsert(overrides).sql);
      // The cap itself: approved ≤ amount + amendments.
      await ok({ amount_minor: 1000, amendments_total_minor: 0, approved_total_minor: 1000 });
      await ok({ amount_minor: 1000, amendments_total_minor: 500, approved_total_minor: 1500 });
      await refuses(contractInsert({ approved_total_minor: 1001 }).sql, /ck_contract_approved_cap/);
      await refuses(
        contractInsert({ amendments_total_minor: 500, approved_total_minor: 1501 }).sql,
        /ck_contract_approved_cap/,
      );
      await refuses(contractInsert({ approved_total_minor: -1 }).sql, /ck_contract_approved_cap/);

      // The bigint edge: the sum amount + total must fit, so the total is bounded by what is left.
      await ok({ amount_minor: MAX, amendments_total_minor: 0, approved_total_minor: 0 });
      await ok({ amount_minor: 1, amendments_total_minor: '9223372036854775806' });
      await refuses(
        contractInsert({ amount_minor: MAX, amendments_total_minor: 1 }).sql,
        /ck_contract_amount_total_bound/,
      );
      await refuses(
        contractInsert({ amount_minor: 2, amendments_total_minor: '9223372036854775806' }).sql,
        /ck_contract_amount_total_bound/,
      );
      // Only ever added to: never negative.
      await refuses(
        contractInsert({ amendments_total_minor: -1 }).sql,
        /ck_contract_amount_total_bound/,
      );
      // A negative price is still refused as that, not as an overflow of the bound's subtraction.
      await refuses(contractInsert({ amount_minor: -5 }).sql, /ck_contract_amount_positive/);
      await refuses(contractInsert({ amount_minor: 0 }).sql, /ck_contract_amount_positive/);
    });

    it('move only by an effective amendment: not on a contract that is not SIGNED, not to anything but the exact sum, never the approved total', async () => {
      const c = await seedSigned(api, w, organizations);
      await refuses(
        `UPDATE contract SET amendments_total_minor = 5 WHERE id = $1`,
        /ck_contract_amendments_total_exact/,
        c.id,
      );
      await refuses(
        `UPDATE contract SET approved_total_minor = 1 WHERE id = $1`,
        /ck_contract_approved_total_fixed/,
        c.id,
      );
      const draft = await seedDraft(w, organizations);
      await refuses(
        `UPDATE contract SET amendments_total_minor = 5 WHERE id = $1`,
        /ck_contract_amendments_signed/,
        draft.id,
      );
      await refuses(
        `UPDATE contract SET amount_minor = amount_minor + 1 WHERE id = $1`,
        /ck_contract_origin_immutable/,
        c.id,
      );
    });
  });

  describe('the amendment', () => {
    const insertAmendment = (
      contract: { id: string; employer: string },
      overrides: Record<string, string | number> = {},
    ) => {
      const row: Record<string, string | number> = {
        id: `AMD_${ulid()}`,
        amendment_number: 1,
        delta_minor: 5,
        reason_code: 'OTHER',
        reason_text: 'why',
        ...overrides,
      };
      return {
        id: String(row.id),
        sql: `INSERT INTO amendment
          (id, organization_id, contract_id, amendment_number, delta_minor, reason_code, reason_text,
           proposed_by, proposed_at, proposed_correlation_id, updated_at)
          VALUES ('${row.id}', '${contract.employer}', '${contract.id}', ${row.amendment_number},
                  ${row.delta_minor}, '${row.reason_code}', $1, 'USR_1', now(), 'COR_1', now())`,
        text: String(row.reason_text),
      };
    };

    it('is born on a SIGNED contract, PROPOSED, with a positive delta, a code and a bounded bidi-safe text', async () => {
      const c = await seedSigned(api, w, organizations);
      const draft = await seedDraft(w, organizations);
      const attempt = (overrides: Record<string, string | number>, onContract = c) => {
        const a = insertAmendment(onContract, overrides);
        return exec(a.sql, a.text);
      };
      await refuses(insertAmendment(draft, {}).sql, /ck_amendment_contract_signed/, 'why');
      await expect(attempt({ delta_minor: 0 })).rejects.toThrow(/ck_amendment_delta_positive/);
      await expect(attempt({ delta_minor: -1 })).rejects.toThrow(/ck_amendment_delta_positive/);
      await expect(attempt({ reason_code: 'lower' })).rejects.toThrow(/ck_amendment_reason/);
      await expect(attempt({ reason_text: ' ' })).rejects.toThrow(/ck_amendment_reason/);
      await expect(attempt({ reason_text: 'x'.repeat(1001) })).rejects.toThrow(
        /ck_amendment_reason/,
      );
      await expect(attempt({ reason_text: 'a‮b' })).rejects.toThrow(/ck_amendment_reason/);
      await expect(attempt({ amendment_number: 0 })).rejects.toThrow(
        /ck_amendment_number_positive/,
      );
      await attempt({ delta_minor: MAX });
      // One number per contract.
      await expect(attempt({ delta_minor: 1, amendment_number: 1 })).rejects.toThrow(
        /amendment_number\)=\(.*already exists/,
      );
      await attempt({ delta_minor: 1, amendment_number: 2 });
    });

    it('cannot be born EFFECTIVE, cannot become effective without both signatures, and is immutable in what it says', async () => {
      const c = await seedSigned(api, w, organizations);
      const a = insertAmendment(c);
      await exec(a.sql, a.text);
      await refuses(
        `UPDATE amendment SET status = 'EFFECTIVE', effective_at = now() WHERE id = $1`,
        /ck_amendment_signed_by_both/,
        a.id,
      );
      for (const set of [
        `delta_minor = 6`,
        `reason_text = 'edited'`,
        `reason_code = 'SCOPE_CHANGE'`,
        `amendment_number = 9`,
        `proposed_by = 'USR_X'`,
      ]) {
        await refuses(
          `UPDATE amendment SET ${set} WHERE id = $1`,
          /ck_amendment_terms_immutable/,
          a.id,
        );
      }
      await refuses(`DELETE FROM amendment WHERE id = $1`, /ck_amendment_not_erasable/, a.id);
      await refuses(`TRUNCATE amendment`, /permission denied|ck_amendment_not_erasable/);
      const id = `AMD_${ulid()}`;
      await refuses(
        `INSERT INTO amendment
          (id, organization_id, contract_id, amendment_number, delta_minor, reason_code, reason_text,
           status, effective_at, proposed_by, proposed_at, proposed_correlation_id, updated_at)
          VALUES ($1, '${c.employer}', '${c.id}', 2, 5, 'OTHER', 'why', 'EFFECTIVE', now(), 'USR_1',
                  now(), 'COR_1', now())`,
        /ck_amendment_born_proposed/,
        id,
      );
    });

    describe('its signatures and the total, checked at commit', () => {
      /** The signature rows of one amendment, the employer's under the policy in force. */
      async function signaturesFor(
        c: { id: string; employer: string; contractor: string },
        a: string,
      ) {
        const policy = await runUnscoped('the suite reads the policy in force', () =>
          w.prisma.client.approvalPolicy.findFirstOrThrow({
            where: {
              organizationId: c.employer,
              workflowKey: 'contract.signature',
              status: 'ACTIVE',
            },
          }),
        );
        const row = (o: {
          side: 'EMPLOYER' | 'CONTRACTOR';
          signer: string;
          who: string;
          role: string;
          withPolicy: boolean;
        }) =>
          `INSERT INTO amendment_signature
            (id, organization_id, contract_id, amendment_id, side, signer_organization_id, signed_by,
             authority_role, signed_at, correlation_id, policy_id, policy_version)
           VALUES ('AMS_${ulid()}', '${c.employer}', '${c.id}', '${a}', '${o.side}', '${o.signer}',
                   '${o.who}', '${o.role}', now(), 'COR_S',
                   ${o.withPolicy ? "'" + policy.id + "'" : 'NULL'}, ${o.withPolicy ? 1 : 'NULL'})`;
        return {
          employer: (who = 'USR_E', role = 'ORGANIZATION_ADMIN', withPolicy = true) =>
            row({ side: 'EMPLOYER', signer: c.employer, who, role, withPolicy }),
          contractor: (who = 'USR_C', signer = c.contractor) =>
            row({ side: 'CONTRACTOR', signer, who, role: 'CONTRACTOR', withPolicy: false }),
        };
      }

      it('the amendment becomes effective together with the contract’s total, or not at all', async () => {
        const c = await seedSigned(api, w, organizations);
        const a = insertAmendment(c, { delta_minor: 40 });
        await exec(a.sql, a.text);
        const signatures = await signaturesFor(c, a.id);
        await exec(signatures.employer());
        await exec(signatures.contractor());

        // Effective but the contract's total left alone: the commit is refused.
        await expect(
          w.prisma.client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `UPDATE amendment SET status = 'EFFECTIVE', effective_at = now(), version = version + 1 WHERE id = $1`,
              a.id,
            );
          }),
        ).rejects.toThrow(/ck_amendment_total_consistent/);
        expect(
          await w.prisma.client.$queryRawUnsafe<{ status: string }[]>(
            `SELECT status::text FROM amendment WHERE id = $1`,
            a.id,
          ),
        ).toEqual([{ status: 'PROPOSED' }]);

        // The total moved without the amendment having been made effective: refused at the statement.
        await expect(
          w.prisma.client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `UPDATE contract SET amendments_total_minor = 40 WHERE id = $1`,
              c.id,
            );
          }),
        ).rejects.toThrow(/ck_contract_amendments_total_exact/);

        // Both in one transaction — the amendment first, then the exact sum — commits.
        await w.prisma.client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE amendment SET status = 'EFFECTIVE', effective_at = now(), version = version + 1 WHERE id = $1`,
            a.id,
          );
          await tx.$executeRawUnsafe(
            `UPDATE contract SET amendments_total_minor = 40, version = version + 1 WHERE id = $1`,
            c.id,
          );
        });
        // And now it never changes.
        await refuses(
          `UPDATE amendment SET version = version + 1 WHERE id = $1`,
          /ck_amendment_immutable/,
          a.id,
        );
        await refuses(
          `UPDATE amendment_signature SET signed_by = 'x' WHERE amendment_id = $1`,
          /ck_amendment_signature_immutable/,
          a.id,
        );
      });

      it('a signature is refused for an amendment that is not proposed, a side that is not the signer’s, a policy that does not name the role, and one person on both sides', async () => {
        const c = await seedSigned(api, w, organizations);
        const other = await seedSigned(api, w, organizations);
        const a = insertAmendment(c);
        await exec(a.sql, a.text);
        const signatures = await signaturesFor(c, a.id);

        // A side signed by an organization that is not that side; the employer without its policy,
        // or under a role the policy does not name.
        await refuses(
          signatures.contractor('USR_C', c.employer),
          /ck_amendment_signature_side_organization/,
        );
        await refuses(
          signatures.employer('USR_E', 'FLEET_MANAGER'),
          /ck_amendment_signature_policy_authority/,
        );
        await refuses(
          signatures.employer('USR_E', 'ORGANIZATION_ADMIN', false),
          /ck_amendment_signature_policy/,
        );

        // One person on both sides, by user id.
        await exec(signatures.employer('USR_SAME'));
        await refuses(
          signatures.contractor('USR_SAME'),
          /ck_amendment_signature_one_person_one_side/,
        );
        await exec(signatures.contractor('USR_OTHER'));

        // A signature of another contract's amendment is refused.
        const foreign = await signaturesFor(other, a.id);
        await refuses(
          foreign.contractor('USR_Z'),
          /ck_amendment_signature_proposed|amendment_signature_organization_id_amendment_id_fkey/,
        );
      });
    });
  });
});
