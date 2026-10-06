import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { ulid } from 'ulid';
import { person, startApi, type ApiHarness } from './api-helpers';
import { cleanup, ownerDatabaseUrl, seedDraft, wire, type Wiring } from './helpers';

/**
 * The migrations' rollbacks never destroy what is immutable (the precedent of #208 and #222). A
 * signature is the audit record of who accepted a contract, a cancellation reason is why it ended,
 * and an approval policy is who was allowed to sign for an employer: a `down.sql` that dropped
 * them would leave SIGNED and CANCELLED contracts with nothing behind them. So each stops, with a
 * message, once the data exists, and changes nothing.
 *
 * Each script is `BEGIN; LOCK TABLE …; DO $preflight_… $$ … $$;` then the drops and `COMMIT;`. The
 * first two tests run the lock and the check — not the drops — against this database, in a
 * transaction that is rolled back whatever happens, with rows that exist. The second describe runs
 * **each whole file** the way an operator does, `psql --file`, against a scratch schema holding
 * real rows: it refuses and changes nothing, with `-v ON_ERROR_STOP=1` and without it, and on
 * unused data it succeeds. That the scripts are the exact inverse of their migrations on an unused
 * database (up → down → up) is `verify-migration-reversible.mjs contract`.
 */
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

function preflightOf(migration: string, name: string) {
  const text = readFileSync(join(MIGRATIONS, migration, 'down.sql'), 'utf8');
  const lock = /^LOCK TABLE [^;]+;/m.exec(text)?.[0];
  const check = new RegExp(`DO \\$${name}\\$[\\s\\S]*?\\$${name}\\$;`).exec(text)?.[0];
  expect(lock).toContain('ACCESS EXCLUSIVE');
  expect(check).toBeDefined();
  // Locked, then checked, and only then anything dropped.
  const firstDrop = text.search(/^(DROP|ALTER TABLE .* DROP|CREATE OR REPLACE)/m);
  expect(text.indexOf(lock!)).toBeLessThan(text.indexOf(check!));
  expect(text.indexOf(check!)).toBeLessThan(firstDrop);
  return { lock: lock!.replace(/;$/, ''), check: check!.replace(/;$/, '') };
}

describe('the migrations’ rollbacks refuse once their data exists', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const runPreflight = (migration: string, name: string) => {
    const { lock, check } = preflightOf(migration, name);
    return w.prisma.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(lock);
      await tx.$executeRawUnsafe(check);
    });
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  const sign = (id: string, token: string) =>
    request(api.app.getHttpServer())
      .post(`/v1/contracts/${id}/sign`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `rollback-${ulid()}`)
      .send({});

  it('signing_policy: refuses while a policy exists, naming it, and touches nothing', async () => {
    const { id, employer } = await seedDraft(w, organizations);
    await sign(id, person(employer, ['ORGANIZATION_ADMIN'])).expect(200);

    await expect(runPreflight('20261005150000_signing_policy', 'preflight_policy')).rejects.toThrow(
      /down refused: \d+ approval polic\(ies\) and \d+ employer signature\(s\) name them; nothing was changed/,
    );
    const policies = await w.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "approval_policy" WHERE "organization_id" = $1`,
      employer,
    );
    const signatures = await w.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "contract_signature" WHERE "organization_id" = $1 AND "policy_id" IS NOT NULL`,
      employer,
    );
    expect([Number(policies[0]!.n), Number(signatures[0]!.n)]).toEqual([1, 1]);
  });

  it('contract_sign_cancel: refuses while a signature or a SIGNED or CANCELLED contract exists, and touches nothing', async () => {
    const signed = await seedDraft(w, organizations);
    await sign(signed.id, person(signed.employer, ['ORGANIZATION_ADMIN'])).expect(200);
    await sign(signed.id, person(signed.contractor, ['CONTRACTOR'])).expect(200);
    const cancelled = await seedDraft(w, organizations);
    await request(api.app.getHttpServer())
      .post(`/v1/contracts/${cancelled.id}/cancel`)
      .set('authorization', `Bearer ${person(cancelled.employer, ['ORGANIZATION_ADMIN'])}`)
      .set('idempotency-key', `rollback-${ulid()}`)
      .send({ reasonCode: 'OTHER', note: 'the terms were not agreed' })
      .expect(200);

    await expect(
      runPreflight('20261005140000_contract_sign_cancel', 'preflight_sign_cancel'),
    ).rejects.toThrow(
      /down refused: \d+ signature\(s\) and \d+ signed or cancelled contract\(s\) exist; nothing was changed/,
    );
    const rows = await w.prisma.client.$queryRawUnsafe<{ status: string; reason: string | null }[]>(
      `SELECT "status"::text AS status, "cancel_reason_code" AS reason FROM "contract"
        WHERE "organization_id" IN ($1, $2) ORDER BY "status"`,
      signed.employer,
      cancelled.employer,
    );
    expect(rows).toEqual([
      { status: 'CANCELLED', reason: 'OTHER' },
      { status: 'SIGNED', reason: null },
    ]);
  });
});

