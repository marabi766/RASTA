import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { cleanup, databaseUrl, newOrganizationId } from './helpers';

/**
 * What the database keeps of a signature and of the lifecycle whatever a future write path
 * forgets (migration `contract_sign_cancel`, ADR-068 § 2, Q-95): a signature is written once,
 * only on a draft, only for a side by that side's organization, never by one person for both
 * sides; a contract is SIGNED only when both sides have signed; only the declared transitions
 * exist, a final contract never changes, and the reason it was cancelled never changes. Every
 * statement is raw SQL through the **runtime** role with no tenant guard in between, because it
 * is the database that is under test.
 */
describe('the signature and lifecycle guarantees of the database', () => {
  let runtime: PrismaClient;
  const organizations: string[] = [];

  interface Seeded {
    id: string;
    employer: string;
    contractor: string;
  }

  async function draft(): Promise<Seeded> {
    const employer = newOrganizationId();
    const contractor = newOrganizationId();
    organizations.push(employer, contractor);
    const at = new Date();
    const id = `CTR_${ulid()}`;
    await runtime.$executeRawUnsafe(
      `INSERT INTO "contract" ("id","organization_id","tender_id","project_id","winning_bid_id",
         "contractor_organization_id","amount_minor","matrix_digest","awarded_by","awarded_at",
         "status_changed_at","status_changed_by","source_event_id","created_at","created_by",
         "created_correlation_id","updated_at")
       VALUES ($1,$2,$3,$4,$5,$6,1000000,$7,'USR_x',$8,$8,'service:contract-service',$9,$8,
         'service:contract-service',$10,$8)`,
      id,
      employer,
      `TND_${ulid()}`,
      `PRJ_${ulid()}`,
      `BID_${ulid()}`,
      contractor,
      'c'.repeat(64),
      at,
      ulid(),
      ulid(),
    );
    return { id, employer, contractor };
  }

  interface SignatureOverrides {
    side?: 'EMPLOYER' | 'CONTRACTOR';
    signer?: string;
    signedBy?: string;
    issuer?: string | null;
    subject?: string | null;
    role?: string;
  }

  /** One signature as the service writes it, with whatever the test wants to get wrong. */
  function sign(contract: Seeded, overrides: SignatureOverrides = {}): Promise<number> {
    const side = overrides.side ?? 'EMPLOYER';
    const signer =
      overrides.signer ?? (side === 'EMPLOYER' ? contract.employer : contract.contractor);
    const user = overrides.signedBy ?? `USR_${ulid()}`;
    return runtime.$executeRawUnsafe(
      `INSERT INTO "contract_signature" ("id","organization_id","contract_id","side",
         "signer_organization_id","signed_by","signed_by_issuer","signed_by_subject",
         "authority_role","signed_at","correlation_id")
       VALUES ($1,$2,$3,$4::"ContractSide",$5,$6,$7,$8,$9,now(),$10)`,
      `CSG_${ulid()}`,
      contract.employer,
      contract.id,
      side,
      signer,
      user,
      'issuer' in overrides ? overrides.issuer : 'http://issuer.invalid/realms/x',
      'subject' in overrides ? overrides.subject : `sub-${ulid()}`,
      overrides.role ?? (side === 'EMPLOYER' ? 'ORGANIZATION_ADMIN' : 'CONTRACTOR'),
      ulid(),
    );
  }

  const update = (contract: Seeded, set: string) =>
    runtime.$executeRawUnsafe(
      `UPDATE "contract" SET ${set}, "updated_at" = now(), "status_changed_at" = now() WHERE "id" = $1`,
      contract.id,
    );

  const refusal = async (promise: Promise<unknown>): Promise<string> => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    return String((error as Error).message);
  };

  beforeAll(() => {
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    await cleanup(organizations);
    await runtime.$disconnect();
  });

  describe('a signature is a record', () => {
    it('is accepted for a draft, one per side, by the side’s own organization', async () => {
      const contract = await draft();
      expect(await sign(contract, { side: 'EMPLOYER' })).toBe(1);
      expect(await sign(contract, { side: 'CONTRACTOR' })).toBe(1);
    });

    it('is written once per side: a second signature for a side is refused by the unique index', async () => {
      const contract = await draft();
      await sign(contract, { side: 'EMPLOYER' });
      // SQLSTATE 23505, unique_violation (Prisma's raw-query text names the key, not the index).
      expect(await refusal(sign(contract, { side: 'EMPLOYER' }))).toMatch(/23505|already exists/);
    });

    it('is never changed, deleted or truncated — by anyone holding the runtime role', async () => {
      const contract = await draft();
      await sign(contract);
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `UPDATE "contract_signature" SET "signed_by" = 'USR_other' WHERE "contract_id" = $1`,
            contract.id,
          ),
        ),
      ).toContain('ck_signature_immutable');
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `DELETE FROM "contract_signature" WHERE "contract_id" = $1`,
            contract.id,
          ),
        ),
      ).toContain('ck_signature_immutable');
      // The runtime role holds no TRUNCATE privilege at all; the statement trigger is the second line.
      expect(
        await refusal(runtime.$executeRawUnsafe('TRUNCATE TABLE "contract_signature"')),
      ).toMatch(/ck_signature_immutable|permission denied/);
    });

    it('is refused on a contract that is no longer a draft', async () => {
      const cancelled = await draft();
      await update(
        cancelled,
        `"status" = 'CANCELLED', "cancel_reason_code" = 'OTHER', "version" = 2`,
      );
      expect(await refusal(sign(cancelled))).toContain('ck_signature_contract_draft');
    });

    it('is refused for a side by an organization that is not that side', async () => {
      const contract = await draft();
      expect(
        await refusal(sign(contract, { side: 'EMPLOYER', signer: contract.contractor })),
      ).toContain('ck_signature_side_organization');
      expect(
        await refusal(sign(contract, { side: 'CONTRACTOR', signer: contract.employer })),
      ).toContain('ck_signature_side_organization');
      expect(await refusal(sign(contract, { signer: newOrganizationId() }))).toContain(
        'ck_signature_side_organization',
      );
    });

    it('is refused for a contract that does not exist in that organization', async () => {
      const contract = await draft();
      const elsewhere = { ...contract, employer: newOrganizationId() };
      expect(await refusal(sign(elsewhere))).toMatch(
        /violates foreign key|ck_signature_contract_draft/,
      );
    });

    it('never names half an identity: an issuer without a subject, or the reverse, is refused', async () => {
      const contract = await draft();
      expect(
        await refusal(sign(contract, { issuer: 'http://issuer.invalid', subject: null })),
      ).toContain('ck_signature_identity');
      expect(await refusal(sign(contract, { issuer: null, subject: 'sub-x' }))).toContain(
        'ck_signature_identity',
      );
      // Neither is an identity that is simply unknown: the service refuses to rely on it.
      expect(await sign(contract, { issuer: null, subject: null })).toBe(1);
    });

    it('is accepted only under a role that is a code', async () => {
      const contract = await draft();
      expect(await refusal(sign(contract, { role: 'not a role' }))).toContain(
        'ck_signature_authority_role',
      );
    });
  });

  describe('one person is never both sides, whatever the code forgets', () => {
    it('refuses the same user id on the other side', async () => {
      const contract = await draft();
      await sign(contract, { side: 'EMPLOYER', signedBy: 'USR_SAME' });
      expect(await refusal(sign(contract, { side: 'CONTRACTOR', signedBy: 'USR_SAME' }))).toContain(
        'ck_signature_one_person_one_side',
      );
    });

    it('refuses one side’s user id that is the other side’s subject — a token without rasta_uid', async () => {
      const contract = await draft();
      await sign(contract, { side: 'EMPLOYER', signedBy: 'USR_A', subject: 'sub-shared' });
      expect(
        await refusal(
          sign(contract, { side: 'CONTRACTOR', signedBy: 'sub-shared', subject: 'sub-b' }),
        ),
      ).toContain('ck_signature_one_person_one_side');
    });

    it('refuses the same issuer and subject under another user id', async () => {
      const contract = await draft();
      await sign(contract, { side: 'EMPLOYER', signedBy: 'USR_A', subject: 'sub-one' });
      expect(
        await refusal(
          sign(contract, { side: 'CONTRACTOR', signedBy: 'USR_B', subject: 'sub-one' }),
        ),
      ).toContain('ck_signature_one_person_one_side');
    });

    it('accepts two people: another user id and another subject under one issuer', async () => {
      const contract = await draft();
      await sign(contract, { side: 'EMPLOYER', signedBy: 'USR_A', subject: 'sub-a' });
      expect(
        await sign(contract, { side: 'CONTRACTOR', signedBy: 'USR_B', subject: 'sub-b' }),
      ).toBe(1);
    });
  });

  describe('the lifecycle is the declared one', () => {
    it('SIGNED needs both sides’ signatures: none, or one, is refused', async () => {
      const contract = await draft();
      const toSigned = `"status" = 'SIGNED', "version" = 2`;
      expect(await refusal(update(contract, toSigned))).toContain('ck_contract_signed_by_both');
      await sign(contract, { side: 'EMPLOYER' });
      expect(await refusal(update(contract, toSigned))).toContain('ck_contract_signed_by_both');
      await sign(contract, { side: 'CONTRACTOR' });
      expect(await update(contract, toSigned)).toBe(1);
    });

    it('a draft moves only to SIGNED or CANCELLED; SIGNED only to COMPLETED; COMPLETED only to SETTLED', async () => {
      const draftToCompleted = await draft();
      expect(
        await refusal(update(draftToCompleted, `"status" = 'COMPLETED', "version" = 2`)),
      ).toContain('ck_contract_transition');
      expect(
        await refusal(update(draftToCompleted, `"status" = 'SETTLED', "version" = 2`)),
      ).toContain('ck_contract_transition');

      const signed = await draft();
      await sign(signed, { side: 'EMPLOYER' });
      await sign(signed, { side: 'CONTRACTOR' });
      await update(signed, `"status" = 'SIGNED', "version" = 2`);
      expect(await refusal(update(signed, `"status" = 'DRAFT', "version" = 3`))).toContain(
        'ck_contract_transition',
      );
      expect(
        await refusal(
          update(signed, `"status" = 'CANCELLED', "cancel_reason_code" = 'OTHER', "version" = 3`),
        ),
      ).toContain('ck_contract_transition');
      expect(await refusal(update(signed, `"status" = 'SETTLED', "version" = 3`))).toContain(
        'ck_contract_transition',
      );
      expect(await update(signed, `"status" = 'COMPLETED', "version" = 3`)).toBe(1);
      expect(await update(signed, `"status" = 'SETTLED', "version" = 4`)).toBe(1);
    });

    it('a cancelled or settled contract never changes again', async () => {
      const cancelled = await draft();
      await update(
        cancelled,
        `"status" = 'CANCELLED', "cancel_reason_code" = 'OTHER', "version" = 2`,
      );
      expect(await refusal(update(cancelled, `"version" = 3`))).toContain('ck_contract_final');
      expect(await refusal(update(cancelled, `"status" = 'DRAFT', "version" = 3`))).toContain(
        'ck_contract_final',
      );
    });

    it('a cancellation has a reason exactly when it is a cancellation, and the reason never changes', async () => {
      const noReason = await draft();
      expect(await refusal(update(noReason, `"status" = 'CANCELLED', "version" = 2`))).toContain(
        'ck_contract_cancellation',
      );
      const reasonWithoutCancel = await draft();
      expect(
        await refusal(update(reasonWithoutCancel, `"cancel_reason_code" = 'OTHER'`)),
      ).toContain('ck_contract_cancellation');
      const noteWithoutReason = await draft();
      expect(await refusal(update(noteWithoutReason, `"cancel_note" = 'a note'`))).toContain(
        'ck_contract_cancellation',
      );
      const badCode = await draft();
      expect(
        await refusal(
          update(
            badCode,
            `"status" = 'CANCELLED', "cancel_reason_code" = 'lower case', "version" = 2`,
          ),
        ),
      ).toContain('ck_contract_cancellation');
    });
  });

  describe('the runtime role cannot lift any of it (D-045)', () => {
    it('cannot disable or drop the signature triggers, or alter the table', async () => {
      for (const statement of [
        'ALTER TABLE "contract_signature" DISABLE TRIGGER "tg_contract_signature_immutable"',
        'ALTER TABLE "contract_signature" DISABLE TRIGGER "tg_contract_signature_insert"',
        'DROP TRIGGER "tg_contract_signature_no_truncate" ON "contract_signature"',
        'ALTER TABLE "contract_signature" ADD COLUMN d045_probe int',
      ]) {
        await refusal(runtime.$executeRawUnsafe(statement));
      }
    });
  });
});
