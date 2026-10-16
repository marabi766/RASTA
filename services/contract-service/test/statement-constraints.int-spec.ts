import { ulid } from 'ulid';
import { cleanup, newOrganizationId, wire, type Wiring } from './helpers';

/**
 * What PostgreSQL keeps of statements, whatever the code forgets (CON-003 PR 4, ADR-068 § 5, Q-96):
 * a statement belongs to a SIGNED contract and is born a DRAFT; its gross is the sum of its lines,
 * its deductions the sum of its deductions and `net = gross − deductions ≥ 0`, and it has exactly
 * the lines and deductions it was written with — checked at commit; a deduction is a configured
 * rule in force, at its rate of the gross rounded half up in exact integers; nothing a statement
 * says ever changes; and no move is open yet (submission comes with the approval chains). Raw SQL
 * as the runtime role, so no guard of the application is in the way.
 */
describe('the database keeps the statements and their deductions', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const exec = (sql: string) => w.prisma.client.$executeRawUnsafe(sql);
  /** Several statements in one transaction: the totals are checked when it commits. */
  const atomically = (...sql: string[]) =>
    w.prisma.client.$transaction(
      sql.map((statement) => w.prisma.client.$executeRawUnsafe(statement)),
    );
  const refuses = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
  });

  /** A contract inserted whole, in `status` (the contract's guards fire on update, not on insert). */
  const contract = async (status = 'SIGNED') => {
    const id = `CTR_${ulid()}`;
    const org = newOrganizationId();
    organizations.push(org);
    await exec(`INSERT INTO contract
        (id, organization_id, tender_id, project_id, winning_bid_id, contractor_organization_id,
         amount_minor, matrix_digest, awarded_by, awarded_at, status, status_changed_at,
         status_changed_by, source_event_id, created_at, created_by, created_correlation_id, updated_at)
        VALUES ('${id}', '${org}', 'TND_${ulid()}', 'PRJ_1', 'BID_1', 'ORG_C_${ulid()}', 1000,
                repeat('a', 64), 'USR_1', now(), '${status}', now(), 'system', 'EVT_1', now(),
                'system', 'COR_1', now())`);
    return { id, org };
  };
  const rule = async (org: string, rateBp: number, name = `Rule ${ulid()}`) => {
    const id = `DDR_${ulid()}`;
    await exec(`INSERT INTO deduction_rule (id, organization_id, name, rate_bp, base, created_at, created_by)
                VALUES ('${id}', '${org}', '${name}', ${rateBp}, 'GROSS', now(), 'USR_CONFIG')`);
    return id;
  };
  /**
   * A statement row. `totals.lineCount` and `totals.deductionCount` are the parts it says it is
   * written with: one line and, by default, as many deductions as a non-zero total implies (one).
   */
  const statementSql = (
    c: { id: string; org: string },
    id: string,
    totals: {
      gross: number | string;
      deductions?: number | string;
      net?: number | string;
      lineCount?: number;
      deductionCount?: number;
    },
    number = 1,
  ) => {
    const deductions = totals.deductions ?? 0;
    const net = totals.net ?? BigInt(totals.gross) - BigInt(deductions);
    const lineCount = totals.lineCount ?? 1;
    const deductionCount = totals.deductionCount ?? (BigInt(deductions) > 0n ? 1 : 0);
    return `INSERT INTO statement
        (id, organization_id, contract_id, statement_number, gross_minor, deductions_minor, net_minor,
         line_count, deduction_count, created_at, created_by, created_correlation_id, updated_at)
        VALUES ('${id}', '${c.org}', '${c.id}', ${number}, ${totals.gross}, ${deductions}, ${net},
                ${lineCount}, ${deductionCount}, now(), 'USR_1', 'COR_1', now())`;
  };
  const lineSql = (
    c: { id: string; org: string },
    statementId: string,
    n: number,
    amount: number | string,
  ) =>
    `INSERT INTO statement_line (id, organization_id, contract_id, statement_id, line_number, description, amount_minor)
     VALUES ('STL_${ulid()}', '${c.org}', '${c.id}', '${statementId}', ${n}, 'work ${n}', ${amount})`;
  const deductionSql = (
    c: { id: string; org: string },
    statementId: string,
    ruleId: string,
    rateBp: number,
    amount: number | string,
    name: string,
  ) =>
    `INSERT INTO statement_deduction (id, organization_id, contract_id, statement_id, deduction_rule_id, name, rate_bp, base, amount_minor)
     VALUES ('STD_${ulid()}', '${c.org}', '${c.id}', '${statementId}', '${ruleId}', '${name}', ${rateBp}, 'GROSS', ${amount})`;
  /** A DRAFT statement of `gross` in two lines, committed. */
  const drafted = async (c: { id: string; org: string }, gross = 10, number = 1) => {
    const id = `STM_${ulid()}`;
    await atomically(
      statementSql(c, id, { gross, lineCount: 2 }, number),
      lineSql(c, id, 1, gross - 1),
      lineSql(c, id, 2, 1),
    );
    return id;
  };

  it('a statement of a SIGNED contract commits with its lines; numbers are unique per contract', async () => {
    const c = await contract();
    await drafted(c, 10, 1);
    await drafted(c, 7, 2);
    // `ux_statement_number`, which the driver reports by its key.
    await refuses(drafted(c, 5, 2), /Key \(organization_id, contract_id, statement_number\)/);
  });

  it('belongs to a SIGNED contract and is born a DRAFT', async () => {
    const unsigned = await contract('DRAFT');
    await refuses(drafted(unsigned), /ck_statement_contract_signed/);
    const c = await contract();
    const id = `STM_${ulid()}`;
    await refuses(
      atomically(
        statementSql(c, id, { gross: 5 })
          .replace('(id, organization_id', '(status, id, organization_id')
          .replace(`VALUES ('${id}'`, `VALUES ('SUBMITTED', '${id}'`),
        lineSql(c, id, 1, 5),
      ),
      /ck_statement_born_draft|ck_statement_submission/,
    );
  });

  it('the gross is the sum of its lines and there is a line, checked at commit', async () => {
    const c = await contract();
    const id = `STM_${ulid()}`;
    await refuses(
      atomically(statementSql(c, id, { gross: 9 }), lineSql(c, id, 1, 5)),
      /ck_statement_totals_consistent/,
    );
    await refuses(atomically(statementSql(c, id, { gross: 9 })), /ck_statement_totals_consistent/);
    // No line at all: the count says so too.
    await refuses(
      atomically(statementSql(c, id, { gross: 9, lineCount: 0 })),
      /ck_statement_part_counts/,
    );
    // A line added after the fact breaks the sum: refused at its own commit.
    const made = await drafted(c);
    await refuses(exec(lineSql(c, made, 3, 1)), /ck_statement_totals_consistent/);
  });

  it('a statement has exactly the parts it was written with: a later deduction of 0, which moves no total, is refused (review #301 r1)', async () => {
    const c = await contract();
    // 1 × 0.01% = 0.0001 → 0: a deduction of this rule on this gross is worth nothing.
    const tiny = await rule(c.org, 1, 'Tiny');
    const id = `STM_${ulid()}`;
    await atomically(statementSql(c, id, { gross: 1 }), lineSql(c, id, 1, 1));
    // Every other guard passes — a DRAFT, a rule in force as configured, 0 its half-up amount, the
    // deductions total still 0 — and the count written with the statement does not.
    await refuses(exec(deductionSql(c, id, tiny, 1, 0, 'Tiny')), /ck_statement_totals_consistent/);
    const parts = await w.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM statement_deduction WHERE statement_id = '${id}'`,
    );
    expect(Number(parts[0]!.n)).toBe(0);

    // In the transaction that writes the statement a deduction of 0 is part of it — when the
    // statement says so, and only then.
    const withZero = `STM_${ulid()}`;
    await atomically(
      statementSql(c, withZero, { gross: 1, deductionCount: 1 }, 2),
      lineSql(c, withZero, 1, 1),
      deductionSql(c, withZero, tiny, 1, 0, 'Tiny'),
    );
    const unannounced = `STM_${ulid()}`;
    await refuses(
      atomically(
        statementSql(c, unannounced, { gross: 1 }, 3),
        lineSql(c, unannounced, 1, 1),
        deductionSql(c, unannounced, tiny, 1, 0, 'Tiny'),
      ),
      /ck_statement_totals_consistent/,
    );
    // The counts are what the statement says: never changed.
    await refuses(
      exec(`UPDATE statement SET deduction_count = 2 WHERE id = '${withZero}'`),
      /ck_statement_terms_immutable/,
    );
    await refuses(
      exec(`UPDATE statement SET line_count = 2 WHERE id = '${id}'`),
      /ck_statement_terms_immutable/,
    );
  });

  it('a deduction is computed with exact integer arithmetic: a gross of 20000000000000000 at 10000 bp is all of it, not one more (review #301 r1)', async () => {
    const c = await contract();
    const largest = 9_223_372_036_854_775_807n;
    // The same half-up rule as `applyBasisPoints`, in bigint.
    const halfUp = (gross: bigint, rateBp: number) => (gross * BigInt(rateBp) + 5000n) / 10000n;
    let number = 0;
    for (const [gross, rateBp] of [
      [20_000_000_000_000_000n, 10_000],
      [20_000_000_000_000_000n, 5_000],
      [20_000_000_000_000_001n, 5_000],
      [19_999_999_999_999_999n, 3],
      [largest, 10_000],
      [largest, 5_000],
      [largest, 1],
    ] as const) {
      const name = `Rule ${ulid()}`;
      const r = await rule(c.org, rateBp, name);
      const amount = halfUp(gross, rateBp);
      // A neighbour of the exact amount is refused (one more, or one less where one more would
      // pass the largest bigint) …
      const neighbour = amount < largest ? amount + 1n : amount - 1n;
      number += 1;
      const off = `STM_${ulid()}`;
      await refuses(
        atomically(
          statementSql(c, off, { gross: `${gross}`, deductions: `${neighbour}` }, number),
          lineSql(c, off, 1, `${gross}`),
          deductionSql(c, off, r, rateBp, `${neighbour}`, name),
        ),
        /ck_statement_deduction_amount|ck_statement_amounts/,
      );
      // … and the exact amount, which the service computes, is accepted.
      number += 1;
      const exact = `STM_${ulid()}`;
      await atomically(
        statementSql(c, exact, { gross: `${gross}`, deductions: `${amount}` }, number),
        lineSql(c, exact, 1, `${gross}`),
        deductionSql(c, exact, r, rateBp, `${amount}`, name),
      );
    }
    const zeroNet = await w.prisma.client.$queryRawUnsafe<{ net: bigint }[]>(
      `SELECT s.net_minor AS net FROM statement s JOIN statement_deduction d ON d.statement_id = s.id
        WHERE s.organization_id = '${c.org}' AND s.gross_minor = 20000000000000000 AND d.rate_bp = 10000`,
    );
    expect(zeroNet.map((row) => row.net)).toEqual([0n]);
  });

  it('net = gross − deductions, never negative; a positive gross and positive lines', async () => {
    const c = await contract();
    const id = () => `STM_${ulid()}`;
    const a = id();
    await refuses(
      atomically(statementSql(c, a, { gross: 5, deductions: 0, net: 4 }), lineSql(c, a, 1, 5)),
      /ck_statement_amounts/,
    );
    const b = id();
    await refuses(
      atomically(statementSql(c, b, { gross: 5, deductions: 6 }), lineSql(c, b, 1, 5)),
      /ck_statement_amounts/,
    );
    const z = id();
    await refuses(
      atomically(statementSql(c, z, { gross: 0 }), lineSql(c, z, 1, 0)),
      /ck_statement_amounts|ck_statement_line_terms/,
    );
  });

  it('a deduction is a configured rule in force, as configured, at its rate of the gross rounded half up', async () => {
    const c = await contract();
    const retention = await rule(c.org, 500, 'Retention');
    // 10001 × 5% = 500.05 → 500.
    const ok = `STM_${ulid()}`;
    await atomically(
      statementSql(c, ok, { gross: 10001, deductions: 500 }),
      lineSql(c, ok, 1, 10001),
      deductionSql(c, ok, retention, 500, 500, 'Retention'),
    );
    // 10 × 5% = 0.5 → 1 (half up), never 0.
    const half = `STM_${ulid()}`;
    await refuses(
      atomically(
        statementSql(c, half, { gross: 10, deductions: 0 }, 2),
        lineSql(c, half, 1, 10),
        deductionSql(c, half, retention, 500, 0, 'Retention'),
      ),
      /ck_statement_deduction_amount/,
    );
    // Another rate or name than the rule's.
    for (const [rate, name] of [
      [400, 'Retention'],
      [500, 'Renamed'],
    ] as const) {
      const s = `STM_${ulid()}`;
      await refuses(
        atomically(
          statementSql(c, s, { gross: 10000, deductions: rate * 1 }, 3),
          lineSql(c, s, 1, 10000),
          deductionSql(c, s, retention, rate, rate, name),
        ),
        /ck_statement_deduction_configured/,
      );
    }
    // Another organization's rule: not one of this statement's organization (Q-96 (6)).
    const elsewhere = newOrganizationId();
    organizations.push(elsewhere);
    const foreign = await rule(elsewhere, 500, 'Retention');
    const f = `STM_${ulid()}`;
    await refuses(
      atomically(
        statementSql(c, f, { gross: 10000, deductions: 500 }, 4),
        lineSql(c, f, 1, 10000),
        deductionSql(c, f, foreign, 500, 500, 'Retention'),
      ),
      /statement_deduction_organization_id_deduction_rule_id_fkey|ck_statement_deduction_configured/,
    );
    // A retired rule.
    await exec(`UPDATE deduction_rule SET retired_at = now() WHERE id = '${retention}'`);
    const r = `STM_${ulid()}`;
    await refuses(
      atomically(
        statementSql(c, r, { gross: 10000, deductions: 500 }, 5),
        lineSql(c, r, 1, 10000),
        deductionSql(c, r, retention, 500, 500, 'Retention'),
      ),
      /ck_statement_deduction_configured/,
    );
  });

  it('what a statement says never changes, and nothing of it is ever removed', async () => {
    const c = await contract();
    const id = await drafted(c);
    await refuses(
      exec(`UPDATE statement SET gross_minor = 11, net_minor = 11 WHERE id = '${id}'`),
      /ck_statement_terms_immutable/,
    );
    await refuses(
      exec(`UPDATE statement SET statement_number = 9 WHERE id = '${id}'`),
      /ck_statement_terms_immutable/,
    );
    await refuses(
      exec(`UPDATE statement_line SET amount_minor = 2 WHERE statement_id = '${id}'`),
      /ck_statement_part_immutable/,
    );
    await refuses(
      exec(`DELETE FROM statement_line WHERE statement_id = '${id}'`),
      /ck_statement_part_immutable/,
    );
    await refuses(exec(`DELETE FROM statement WHERE id = '${id}'`), /ck_statement_not_erasable/);
  });

  it('no move is open yet: a DRAFT stays a DRAFT, even submitted with a full stable identity (review #302 r1)', async () => {
    const c = await contract();
    const id = await drafted(c);
    const submit = (identity: string) =>
      exec(`UPDATE statement SET status = 'SUBMITTED', submitted_at = now(), updated_at = now(),
                   version = version + 1, ${identity} WHERE id = '${id}'`);
    // Submission opens with the approval chains and their snapshot (the next change): until then
    // the database refuses it to any writer, whoever it names.
    await refuses(
      submit(`submitted_by = 'USR_1', submitted_by_issuer = 'iss', submitted_by_subject = 'sub'`),
      /ck_statement_transition/,
    );
    await refuses(submit(`submitted_by = 'USR_1'`), /ck_statement_transition/);
    for (const to of ['DRAFT', 'TECHNICALLY_APPROVED', 'APPROVED', 'REJECTED']) {
      await refuses(
        exec(`UPDATE statement SET status = '${to}' WHERE id = '${id}'`),
        /ck_statement_transition/,
      );
    }
    await refuses(
      exec(`UPDATE statement SET updated_at = now(), version = version + 1 WHERE id = '${id}'`),
      /ck_statement_transition/,
    );
    const [row] = await w.prisma.client.$queryRawUnsafe<{ status: string; version: number }[]>(
      `SELECT status::text AS status, version FROM statement WHERE id = '${id}'`,
    );
    expect(row).toEqual({ status: 'DRAFT', version: 1 });
  });

  it('a deduction rule is whole basis points of the gross, one in force per name, never changed or removed — only retired, once', async () => {
    const org = newOrganizationId();
    organizations.push(org);
    const insert = (name: string, rateBp: number, base = 'GROSS') =>
      exec(`INSERT INTO deduction_rule (id, organization_id, name, rate_bp, base, created_at, created_by)
            VALUES ('DDR_${ulid()}', '${org}', '${name}', ${rateBp}, '${base}', now(), 'USR_CONFIG')`);
    for (const rate of [0, 10_001, -1])
      await refuses(insert('Bad rate', rate), /ck_deduction_rule_rate/);
    await refuses(insert('Net based', 100, 'NET'), /ck_deduction_rule_rate/);
    await refuses(insert('  ', 100), /ck_deduction_rule_name/);
    await refuses(insert('a‮b', 100), /ck_deduction_rule_name/);
    const id = await rule(org, 250, 'Tax');
    // `ux_deduction_rule_name_active`, which the driver reports by its key.
    await refuses(insert('Tax', 300), /Key \(organization_id, name\)/);
    await refuses(
      exec(`UPDATE deduction_rule SET rate_bp = 300 WHERE id = '${id}'`),
      /ck_deduction_rule_immutable/,
    );
    await refuses(
      exec(`DELETE FROM deduction_rule WHERE id = '${id}'`),
      /ck_deduction_rule_not_erasable/,
    );
    await exec(`UPDATE deduction_rule SET retired_at = now() WHERE id = '${id}'`);
    await refuses(
      exec(`UPDATE deduction_rule SET retired_at = NULL WHERE id = '${id}'`),
      /ck_deduction_rule_immutable/,
    );
    // Retired, the name is free for the rule that replaces it.
    await insert('Tax', 300);
  });
});