/**
 * The whole file, through the supported execution path (#231 review round 2): `psql --file`, whose
 * default is autocommit — a `LOCK TABLE` there ends with its own statement, so without the file's
 * own `BEGIN; … COMMIT;` a signature could commit between the check and the drops, and a check
 * that raised would not stop the statements after it unless `ON_ERROR_STOP` is set. Each case runs
 * against a scratch schema of this database, built by applying the real migrations, and holds the
 * file to: refuse and change nothing over rows that exist (with `ON_ERROR_STOP` and without it),
 * and succeed over unused data.
 */
describe('each down.sql, run whole with psql --file', () => {
  jest.setTimeout(120_000);
  const ALL = readdirSync(MIGRATIONS)
    .filter((name) => /^\d{14}_/.test(name))
    .sort();
  const AMENDMENTS = '20261007100000_amendments_milestones';
  const DETECTION = '20261006160000_review_detection_provenance';
  const VERSION = '20261006140000_signature_hierarchy_version';
  const REVIEW = '20261006120000_signature_authority_review';
  const SUSPENSION = '20261006100000_policy_suspension';
  const SIGNING_POLICY = '20261005150000_signing_policy';
  const SIGN_CANCEL = '20261005140000_contract_sign_cancel';
  const schemas: string[] = [];

  /**
   * What psql connects with, as the PG* environment — host, user, password and database — so no
   * url, and no password, is ever on a command line another local user can read (D-045 follow-up).
   * `search_path` points the session at the scratch schema alone.
   */
  const connection = (schema: string): NodeJS.ProcessEnv => {
    const parts = /^postgres(?:ql)?:\/\/([^:@/]+):([^@]*)@([^:/?]+)(?::(\d+))?\/([^?]+)/.exec(
      ownerDatabaseUrl(),
    );
    if (!parts) throw new Error('DATABASE_URL_CONTRACT_MIGRATOR is not a postgresql:// url');
    const [, user, password, host, port, database] = parts;
    return {
      ...process.env,
      PGHOST: host!,
      PGPORT: port ?? '5432',
      PGUSER: decodeURIComponent(user!),
      PGPASSWORD: decodeURIComponent(password!),
      PGDATABASE: decodeURIComponent(database!),
      PGOPTIONS: `-c search_path=${schema} -c timezone=UTC`,
    };
  };

  /** Runs psql; never echoes the connection. `stop` is `-v ON_ERROR_STOP=1`. */
  const psql = (schema: string, args: string[], stop = true) => {
    const result = spawnSync(
      'psql',
      ['-X', '-q', '-At', ...(stop ? ['-v', 'ON_ERROR_STOP=1'] : []), ...args],
      { env: connection(schema), encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
  };
  const mustRun = (schema: string, args: string[]) => {
    const result = psql(schema, args);
    if (!result.ok) throw new Error(`psql failed: ${result.out.slice(0, 600)}`);
    return result.out;
  };

  /** A scratch schema holding the migrations up to and including `through`, and their ledger. */
  const scratch = (through: string): string => {
    const schema = `rb_${ulid().toLowerCase()}`;
    schemas.push(schema);
    mustRun('public', ['-c', `CREATE SCHEMA "${schema}"`]);
    mustRun(schema, ['-c', 'CREATE TABLE "_prisma_migrations" ("migration_name" text NOT NULL)']);
    for (const name of ALL.slice(0, ALL.indexOf(through) + 1)) {
      mustRun(schema, ['--file', join(MIGRATIONS, name, 'migration.sql')]);
      mustRun(schema, ['-c', `INSERT INTO "_prisma_migrations" VALUES ('${name}')`]);
    }
    return schema;
  };

  /** Everything a down script can change, in one comparable string. */
  const shape = (schema: string): string =>
    mustRun(schema, [
      '-c',
      `SELECT jsonb_build_object(
         'tables', (SELECT jsonb_agg(table_name::text ORDER BY table_name)
                      FROM information_schema.tables WHERE table_schema = current_schema()),
         'columns', (SELECT jsonb_agg(table_name || '.' || column_name || ':' || udt_name
                                      ORDER BY table_name, column_name)
                       FROM information_schema.columns WHERE table_schema = current_schema()),
         'enums', (SELECT jsonb_agg(t.typname || '=' || e.enumlabel ORDER BY t.typname, e.enumsortorder)
                     FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
                     JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = current_schema()),
         'constraints', (SELECT jsonb_agg(conname || ':' || pg_get_constraintdef(c.oid) ORDER BY conname)
                           FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                          WHERE n.nspname = current_schema()),
         'triggers', (SELECT jsonb_agg(tgname ORDER BY tgname) FROM pg_trigger g
                        JOIN pg_class k ON k.oid = g.tgrelid JOIN pg_namespace n ON n.oid = k.relnamespace
                       WHERE NOT g.tgisinternal AND n.nspname = current_schema()),
         'ledger', (SELECT jsonb_agg(migration_name ORDER BY migration_name) FROM "_prisma_migrations")
       )::text`,
    ]);

  const down = (migration: string) => join(MIGRATIONS, migration, 'down.sql');

  afterAll(() => {
    for (const schema of schemas) {
      psql('public', ['-c', `DROP SCHEMA IF EXISTS "${schema}" CASCADE`]);
    }
  });

  it.each([SIGN_CANCEL, SIGNING_POLICY, SUSPENSION, REVIEW, VERSION, AMENDMENTS])(
    '%s is one transaction: it opens with BEGIN and closes with COMMIT, the lock and the check inside',
    (migration) => {
      const statements = readFileSync(down(migration), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('--'));
      expect(statements[0]).toBe('BEGIN;');
      expect(statements[statements.length - 1]).toBe('COMMIT;');
      const text = statements.join('\n');
      expect(text.indexOf('BEGIN;')).toBeLessThan(text.indexOf('LOCK TABLE'));
      expect(text.indexOf('LOCK TABLE')).toBeLessThan(text.indexOf('RAISE EXCEPTION'));
      expect(text.indexOf('RAISE EXCEPTION')).toBeLessThan(text.indexOf('COMMIT;'));
    },
  );

  const policyRow = `INSERT INTO "approval_policy"
      ("id", "organization_id", "author_organization_id", "author_role", "workflow_key",
       "policy_version", "label", "rationale", "created_at", "created_by", "created_correlation_id")
    VALUES ('APL_rb', 'ORG_E', 'ORG_U', 'UNION_ADMIN', 'contract.signature', 1, 'l', 'r',
            now(), 'USR_1', 'COR_1')`;

  it('policy_suspension: over a suspended policy it refuses and changes nothing — with ON_ERROR_STOP and without it; over none it succeeds', () => {
    const schema = scratch(SUSPENSION);
    // DRAFT → PENDING_PLATFORM_APPROVAL → SUSPENDED, the way the system does it.
    mustRun(schema, [
      '-c',
      `${policyRow};
       UPDATE "approval_policy" SET "status" = 'PENDING_PLATFORM_APPROVAL',
              "submitted_at" = now(), "submitted_by" = 'USR_1' WHERE "id" = 'APL_rb';
       UPDATE "approval_policy" SET "status" = 'SUSPENDED', "suspended_at" = now(),
              "suspended_by" = 'system:contract-service', "suspension_reason" = 'ORGANIZATION_MOVED: x'
        WHERE "id" = 'APL_rb'`,
    ]);
    const before = shape(schema);

    for (const stop of [true, false]) {
      const refused = psql(schema, ['--file', down(SUSPENSION)], stop);
      // Without ON_ERROR_STOP psql goes on and exits 0: the file itself must hold the line.
      if (stop) expect(refused.ok).toBe(false);
      expect(refused.out).toMatch(
        /down refused: 1 suspended approval polic\(ies\) and 0 open reconciliation task\(s\) exist/,
      );
      expect(shape(schema)).toBe(before);
    }
    expect(mustRun(schema, ['-c', `SELECT "status"::text FROM "approval_policy"`])).toBe(
      'SUSPENDED',
    );

    // Unused: no suspended policy — the whole file runs and the previous migration is what is left.
    const unused = scratch(SUSPENSION);
    const result = psql(unused, ['--file', down(SUSPENSION)]);
    expect(result.out).toBe('');
    expect(result.ok).toBe(true);
    expect(shape(unused)).toBe(shape(scratch(SIGNING_POLICY)));
  });

  const openTask = `INSERT INTO "policy_reconciliation_task"
      ("id", "organization_id", "policy_id", "union_id", "source_event_id",
       "moved_organization_id", "correlation_id", "next_attempt_at", "created_at", "updated_at")
    VALUES ('PRT_rb', 'ORG_E', 'APL_rb', 'ORG_U', 'EVT_1', 'ORG_E', 'COR_1', now(), now(), now())`;

  const contractRow = `INSERT INTO "contract"
      ("id", "organization_id", "tender_id", "project_id", "winning_bid_id",
       "contractor_organization_id", "amount_minor", "matrix_digest", "awarded_by", "awarded_at",
       "status_changed_at", "status_changed_by", "source_event_id", "created_at", "created_by",
       "created_correlation_id", "updated_at")
    VALUES ('CTR_rb', 'ORG_E', 'TND_1', 'PRJ_1', 'BID_1', 'ORG_C', 1, repeat('a', 64), 'USR_1',
            now(), now(), 'system', 'EVT_1', now(), 'system', 'COR_1', now())`;

  // An employer signature with its hierarchy evidence. The signing guard (which judges the policy
  // in force) is lifted for this one insert in the scratch schema, which the owner may do.
  const evidencedSignature = `ALTER TABLE "contract_signature" DISABLE TRIGGER "tg_contract_signature_insert";
    INSERT INTO "contract_signature"
      ("id", "organization_id", "contract_id", "side", "signer_organization_id", "signed_by",
       "signed_by_issuer", "signed_by_subject", "authority_role", "signed_at", "correlation_id",
       "policy_id", "policy_version", "hierarchy_author_organization_id", "hierarchy_answer",
       "hierarchy_read_at", "hierarchy_commit_deadline")
    VALUES ('CSG_rb', 'ORG_E', 'CTR_rb', 'EMPLOYER', 'ORG_E', 'USR_2', 'iss', 'sub',
            'ORGANIZATION_ADMIN', now(), 'COR_2', 'APL_rb', 1, 'ORG_U', 'WITHIN', now(),
            now() + interval '13 seconds');
    ALTER TABLE "contract_signature" ENABLE TRIGGER "tg_contract_signature_insert"`;

  const review = `INSERT INTO "signature_authority_review"
      ("id", "organization_id", "contract_id", "side", "policy_id", "reason", "cause_event_id",
       "moved_at", "flagged_at")
    VALUES ('SAR_rb', 'ORG_E', 'CTR_rb', 'EMPLOYER', 'APL_rb', 'AUTHORITY_CHANGED_DURING_SIGNING',
            'EVT_1', now(), now())`;

  it('policy_suspension: an open reconciliation task alone refuses it (review round 3): nothing changes, with ON_ERROR_STOP and without it', () => {
    const schema = scratch(SUSPENSION);
    mustRun(schema, ['-c', `${policyRow}; ${openTask}`]);
    const before = shape(schema);
    for (const stop of [true, false]) {
      const refused = psql(schema, ['--file', down(SUSPENSION)], stop);
      if (stop) expect(refused.ok).toBe(false);
      expect(refused.out).toMatch(
        /down refused: 0 suspended approval polic\(ies\) and 1 open reconciliation task\(s\) exist/,
      );
      expect(shape(schema)).toBe(before);
    }
    expect(mustRun(schema, ['-c', `SELECT count(*) FROM "policy_reconciliation_task"`])).toBe('1');

    // Once the task is finished the same file succeeds: DONE work is history, not work to lose.
    mustRun(schema, [
      '-c',
      `UPDATE "policy_reconciliation_task" SET "status" = 'DONE', "done_at" = now() WHERE "id" = 'PRT_rb'`,
    ]);
    const result = psql(schema, ['--file', down(SUSPENSION)]);
    expect(result.out).toBe('');
    expect(result.ok).toBe(true);
  });

  it.each([
    [
      'an open reconciliation task',
      `${policyRow}; ${openTask}`,
      /0 authority review\(s\), 0 signature\(s\) with hierarchy evidence and 1 open reconciliation task\(s\)/,
    ],
    [
      'a signature with hierarchy evidence',
      `${policyRow}; ${contractRow}; ${evidencedSignature}`,
      /0 authority review\(s\), 1 signature\(s\) with hierarchy evidence and 0 open reconciliation task\(s\)/,
    ],
    [
      'an authority review',
      `${policyRow}; ${contractRow}; ${evidencedSignature}; ${review}`,
      /1 authority review\(s\), 1 signature\(s\) with hierarchy evidence and 0 open reconciliation task\(s\)/,
    ],
  ])(
    'signature_authority_review: over %s it refuses and changes nothing, with ON_ERROR_STOP and without it; over none it succeeds',
    (_what, populate, message) => {
      const schema = scratch(REVIEW);
      mustRun(schema, ['-c', populate]);
      const before = shape(schema);
      for (const stop of [true, false]) {
        const refused = psql(schema, ['--file', down(REVIEW)], stop);
        if (stop) expect(refused.ok).toBe(false);
        expect(refused.out).toMatch(message);
        expect(shape(schema)).toBe(before);
      }

      const unused = scratch(REVIEW);
      const result = psql(unused, ['--file', down(REVIEW)]);
      expect(result.out).toBe('');
      expect(result.ok).toBe(true);
      expect(shape(unused)).toBe(shape(scratch(SUSPENSION)));
    },
  );

  // The hierarchy version of review round 4: the same signature, version recorded.
  const versionedSignature = evidencedSignature
    .replace('"hierarchy_commit_deadline")', '"hierarchy_commit_deadline", "hierarchy_version")')
    .replace("now() + interval '13 seconds')", "now() + interval '13 seconds', 4)");
  const versionedReview = review
    .replace(
      '"moved_at", "flagged_at")',
      '"moved_at", "flagged_at", "moved_version", "recorded_version")',
    )
    .replace('now(), now())', 'now(), now(), 5, 4)');
  const versionedTask = openTask
    .replace('"updated_at")', '"updated_at", "moved_version")')
    .replace('now(), now(), now())', 'now(), now(), now(), 5)');

  it.each([
    [
      'a signature that records a hierarchy version',
      `${policyRow}; ${contractRow}; ${versionedSignature}`,
      /1 signature\(s\) record a hierarchy version, 0 review\(s\) record a version and 0 open reconciliation task\(s\)/,
    ],
    [
      'a review that records the versions compared',
      `${policyRow}; ${contractRow}; ${evidencedSignature}; ${versionedReview}`,
      /0 signature\(s\) record a hierarchy version, 1 review\(s\) record a version and 0 open/,
    ],
    [
      'an open task holding a move version',
      `${policyRow}; ${versionedTask}`,
      /0 signature\(s\) record a hierarchy version, 0 review\(s\) record a version and 1 open/,
    ],
  ])(
    'signature_hierarchy_version: over %s it refuses and changes nothing, with ON_ERROR_STOP and without it; over none (and over a signature from before versions) it succeeds',
    (_what, populate, message) => {
      const schema = scratch(VERSION);
      mustRun(schema, ['-c', populate]);
      const before = shape(schema);
      for (const stop of [true, false]) {
        const refused = psql(schema, ['--file', down(VERSION)], stop);
        if (stop) expect(refused.ok).toBe(false);
        expect(refused.out).toMatch(message);
        expect(shape(schema)).toBe(before);
      }

      // Evidence recorded before versions existed carries none: dropping the columns loses nothing.
      const unused = scratch(VERSION);
      mustRun(unused, ['-c', `${policyRow}; ${contractRow}; ${evidencedSignature}`]);
      const result = psql(unused, ['--file', down(VERSION)]);
      expect(result.out).toBe('');
      expect(result.ok).toBe(true);
      const previous = scratch(REVIEW);
      mustRun(previous, ['-c', `${policyRow}; ${contractRow}; ${evidencedSignature}`]);
      expect(shape(unused)).toBe(shape(previous));
    },
  );

  it('signing_policy: over a policy that exists it refuses and changes nothing, with ON_ERROR_STOP and without it; over none it succeeds', () => {
    const schema = scratch(SIGNING_POLICY);
    mustRun(schema, ['-c', policyRow]);
    const before = shape(schema);
    for (const stop of [true, false]) {
      const refused = psql(schema, ['--file', down(SIGNING_POLICY)], stop);
      expect(refused.out).toMatch(/down refused: 1 approval polic\(ies\) and 0 employer signature/);
      expect(shape(schema)).toBe(before);
    }
    expect(mustRun(schema, ['-c', `SELECT count(*) FROM "approval_policy"`])).toBe('1');

    const unused = scratch(SIGNING_POLICY);
    const result = psql(unused, ['--file', down(SIGNING_POLICY)]);
    expect(result.out).toBe('');
    expect(result.ok).toBe(true);
    expect(shape(unused)).toBe(shape(scratch(SIGN_CANCEL)));
  });

  it('contract_sign_cancel: over a signature it refuses and changes nothing, with ON_ERROR_STOP and without it; over none it succeeds', () => {
    const schema = scratch(SIGN_CANCEL);
    mustRun(schema, [
      '-c',
      `INSERT INTO "contract"
         ("id", "organization_id", "tender_id", "project_id", "winning_bid_id",
          "contractor_organization_id", "amount_minor", "matrix_digest", "awarded_by", "awarded_at",
          "status_changed_at", "status_changed_by", "source_event_id", "created_at", "created_by",
          "created_correlation_id", "updated_at")
       VALUES ('CTR_rb', 'ORG_E', 'TND_1', 'PRJ_1', 'BID_1', 'ORG_C', 1, repeat('a', 64), 'USR_1',
               now(), now(), 'system', 'EVT_1', now(), 'system', 'COR_1', now());
       INSERT INTO "contract_signature"
         ("id", "organization_id", "contract_id", "side", "signer_organization_id", "signed_by",
          "signed_by_issuer", "signed_by_subject", "authority_role", "signed_at", "correlation_id")
       VALUES ('CSG_rb', 'ORG_E', 'CTR_rb', 'CONTRACTOR', 'ORG_C', 'USR_2', 'iss', 'sub',
               'CONTRACTOR', now(), 'COR_2')`,
    ]);
    const before = shape(schema);
    for (const stop of [true, false]) {
      const refused = psql(schema, ['--file', down(SIGN_CANCEL)], stop);
      expect(refused.out).toMatch(/down refused: 1 signature\(s\) and 0 signed or cancelled/);
      expect(shape(schema)).toBe(before);
    }
    expect(mustRun(schema, ['-c', `SELECT count(*) FROM "contract_signature"`])).toBe('1');

    const unused = scratch(SIGN_CANCEL);
    const result = psql(unused, ['--file', down(SIGN_CANCEL)]);
    expect(result.out).toBe('');
    expect(result.ok).toBe(true);
  });

  describe('amendments_milestones (CON-003 PR 3)', () => {
    /** A SIGNED contract, inserted whole: the guards fire on update, not on a plain insert. */
    const signedContract = (amendmentsTotal = 0) => `INSERT INTO "contract"
         ("id", "organization_id", "tender_id", "project_id", "winning_bid_id",
          "contractor_organization_id", "amount_minor", "matrix_digest", "awarded_by", "awarded_at",
          "status", "status_changed_at", "status_changed_by", "source_event_id", "created_at",
          "created_by", "created_correlation_id", "updated_at", "amendments_total_minor")
       VALUES ('CTR_rb', 'ORG_E', 'TND_1', 'PRJ_1', 'BID_1', 'ORG_C', 1000, repeat('a', 64), 'USR_1',
               now(), 'SIGNED', now(), 'system', 'EVT_1', now(), 'system', 'COR_1', now(), ${amendmentsTotal})`;
    const milestone = `INSERT INTO "milestone"
         ("id", "organization_id", "contract_id", "title", "planned_date", "created_at", "created_by",
          "created_correlation_id", "updated_at", "updated_by")
       VALUES ('MLS_rb', 'ORG_E', 'CTR_rb', 't', '2026-12-01', now(), 'USR_1', 'COR_1', now(), 'USR_1')`;
    const amendment = `INSERT INTO "amendment"
         ("id", "organization_id", "contract_id", "amendment_number", "delta_minor", "reason_code",
          "reason_text", "proposed_by", "proposed_at", "proposed_correlation_id", "updated_at")
       VALUES ('AMD_rb', 'ORG_E', 'CTR_rb', 1, 5, 'OTHER', 'why', 'USR_1', now(), 'COR_1', now())`;

    it.each([
      [
        'a milestone',
        [signedContract(), milestone],
        /down refused: 0 amendment\(s\), 0 amendment signature\(s\), 0 authority review\(s\), 1 milestone\(s\) and 0 contract/,
      ],
      [
        'an amendment',
        [signedContract(), amendment],
        /down refused: 1 amendment\(s\), 0 amendment signature\(s\), 0 authority review\(s\), 0 milestone\(s\) and 0 contract/,
      ],
      [
        'a non-zero amendments total',
        [signedContract(7)],
        /down refused: 0 amendment\(s\), 0 amendment signature\(s\), 0 authority review\(s\), 0 milestone\(s\) and 1 contract/,
      ],
    ] as const)(
      'over %s it refuses and changes nothing — with ON_ERROR_STOP and without it; over none it succeeds, to the exact previous shape',
      (_what, statements, message) => {
        const schema = scratch(AMENDMENTS);
        for (const statement of statements) mustRun(schema, ['-c', statement]);
        const before = shape(schema);
        for (const stop of [true, false]) {
          const refused = psql(schema, ['--file', down(AMENDMENTS)], stop);
          expect(refused.out).toMatch(message);
          expect(shape(schema)).toBe(before);
        }

        const unused = scratch(AMENDMENTS);
        const result = psql(unused, ['--file', down(AMENDMENTS)]);
        expect(result.out).toBe('');
        expect(result.ok).toBe(true);
        expect(shape(unused)).toBe(shape(scratch(DETECTION)));
      },
    );
  });
});
