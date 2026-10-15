import { ulid } from 'ulid';
import { cleanup, newOrganizationId, wire, type Wiring } from './helpers';

/**
 * What PostgreSQL keeps of statements, whatever the code forgets (CON-003 PR 4, ADR-068 § 5, Q-96):
 * a statement belongs to a SIGNED contract and is born a DRAFT; its gross is the sum of its lines,
 * its deductions the sum of its deductions and `net = gross − deductions ≥ 0` — checked at commit;
 * a deduction is a configured rule in force, at its rate of the gross rounded half up; nothing a
 * statement says ever changes; DRAFT → SUBMITTED is the one move, and it names the submitter's
 * stable identity. Raw SQL as the runtime role, so no guard of the application is in the way.
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
  const statementSql = (
    c: { id: string; org: string },
    id: string,
    totals: { gross: number | string; deductions?: number | string; net?: number | string },
    number = 1,
  ) => {
    const deductions = totals.deductions ?? 0;
    const net = totals.net ?? BigInt(totals.gross) - BigInt(deductions);
    return `INSERT INTO statement
        (id, organization_id, contract_id, statement_number, gross_minor, deductions_minor, net_minor,
         created_at, created_by, created_correlation_id, updated_at)
        VALUES ('${id}', '${c.org}', '${c.id}', ${number}, ${totals.gross}, ${deductions}, ${net},
                now(), 'USR_1', 'COR_1', now())`;
  };
  const lineSql = (
    c: { id: string; org: string },
    statementId: string,
    n: number,
    amount: number,
  ) =>
    `INSERT INTO statement_line (id, organization_id, contract_id, statement_id, line_number, description, amount_minor)
     VALUES ('STL_${ulid()}', '${c.org}', '${c.id}', '${statementId}', ${n}, 'work ${n}', ${amount})`;
  const deductionSql = (
    c: { id: string; org: string },
    statementId: string,
    ruleId: string,
    rateBp: number,
    amount: number,
    name: string,
  ) =>
    `INSERT INTO statement_deduction (id, organization_id, contract_id, statement_id, deduction_rule_id, name, rate_bp, base, amount_minor)
     VALUES ('STD_${ulid()}', '${c.org}', '${c.id}', '${statementId}', '${ruleId}', '${name}', ${rateBp}, 'GROSS', ${amount})`;
  /** A DRAFT statement of `gross` in two lines, committed. */
  const drafted = async (c: { id: string; org: string }, gross = 10, number = 1) => {
    const id = `STM_${ulid()}`;
    await atomically(
      statementSql(c, id, { gross }, number),
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
    // A line added after the fact breaks the sum: refused at its own commit.
    const made = await drafted(c);
    await refuses(exec(lineSql(c, made, 3, 1)), /ck_statement_totals_consistent/);
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

  it('DRAFT → SUBMITTED is the one move, and it names the submitter with issuer and subject', async () => {
    const c = await contract();
    const id = await drafted(c);
    const submit = (identity: string) =>
      exec(`UPDATE statement SET status = 'SUBMITTED', submitted_at = now(), updated_at = now(),
                   version = version + 1, ${identity} WHERE id = '${id}'`);
    await refuses(submit(`submitted_by = 'USR_1'`), /ck_statement_submission/);
    await refuses(
      submit(`submitted_by = 'USR_1', submitted_by_issuer = 'iss'`),
      /ck_statement_submission/,
    );
    await refuses(
      exec(`UPDATE statement SET status = 'APPROVED' WHERE id = '${id}'`),
      /ck_statement_transition/,
    );
    await submit(
      `submitted_by = 'USR_1', submitted_by_issuer = 'iss', submitted_by_subject = 'sub'`,
    );
    for (const to of ['DRAFT', 'TECHNICALLY_APPROVED', 'APPROVED', 'REJECTED']) {
      await refuses(
        exec(`UPDATE statement SET status = '${to}' WHERE id = '${id}'`),
        /ck_statement_transition|ck_statement_submission/,
      );
    }
    // A SUBMITTED statement takes no new part either.
    await refuses(exec(lineSql(c, id, 3, 1)), /ck_statement_part_draft/);
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
