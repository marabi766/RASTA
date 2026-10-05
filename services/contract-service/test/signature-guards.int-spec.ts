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

  type PolicyStage = 'DRAFT' | 'PENDING_PLATFORM_APPROVAL' | 'ACTIVE' | 'RETIRED';

  interface RawPolicy {
    id: string;
    version: number;
  }

  /**
   * A `contract.signature` policy for `employer`, taken through the lifecycle the database keeps
   * (each UPDATE is a declared transition with its who-and-when) as far as `stage`. Raw SQL through
   * the runtime role, because it is the database that is under test.
   */
  async function policyOf(
    employer: string,
    stage: PolicyStage = 'ACTIVE',
    roles: string[] = ['ORGANIZATION_ADMIN'],
    policyVersion = 1,
  ): Promise<RawPolicy> {
    const id = `APL_${ulid()}`;
    const at = new Date();
    organizations.push(employer);
    await runtime.$executeRawUnsafe(
      `INSERT INTO "approval_policy" ("id","organization_id","author_organization_id","author_role",
         "workflow_key","policy_version","label","rationale","created_at","created_by",
         "created_correlation_id")
       VALUES ($1,$2,'ORG_UNION','UNION_ADMIN','contract.signature',$3,'who signs','a reason',$4,
         'USR_AUTHOR',$5)`,
      id,
      employer,
      policyVersion,
      at,
      ulid(),
    );
    let order = 1;
    for (const role of roles) {
      await runtime.$executeRawUnsafe(
        `INSERT INTO "approval_policy_step" ("id","organization_id","policy_id","step_order",
           "authority_organization_id","authority_role","authority_label")
         VALUES ($1,$2,$3,$4,$2,$5,'signer')`,
        `APS_${ulid()}`,
        employer,
        id,
        order++,
        role,
      );
    }
    const to = async (set: string) => {
      await runtime.$executeRawUnsafe(
        `UPDATE "approval_policy" SET ${set}, "version" = "version" + 1 WHERE "id" = $1`,
        id,
      );
    };
    if (stage === 'DRAFT') return { id, version: policyVersion };
    await to(
      `"status" = 'PENDING_PLATFORM_APPROVAL', "submitted_at" = now(), "submitted_by" = 'USR_AUTHOR'`,
    );
    if (stage === 'PENDING_PLATFORM_APPROVAL') return { id, version: policyVersion };
    await to(`"status" = 'ACTIVE', "activated_at" = now(), "activated_by" = 'USR_PLATFORM'`);
    if (stage === 'ACTIVE') return { id, version: policyVersion };
    await to(`"status" = 'RETIRED', "retired_at" = now(), "retired_by" = 'USR_PLATFORM'`);
    return { id, version: policyVersion };
  }

  /** The policy each employer's signatures rest on, unless a test names another. */
  const inForce = new Map<string, RawPolicy>();
  async function activePolicyOf(employer: string): Promise<RawPolicy> {
    const known = inForce.get(employer);
    if (known) return known;
    const created = await policyOf(employer);
    inForce.set(employer, created);
    return created;
  }

  interface SignatureOverrides {
    side?: 'EMPLOYER' | 'CONTRACTOR';
    signer?: string;
    signedBy?: string;
    issuer?: string | null;
    subject?: string | null;
    role?: string;
    /** The policy the signature names: the employer's in force by default; `null` for none. */
    policy?: RawPolicy | null;
  }

  /** One signature as the service writes it, with whatever the test wants to get wrong. */
  async function sign(contract: Seeded, overrides: SignatureOverrides = {}): Promise<number> {
    const side = overrides.side ?? 'EMPLOYER';
    const signer =
      overrides.signer ?? (side === 'EMPLOYER' ? contract.employer : contract.contractor);
    const user = overrides.signedBy ?? `USR_${ulid()}`;
    const policy =
      'policy' in overrides
        ? overrides.policy
        : side === 'EMPLOYER'
          ? await activePolicyOf(contract.employer)
          : null;
    return runtime.$executeRawUnsafe(
      `INSERT INTO "contract_signature" ("id","organization_id","contract_id","side",
         "signer_organization_id","signed_by","signed_by_issuer","signed_by_subject",
         "authority_role","signed_at","correlation_id","policy_id","policy_version")
       VALUES ($1,$2,$3,$4::"ContractSide",$5,$6,$7,$8,$9,now(),$10,$11,$12)`,
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
      policy?.id ?? null,
      policy?.version ?? null,
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
      // The contractor's side: the employer's role is judged against its policy first.
      expect(await refusal(sign(contract, { side: 'CONTRACTOR', role: 'not a role' }))).toContain(
        'ck_signature_authority_role',
      );
    });
  });

  describe('the employer’s side rests on a policy in force, whatever the code forgets', () => {
    it('is refused with no policy named, and the contractor’s side is refused one', async () => {
      const contract = await draft();
      expect(await refusal(sign(contract, { side: 'EMPLOYER', policy: null }))).toContain(
        'ck_signature_policy',
      );
      const policy = await activePolicyOf(contract.employer);
      expect(await refusal(sign(contract, { side: 'CONTRACTOR', policy }))).toContain(
        'ck_signature_policy',
      );
    });

    it.each<[string, PolicyStage]>([
      ['a draft', 'DRAFT'],
      ['one awaiting the platform’s approval', 'PENDING_PLATFORM_APPROVAL'],
      ['one retired', 'RETIRED'],
    ])('is refused under %s: only a policy in force authorises', async (_label, stage) => {
      const contract = await draft();
      const policy = await policyOf(contract.employer, stage);
      expect(await refusal(sign(contract, { policy }))).toContain('ck_signature_policy_authority');
    });

    it('is refused under the version it does not name, a role the policy does not name, and another organization’s policy', async () => {
      const contract = await draft();
      const policy = await policyOf(contract.employer, 'ACTIVE', ['PROCUREMENT_USER']);
      expect(await refusal(sign(contract, { policy: { ...policy, version: 2 } }))).toContain(
        'ck_signature_policy_authority',
      );
      expect(await refusal(sign(contract, { policy, role: 'ORGANIZATION_ADMIN' }))).toContain(
        'ck_signature_policy_authority',
      );
      expect(await sign(contract, { policy, role: 'PROCUREMENT_USER' })).toBe(1);

      // A policy of another organization is not this employer's: the foreign key is tenant-bound.
      const other = await draft();
      const foreign = await policyOf(other.employer);
      expect(await refusal(sign(contract, { side: 'CONTRACTOR', policy: foreign }))).toMatch(
        /ck_signature_policy|violates foreign key|23503/,
      );
      const third = await draft();
      expect(await refusal(sign(third, { policy: foreign }))).toMatch(
        /violates foreign key|23503|ck_signature_policy_authority/,
      );
    });

    it('accepts the employer under a policy in force that names its role', async () => {
      const contract = await draft();
      expect(await sign(contract)).toBe(1);
    });
  });

  describe('a policy is written once, in force at most once, and never erased', () => {
    it('cannot be edited: its words, its author and its history are fixed', async () => {
      const contract = await draft();
      const policy = await policyOf(contract.employer);
      for (const set of [
        `"label" = 'another'`,
        `"rationale" = 'another reason'`,
        `"organization_id" = 'ORG_ELSEWHERE'`,
        `"author_role" = 'SYSTEM_ADMIN'`,
        `"created_by" = 'USR_OTHER'`,
        `"policy_version" = 9`,
      ]) {
        expect(
          await refusal(
            runtime.$executeRawUnsafe(
              `UPDATE "approval_policy" SET ${set} WHERE "id" = $1`,
              policy.id,
            ),
          ),
        ).toContain('ck_policy_immutable');
      }
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `UPDATE "approval_policy" SET "activated_by" = 'USR_OTHER' WHERE "id" = $1`,
            policy.id,
          ),
        ),
      ).toContain('ck_policy_history_immutable');
    });

    it('moves only along the declared transitions, each with its who and when', async () => {
      const contract = await draft();
      const policy = await policyOf(contract.employer, 'DRAFT');
      const move = (set: string) =>
        runtime.$executeRawUnsafe(`UPDATE "approval_policy" SET ${set} WHERE "id" = $1`, policy.id);
      expect(
        await refusal(
          move(`"status" = 'ACTIVE', "activated_at" = now(), "activated_by" = 'USR_X'`),
        ),
      ).toContain('ck_policy_transition');
      expect(await refusal(move(`"status" = 'RETIRED'`))).toContain('ck_policy_transition');
      // Declared, but without who and when: the table's checks refuse a policy in force that no
      // platform administrator approved.
      expect(await refusal(move(`"status" = 'PENDING_PLATFORM_APPROVAL'`))).toContain(
        'ck_policy_submission_complete',
      );
    });

    it('has at most one policy in force per organization and workflow', async () => {
      const contract = await draft();
      await policyOf(contract.employer, 'ACTIVE', ['ORGANIZATION_ADMIN'], 1);
      expect(
        await refusal(policyOf(contract.employer, 'ACTIVE', ['ORGANIZATION_ADMIN'], 2)),
      ).toMatch(/ux_approval_policy_active|23505|already exists/);
    });

    it('is never deleted or truncated, and its steps are never changed, deleted or added to after the draft', async () => {
      const contract = await draft();
      const policy = await policyOf(contract.employer);
      expect(
        await refusal(
          runtime.$executeRawUnsafe(`DELETE FROM "approval_policy" WHERE "id" = $1`, policy.id),
        ),
      ).toContain('ck_policy_not_erasable');
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `UPDATE "approval_policy_step" SET "authority_role" = 'DRIVER' WHERE "policy_id" = $1`,
            policy.id,
          ),
        ),
      ).toContain('ck_step_immutable');
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `DELETE FROM "approval_policy_step" WHERE "policy_id" = $1`,
            policy.id,
          ),
        ),
      ).toContain('ck_step_immutable');
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `INSERT INTO "approval_policy_step" ("id","organization_id","policy_id","step_order",
               "authority_organization_id","authority_role","authority_label")
             VALUES ($1,$2,$3,9,$2,'DRIVER','late')`,
            `APS_${ulid()}`,
            contract.employer,
            policy.id,
          ),
        ),
      ).toContain('ck_step_policy_draft');
      expect(
        await refusal(runtime.$executeRawUnsafe('TRUNCATE TABLE "approval_policy" CASCADE')),
      ).toMatch(/ck_policy_not_erasable|permission denied/);
    });

    it('never names the oversight role or the platform operator as an authority, nor a workflow it has no policy for', async () => {
      const contract = await draft();
      for (const [index, role] of ['AUDITOR', 'SYSTEM_ADMIN'].entries()) {
        // A distinct version each: the policy row of a refused step is already written.
        expect(await refusal(policyOf(contract.employer, 'DRAFT', [role], index + 10))).toContain(
          'ck_step_authority_not_oversight',
        );
      }
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `INSERT INTO "approval_policy" ("id","organization_id","author_organization_id","author_role",
               "workflow_key","policy_version","label","rationale","created_at","created_by",
               "created_correlation_id")
             VALUES ($1,$2,'ORG_UNION','UNION_ADMIN','contract.amendment',1,'x','y',now(),'USR_A',$3)`,
            `APL_${ulid()}`,
            contract.employer,
            ulid(),
          ),
        ),
      ).toContain('ck_policy_workflow_key');
      expect(
        await refusal(
          runtime.$executeRawUnsafe(
            `INSERT INTO "approval_policy" ("id","organization_id","author_organization_id","author_role",
               "workflow_key","policy_version","label","rationale","created_at","created_by",
               "created_correlation_id")
             VALUES ($1,$2,$2,'ORGANIZATION_ADMIN','contract.signature',1,'x','y',now(),'USR_A',$3)`,
            `APL_${ulid()}`,
            contract.employer,
            ulid(),
          ),
        ),
      ).toContain('ck_policy_author_role');
    });

    it('the runtime role cannot lift any of it (D-045)', async () => {
      for (const statement of [
        'ALTER TABLE "approval_policy" DISABLE TRIGGER "tg_approval_policy_guard"',
        'ALTER TABLE "approval_policy_step" DISABLE TRIGGER "tg_approval_policy_step_immutable"',
        'DROP TRIGGER "tg_approval_policy_no_truncate" ON "approval_policy"',
        'ALTER TABLE "approval_policy" ADD COLUMN d045_probe int',
      ]) {
        await refusal(runtime.$executeRawUnsafe(statement));
      }
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
