import { compareActors, type ActorIdentity } from '@rasta/nest-common';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import {
  DeductionRuleRepository,
  type ChangeActInput,
} from '../src/deduction/deduction-rule.repository';
import {
  DEDUCTION_CHANGE_STATES,
  canTransitionDeductionChange,
} from '../src/deduction/deduction-rule-change.state-machine';
import {
  canonicalDeductionRuleName,
  deductionRuleNameKey,
  isCanonicalDeductionRuleName,
} from '../src/deduction/deduction-rule-name';
import {
  RULE_APPROVER,
  RULE_PROPOSER,
  cleanup,
  newOrganizationId,
  wire,
  type Wiring,
} from './helpers';

/**
 * Four eyes on what is withheld from a contractor's pay (CON-003-1, docs/24 Q-125, D-115). The first
 * describe is raw SQL as the runtime role, so no guard of the application is in the way: what holds
 * here holds whatever the code forgets. The second is the repository the routes will call, on real
 * rows, with the races only PostgreSQL can decide.
 */
describe('deduction rule changes', () => {
  let w: Wiring;
  const organizations: string[] = [];
  const repository = new DeductionRuleRepository();

  beforeAll(() => {
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
  });

  const employer = () => {
    const org = newOrganizationId();
    organizations.push(org);
    return org;
  };
  const uniqueName = () => `Rule ${ulid()}`;

  describe('what PostgreSQL keeps', () => {
    const exec = (sql: string) => w.prisma.client.$executeRawUnsafe(sql);
    const atomically = (...sql: string[]) =>
      w.prisma.client.$transaction(sql.map((one) => w.prisma.client.$executeRawUnsafe(one)));
    const refuses = (promise: Promise<unknown>, pattern: RegExp) =>
      expect(promise).rejects.toThrow(pattern);

    const proposeCreateSql = (
      org: string,
      id: string,
      name = uniqueName(),
      columns: { rate?: number; base?: string; extra?: [string, string] } = {},
    ) => `INSERT INTO deduction_rule_change
        (id, organization_id, kind, name, rate_bp, base, proposed_at, proposed_by,
         proposed_by_issuer, proposed_by_subject${columns.extra ? `, ${columns.extra[0]}` : ''})
      VALUES ('${id}', '${org}', 'CREATE', '${name}', ${columns.rate ?? 500}, '${columns.base ?? 'GROSS'}',
              now(), 'USR_P', 'iss', 'sub-p'${columns.extra ? `, ${columns.extra[1]}` : ''})`;
    const proposeRetireSql = (org: string, id: string, ruleId: string) =>
      `INSERT INTO deduction_rule_change
        (id, organization_id, kind, deduction_rule_id, reason, proposed_at, proposed_by,
         proposed_by_issuer, proposed_by_subject)
      VALUES ('${id}', '${org}', 'RETIRE', '${ruleId}', 'because', now(), 'USR_P', 'iss', 'sub-p')`;
    /** The whole move to `status`: a withdrawal by the proposer, a decision by another person. */
    const moveSql = (
      id: string,
      status: string,
      by: { user?: string; issuer?: string; subject?: string; version?: number } = {},
    ) => {
      const own = status === 'WITHDRAWN';
      return `UPDATE deduction_rule_change
         SET status = '${status}', decided_at = now(), decided_by = '${by.user ?? (own ? 'USR_P' : 'USR_D')}',
             decided_by_issuer = '${by.issuer ?? 'iss'}',
             decided_by_subject = '${by.subject ?? (own ? 'sub-p' : 'sub-d')}',
             decision_reason = ${status === 'REJECTED' ? "'no'" : 'NULL'},
             version = ${by.version ?? 2}
       WHERE id = '${id}'`;
    };
    const ruleSql = (
      org: string,
      id: string,
      change: string | null,
      name: string,
      rate = 500,
      createdBy = 'USR_P',
    ) => `INSERT INTO deduction_rule
        (id, organization_id, name, rate_bp, base, created_at, created_by, approved_change_id)
      VALUES ('${id}', '${org}', '${name}', ${rate}, 'GROSS', now(), '${createdBy}',
              ${change === null ? 'NULL' : `'${change}'`})`;
    /** A rule in force, from a change decided the legal way. */
    const ruleInForce = async (org: string) => {
      const change = `DRC_${ulid()}`;
      const id = `DDR_${ulid()}`;
      const name = uniqueName();
      await atomically(
        proposeCreateSql(org, change, name),
        moveSql(change, 'APPROVED'),
        ruleSql(org, id, change, name),
      );
      return { id, change, name };
    };
    const count = async (sql: string) => {
      const [row] = await w.prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${sql}`,
      );
      return row!.n;
    };

    it('walks every (from, to) on the real trigger: exactly the state machine’s moves pass', async () => {
      const org = employer();
      for (const from of DEDUCTION_CHANGE_STATES) {
        for (const to of DEDUCTION_CHANGE_STATES) {
          // A row in `from`, reached the legal way, with its rule where it was approved.
          const id = `DRC_${ulid()}`;
          const name = uniqueName();
          const steps = [proposeCreateSql(org, id, name)];
          if (from !== 'PENDING_APPROVAL') steps.push(moveSql(id, from));
          if (from === 'APPROVED') steps.push(ruleSql(org, `DDR_${ulid()}`, id, name));
          await atomically(...steps);

          const version = from === 'PENDING_APPROVAL' ? 2 : 3;
          const attempt = [moveSql(id, to, { version })];
          if (to === 'APPROVED') attempt.push(ruleSql(org, `DDR_${ulid()}`, id, name));
          const passed = await atomically(...attempt).then(
            () => true,
            (error: Error) => {
              // PENDING→PENDING and every move out of a decided row: the trigger, by name.
              expect(error.message).toMatch(/ck_deduction_rule_change_transition/);
              return false;
            },
          );
          expect([from, to, passed]).toEqual([from, to, canTransitionDeductionChange(from, to)]);
        }
      }
    });

    it('a change is born PENDING_APPROVAL at version 1, with no decision', async () => {
      const org = employer();
      await refuses(
        exec(
          proposeCreateSql(org, `DRC_${ulid()}`, uniqueName(), { extra: ['status', "'APPROVED'"] }),
        ),
        /ck_deduction_rule_change_born_pending/,
      );
      await refuses(
        exec(proposeCreateSql(org, `DRC_${ulid()}`, uniqueName(), { extra: ['version', '7'] })),
        /ck_deduction_rule_change_born_pending/,
      );
      await refuses(
        exec(
          proposeCreateSql(org, `DRC_${ulid()}`, uniqueName(), { extra: ['decided_at', 'now()'] }),
        ),
        /ck_deduction_rule_change_decision/,
      );
    });

    it('a CREATE says what the rule will be, within the rule’s own limits; a RETIRE names a rule and says why', async () => {
      const org = employer();
      const propose = (name: string, columns: { rate?: number; base?: string } = {}) =>
        exec(proposeCreateSql(org, `DRC_${ulid()}`, name, columns));
      for (const rate of [0, 10_001, -1])
        await refuses(propose(uniqueName(), { rate }), /ck_deduction_rule_change_rate/);
      await refuses(propose(uniqueName(), { base: 'NET' }), /ck_deduction_rule_change_base/);
      for (const name of [
        '',
        '   ',
        ' Tax',
        'Tax ',
        'Two  spaces',
        'a\u202eb',
        'a\u200fb',
        'x'.repeat(201),
        // What reads as "Tax" and would hold a second rule: the key folds A-Z, a space and a half-space only.
        'Tax\u00a0',
        'Tax\t',
        'Tax\n',
        'Tax\u200b',
        'T\u200bax',
        'Tax\u200d',
        'Tax\u200c',
        '\u200cTax',
        'حق\u200c\u200cبیمه',
        'T\u00a0ax',
        'Tax\ufeff',
        'Tax\u00ad',
      ])
        await refuses(propose(name), /ck_deduction_rule_change_name/);
      // The limit is code points, and the zero-width non-joiner Persian needs is no bidi control.
      await propose('ب'.repeat(200));
      await propose('حق‌بیمه');
      await refuses(
        exec(`INSERT INTO deduction_rule_change
                (id, organization_id, kind, proposed_at, proposed_by, proposed_by_issuer, proposed_by_subject)
              VALUES ('DRC_${ulid()}', '${org}', 'CREATE', now(), 'USR_P', 'iss', 'sub-p')`),
        /ck_deduction_rule_change_kind/,
      );
      const { id } = await ruleInForce(org);
      await refuses(
        exec(`INSERT INTO deduction_rule_change
                (id, organization_id, kind, deduction_rule_id, proposed_at, proposed_by, proposed_by_issuer, proposed_by_subject)
              VALUES ('DRC_${ulid()}', '${org}', 'RETIRE', '${id}', now(), 'USR_P', 'iss', 'sub-p')`),
        /ck_deduction_rule_change_kind/,
      );
      await refuses(
        exec(proposeCreateSql(org, `DRC_${ulid()}`, uniqueName(), { extra: ['reason', "'why'"] })),
        /ck_deduction_rule_change_kind/,
      );
      for (const reason of ['  ', '\t\n', '\u00a0', 'a\u202eb', 'x'.repeat(501)]) {
        await refuses(
          exec(`INSERT INTO deduction_rule_change
                  (id, organization_id, kind, deduction_rule_id, reason, proposed_at, proposed_by, proposed_by_issuer, proposed_by_subject)
                VALUES ('DRC_${ulid()}', '${org}', 'RETIRE', '${id}', '${reason}', now(), 'USR_P', 'iss', 'sub-p')`),
          /ck_deduction_rule_change_reason/,
        );
      }
    });

    it('agrees with compareActors on each kind of person: only DISTINCT approves or rejects, only SAME withdraws', async () => {
      const org = employer();
      const proposer: ActorIdentity = { userId: 'USR_P', issuer: 'iss', subject: 'sub-p' };
      const deciders: ActorIdentity[] = [
        { userId: 'USR_D', issuer: 'iss', subject: 'sub-d' }, // another person
        { userId: 'USR_P', issuer: 'iss', subject: 'sub-d' }, // same user id
        { userId: 'USR_D', issuer: 'iss', subject: 'sub-p' }, // same subject
        { userId: 'sub-p', issuer: 'iss', subject: 'sub-d' }, // a user id that is the proposer's subject
        { userId: 'USR_D', issuer: 'iss', subject: 'USR_P' }, // a subject that is the proposer's user id
        { userId: 'USR_D', issuer: 'other-iss', subject: 'sub-d' }, // a subject of another issuer proves nothing
        { userId: 'USR_D', issuer: 'other-iss', subject: 'sub-p' }, // the same subject, another issuer
        { userId: 'USR_D', issuer: 'iss', subject: '\t' }, // blank to `compareActors`, not to btrim
        { userId: 'USR_D', issuer: 'iss', subject: '\u00a0' },
        { userId: 'USR_D', issuer: '\n', subject: 'sub-d' },
        { userId: '\u3000', issuer: 'iss', subject: 'sub-d' },
      ];
      for (const status of ['APPROVED', 'REJECTED', 'WITHDRAWN']) {
        for (const decider of deciders) {
          const id = `DRC_${ulid()}`;
          const name = uniqueName();
          await exec(proposeCreateSql(org, id, name));
          const move = moveSql(id, status, {
            user: decider.userId,
            issuer: decider.issuer!,
            subject: decider.subject!,
          });
          const statements =
            status === 'APPROVED' ? [move, ruleSql(org, `DDR_${ulid()}`, id, name)] : [move];
          const passed = await atomically(...statements).then(
            () => true,
            (error: Error) => {
              expect(error.message).toMatch(
                /ck_deduction_rule_change_(four_eyes|withdrawn_by_proposer|text_not_blank)/,
              );
              return false;
            },
          );
          const blank = [decider.userId, decider.issuer!, decider.subject!].some(
            (value) => value.trim() === '',
          );
          const comparison = compareActors(proposer, decider);
          const expected =
            status === 'WITHDRAWN' ? comparison === 'SAME' : comparison === 'DISTINCT';
          expect([status, decider, passed]).toEqual([status, decider, expected && !blank]);
        }
      }
    });

    it('a proposer is a person too: no blank by the same trim', async () => {
      const org = employer();
      for (const [column, value] of [
        ['proposed_by_subject', '\t'],
        ['proposed_by_issuer', '\u00a0'],
        ['proposed_by', '\n'],
      ] as const) {
        const values = {
          proposed_by: 'USR_P',
          proposed_by_issuer: 'iss',
          proposed_by_subject: 'sub-p',
        };
        values[column] = value;
        await refuses(
          exec(`INSERT INTO deduction_rule_change
                  (id, organization_id, kind, name, rate_bp, base, proposed_at, proposed_by,
                   proposed_by_issuer, proposed_by_subject)
                VALUES ('DRC_${ulid()}', '${org}', 'CREATE', '${uniqueName()}', 1, 'GROSS', now(),
                        '${values.proposed_by}', '${values.proposed_by_issuer}', '${values.proposed_by_subject}')`),
          /ck_deduction_rule_change_text_not_blank/,
        );
      }
    });

    it('a decision is complete: nobody decides anonymously, and a rejection says why', async () => {
      const org = employer();
      const id = `DRC_${ulid()}`;
      await exec(proposeCreateSql(org, id));
      await refuses(
        exec(
          `UPDATE deduction_rule_change SET status = 'WITHDRAWN', version = 2 WHERE id = '${id}'`,
        ),
        /ck_deduction_rule_change_decision/,
      );
      await refuses(
        exec(`UPDATE deduction_rule_change
                 SET status = 'REJECTED', decided_at = now(), decided_by = 'USR_D', decided_by_issuer = 'iss',
                     decided_by_subject = 'sub-d', version = 2
               WHERE id = '${id}'`),
        /ck_deduction_rule_change_reason/,
      );
      await refuses(
        exec(`UPDATE deduction_rule_change
                 SET status = 'WITHDRAWN', decided_at = now(), decided_by = 'USR_P', decided_by_issuer = 'iss',
                     decided_by_subject = 'sub-p', decision_reason = 'x', version = 2
               WHERE id = '${id}'`),
        /ck_deduction_rule_change_reason/,
      );
    });

    it('what was proposed never changes, a move takes the version up by exactly one, and nothing is erased', async () => {
      const org = employer();
      const id = `DRC_${ulid()}`;
      await exec(proposeCreateSql(org, id));
      for (const edit of [
        'rate_bp = 1',
        "name = 'Other'",
        "id = 'DRC_OTHER'",
        "kind = 'RETIRE'",
        "reason = 'why'",
        "deduction_rule_id = 'DDR_OTHER'",
        "base = 'NET'",
        "organization_id = 'ORG_OTHER'",
        "proposed_by = 'USR_D'",
        "proposed_by_subject = 'sub-d'",
        "proposed_by_issuer = 'other'",
        "proposed_at = now() + interval '1 day'",
      ]) {
        await refuses(
          exec(`UPDATE deduction_rule_change SET ${edit} WHERE id = '${id}'`),
          /ck_deduction_rule_change_immutable/,
        );
      }
      for (const version of [1, 3, 99]) {
        await refuses(
          exec(moveSql(id, 'WITHDRAWN', { version })),
          /ck_deduction_rule_change_version_step/,
        );
      }
      await refuses(
        exec(`DELETE FROM deduction_rule_change WHERE id = '${id}'`),
        /ck_deduction_rule_change_not_erasable/,
      );
      await refuses(
        exec('TRUNCATE deduction_rule_change'),
        /ck_deduction_rule_change_not_erasable|permission denied/,
      );

      // After the decision, not one of its fields can be rewritten.
      await exec(moveSql(id, 'REJECTED'));
      for (const edit of [
        "decided_by = 'USR_X', version = 3",
        "decision_reason = 'rewritten', version = 3",
        "decided_at = now() + interval '1 day', version = 3",
      ]) {
        await refuses(
          exec(`UPDATE deduction_rule_change SET ${edit} WHERE id = '${id}'`),
          /ck_deduction_rule_change_transition/,
        );
      }
    });

    describe('the one form of a name, and the one key they are compared by (#677 r1 F1)', () => {
      const LAST_CODE_POINT = 0x10ffff;
      const isSurrogate = (cp: number) => cp >= 0xd800 && cp <= 0xdfff;
      const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;

      it.each([
        ['alone', '', ''],
        ['inside Latin', 'T', 'x'],
        ['between Persian letters', 'ب', 'ب'],
        ['after heh', 'ه', 'ب'],
      ])(
        'the application and PostgreSQL accept exactly the same code points %s',
        async (_where, before, after) => {
          const [row] = await w.prisma.client.$queryRawUnsafe<{ accepted: number[] }[]>(
            `SELECT array_agg(cp ORDER BY cp) AS accepted
               FROM generate_series(1, ${LAST_CODE_POINT}) cp
              WHERE cp NOT BETWEEN 55296 AND 57343
                AND deduction_rule_name_is_canonical(${quoted(before)} || chr(cp) || ${quoted(after)})`,
          );
          const accepted: number[] = [];
          for (let cp = 1; cp <= LAST_CODE_POINT; cp += 1) {
            if (isSurrogate(cp)) continue;
            const candidate = `${before}${String.fromCodePoint(cp)}${after}`;
            if (isCanonicalDeductionRuleName(candidate)) accepted.push(cp);
          }
          expect(accepted.length).toBeGreaterThan(90);
          expect(row!.accepted).toEqual(accepted);
        },
        120_000,
      );

      // One digest of every key, so the 1,112,063 results need not cross the wire to be compared.
      it.each([
        ['alone', '', ''],
        ['inside Latin', 'T', 'x'],
        ['between Persian letters', 'ب', 'ب'],
        ['after heh', 'ه', 'ب'],
        ['beside blanks and capitals', 'A ', '\u200cZ'],
      ])(
        'the application and PostgreSQL give the same key for every code point %s',
        async (_where, before, after) => {
          const [row] = await w.prisma.client.$queryRawUnsafe<{ digest: string }[]>(
            `SELECT md5(string_agg(deduction_rule_name_key(${quoted(before)} || chr(cp) || ${quoted(after)}), E'\n' ORDER BY cp)) AS digest
               FROM generate_series(1, ${LAST_CODE_POINT}) cp
              WHERE cp NOT BETWEEN 55296 AND 57343`,
          );
          const keys: string[] = [];
          for (let cp = 1; cp <= LAST_CODE_POINT; cp += 1) {
            if (isSurrogate(cp)) continue;
            keys.push(deductionRuleNameKey(`${before}${String.fromCodePoint(cp)}${after}`));
          }
          expect(createHash('md5').update(keys.join('\n')).digest('hex')).toBe(row!.digest);
        },
        120_000,
      );

      it.each([
        ['case', 'Tax', 'TAX'],
        ['a space and a half-space', 'حق بیمه', 'حق\u200cبیمه'],
        ['a space and none', 'Tax A', 'taxa'],
      ])(
        'names that differ by %s hold neither a second pending change nor a second rule, in one organization only',
        async (_by, typed, other) => {
          const org = employer();
          const first = `DRC_${ulid()}`;
          const key = /Key \(organization_id, deduction_rule_name_key\(name\)\)/;
          await exec(proposeCreateSql(org, first, typed));
          await refuses(exec(proposeCreateSql(org, `DRC_${ulid()}`, other)), key);
          const rule = `DDR_${ulid()}`;
          await atomically(moveSql(first, 'APPROVED'), ruleSql(org, rule, first, typed));

          const second = `DRC_${ulid()}`;
          await exec(proposeCreateSql(org, second, other));
          await refuses(
            atomically(moveSql(second, 'APPROVED'), ruleSql(org, `DDR_${ulid()}`, second, other)),
            key,
          );
          // Shown as typed, and another employer's rule of the same key is not this one's.
          const [stored] = await w.prisma.client.$queryRawUnsafe<{ name: string }[]>(
            'SELECT name FROM deduction_rule WHERE id = $1',
            rule,
          );
          expect(stored!.name).toBe(typed);
          const another = employer();
          const theirs = `DRC_${ulid()}`;
          await exec(proposeCreateSql(another, theirs, other));
          await atomically(
            moveSql(theirs, 'APPROVED'),
            ruleSql(another, `DDR_${ulid()}`, theirs, other),
          );
        },
      );

      it('the application and PostgreSQL agree on where a blank, a half-space and the mark may stand, and on the limit', async () => {
        const answers: [string, boolean][] = [
          ['', false],
          ['x'.repeat(200), true],
          ['x'.repeat(201), false],
          ['ب'.repeat(200), true],
          ['ب'.repeat(201), false],
          ['a b', true],
          ['a  b', false],
          [' a', false],
          ['a ', false],
          ['ب\u200cب', true],
          ['\u200cب', false],
          ['ب\u200c', false],
          ['ب\u200c\u200cب', false],
          ['ب\u200c ب', false],
          ['ب \u200cب', false],
          ['a\u200cb', false],
          ['1\u200cب', false],
          ['خانه\u0654', true],
          ['خانه\u0654\u200cها', true],
          ['\u0654', false],
          ['ا\u0654', false],
          ['ه\u0654\u0654', false],
        ];
        for (const [candidate, canonical] of answers) {
          const [row] = await w.prisma.client.$queryRawUnsafe<{ canonical: boolean }[]>(
            'SELECT deduction_rule_name_is_canonical($1) AS canonical',
            candidate,
          );
          expect([candidate, row!.canonical]).toEqual([candidate, canonical]);
          expect([candidate, isCanonicalDeductionRuleName(candidate)]).toEqual([
            candidate,
            canonical,
          ]);
        }
      });

      it('a name a person cannot tell from another holds neither a second pending change nor a second rule', async () => {
        const org = employer();
        const proposed = 'حق\u200cبیمه';
        const lookalike = 'حقبیمه';
        const first = `DRC_${ulid()}`;
        await exec(proposeCreateSql(org, first, proposed));
        await refuses(
          exec(proposeCreateSql(org, `DRC_${ulid()}`, lookalike)),
          /Key \(organization_id, deduction_rule_name_key\(name\)\)/,
        );
        await atomically(
          moveSql(first, 'APPROVED'),
          ruleSql(org, `DDR_${ulid()}`, first, proposed),
        );

        // While that rule is in force, the other spelling may wait but never stands beside it.
        const second = `DRC_${ulid()}`;
        await exec(proposeCreateSql(org, second, lookalike));
        await refuses(
          atomically(moveSql(second, 'APPROVED'), ruleSql(org, `DDR_${ulid()}`, second, lookalike)),
          /Key \(organization_id, deduction_rule_name_key\(name\)\)/,
        );
      });

      it('what the review found accepted is refused by the column, in every range it swept', async () => {
        const org = employer();
        // prettier-ignore
        const swept = [0x34f, 0x115f, 0x17b4, 0x180b, 0x2065, 0x3164, 0xfe0e, 0xfe0f, 0xffa0, 0xfff0,
          0x1bca0, 0x1d173, 0xe0061, 0xe0100];
        for (const cp of swept) {
          await refuses(
            exec(proposeCreateSql(org, `DRC_${ulid()}`, `Tax${String.fromCodePoint(cp)}`)),
            /ck_deduction_rule_change_name/,
          );
        }
        await refuses(
          exec(proposeCreateSql(org, `DRC_${ulid()}`, 'T\u200cax')),
          /ck_deduction_rule_change_name/,
        );
      });
    });

    it('one pending CREATE per (organization, name), one pending RETIRE per rule; another organization or a decided change does not count', async () => {
      const org = employer();
      const name = uniqueName();
      const first = `DRC_${ulid()}`;
      await exec(proposeCreateSql(org, first, name));
      await refuses(
        exec(proposeCreateSql(org, `DRC_${ulid()}`, name)),
        /Key \(organization_id, deduction_rule_name_key\(name\)\)/,
      );
      await exec(proposeCreateSql(employer(), `DRC_${ulid()}`, name));
      await exec(moveSql(first, 'WITHDRAWN', { user: 'USR_P', subject: 'sub-p' }));
      await exec(proposeCreateSql(org, `DRC_${ulid()}`, name));

      const { id } = await ruleInForce(org);
      const retire = `DRC_${ulid()}`;
      await exec(proposeRetireSql(org, retire, id));
      await refuses(
        exec(proposeRetireSql(org, `DRC_${ulid()}`, id)),
        /Key \(organization_id, deduction_rule_id\)/,
      );
      await exec(moveSql(retire, 'REJECTED'));
      await exec(proposeRetireSql(org, `DRC_${ulid()}`, id));
    });

    it('a rule comes only from an approved CREATE of its own organization that says the same', async () => {
      const org = employer();
      const insertsNothing = async (statements: string[], name: string, pattern: RegExp) => {
        await refuses(atomically(...statements), pattern);
        expect(
          await count(`deduction_rule WHERE organization_id = '${org}' AND name = '${name}'`),
        ).toBe(0);
      };

      // No change at all: the path every raw insert used to take.
      const bare = uniqueName();
      await insertsNothing(
        [ruleSql(org, `DDR_${ulid()}`, null, bare)],
        bare,
        /ck_deduction_rule_approved_change/,
      );

      // A pending change, and a rejected and a withdrawn one decided in this very transaction, so
      // that only the status tells them from an approved one.
      for (const status of [null, 'REJECTED', 'WITHDRAWN']) {
        const id = `DRC_${ulid()}`;
        const name = uniqueName();
        const statements = [proposeCreateSql(org, id, name)];
        if (status !== null) statements.push(moveSql(id, status));
        statements.push(ruleSql(org, `DDR_${ulid()}`, id, name));
        await insertsNothing(statements, name, /ck_deduction_rule_approved_change/);
      }

      // Approved, but the rule says something else: rate, name, or who wrote it.
      for (const wrong of ['rate', 'name', 'author'] as const) {
        const id = `DRC_${ulid()}`;
        const name = uniqueName();
        const ruleName = wrong === 'name' ? uniqueName() : name;
        await insertsNothing(
          [
            proposeCreateSql(org, id, name),
            moveSql(id, 'APPROVED'),
            ruleSql(
              org,
              `DDR_${ulid()}`,
              id,
              ruleName,
              wrong === 'rate' ? 501 : 500,
              wrong === 'author' ? 'USR_D' : 'USR_P',
            ),
          ],
          ruleName,
          /ck_deduction_rule_approved_change/,
        );
      }

      // Born retired: it would leave force with no RETIRE change.
      {
        const id = `DRC_${ulid()}`;
        const name = uniqueName();
        await insertsNothing(
          [
            proposeCreateSql(org, id, name),
            moveSql(id, 'APPROVED'),
            `INSERT INTO deduction_rule
               (id, organization_id, name, rate_bp, base, created_at, created_by, approved_change_id, retired_at)
             VALUES ('DDR_${ulid()}', '${org}', '${name}', 500, 'GROSS', now(), 'USR_P', '${id}', now())`,
          ],
          name,
          /ck_deduction_rule_born_in_force/,
        );
      }

      // Another employer's approved change.
      const elsewhere = employer();
      const foreign = await ruleInForce(elsewhere);
      const stolen = uniqueName();
      await insertsNothing(
        [ruleSql(org, `DDR_${ulid()}`, foreign.change, stolen)],
        stolen,
        /ck_deduction_rule_approved_change/,
      );

      // One change, one rule, ever: even with the first rule retired in the same transaction, so
      // the name is free and the instants match, its unique index refuses a second rule.
      const once = `DRC_${ulid()}`;
      const first = `DDR_${ulid()}`;
      const retiring = `DRC_${ulid()}`;
      const onceName = uniqueName();
      await insertsNothing(
        [
          proposeCreateSql(org, once, onceName),
          moveSql(once, 'APPROVED'),
          ruleSql(org, first, once, onceName),
          proposeRetireSql(org, retiring, first),
          moveSql(retiring, 'APPROVED'),
          `UPDATE deduction_rule SET retired_at = now() WHERE id = '${first}'`,
          ruleSql(org, `DDR_${ulid()}`, once, onceName),
        ],
        onceName,
        /Key \(organization_id, approved_change_id\)/,
      );
    });

    it('a rule never changes the change it came from', async () => {
      const org = employer();
      const { id } = await ruleInForce(org);
      const other = await ruleInForce(org);
      for (const value of ['NULL', `'${other.change}'`]) {
        await refuses(
          exec(`UPDATE deduction_rule SET approved_change_id = ${value} WHERE id = '${id}'`),
          /ck_deduction_rule_immutable/,
        );
      }
    });

    it('a rule is retired only by an approved RETIRE of that rule, at that decision', async () => {
      const org = employer();
      const { id } = await ruleInForce(org);
      const other = await ruleInForce(org);
      const retiredWithNoChange = `UPDATE deduction_rule SET retired_at = now() WHERE id = '${id}'`;
      await refuses(exec(retiredWithNoChange), /ck_deduction_rule_retire_approved/);

      // Still pending, or rejected.
      const pending = `DRC_${ulid()}`;
      await exec(proposeRetireSql(org, pending, id));
      await refuses(exec(retiredWithNoChange), /ck_deduction_rule_retire_approved/);
      await exec(moveSql(pending, 'REJECTED'));
      await refuses(exec(retiredWithNoChange), /ck_deduction_rule_retire_approved/);

      // Approved for another rule: that rule's approval says nothing of this one.
      const forOther = `DRC_${ulid()}`;
      await refuses(
        atomically(
          proposeRetireSql(org, forOther, other.id),
          moveSql(forOther, 'APPROVED'),
          `UPDATE deduction_rule SET retired_at = now() WHERE id = '${other.id}'`,
          retiredWithNoChange,
        ),
        /ck_deduction_rule_retire_approved/,
      );

      // A different instant from the decision's.
      const late = `DRC_${ulid()}`;
      await refuses(
        atomically(
          proposeRetireSql(org, late, id),
          moveSql(late, 'APPROVED'),
          `UPDATE deduction_rule SET retired_at = now() + interval '1 hour' WHERE id = '${id}'`,
        ),
        /ck_deduction_rule_retire_approved/,
      );
      expect(await count(`deduction_rule WHERE id = '${id}' AND retired_at IS NULL`)).toBe(1);
    });

    it('an approval without its effect does not commit', async () => {
      const org = employer();
      const create = `DRC_${ulid()}`;
      await exec(proposeCreateSql(org, create));
      await refuses(exec(moveSql(create, 'APPROVED')), /ck_deduction_rule_change_effect/);
      const { id } = await ruleInForce(org);
      const retire = `DRC_${ulid()}`;
      await exec(proposeRetireSql(org, retire, id));
      await refuses(exec(moveSql(retire, 'APPROVED')), /ck_deduction_rule_change_effect/);
      expect(
        await count(
          `deduction_rule_change WHERE id IN ('${create}', '${retire}') AND status = 'PENDING_APPROVAL'`,
        ),
      ).toBe(2);
    });

    it('a RETIRE names a rule of this organization in force: not another’s, not a retired one', async () => {
      const org = employer();
      const foreign = await ruleInForce(employer());
      await refuses(
        exec(proposeRetireSql(org, `DRC_${ulid()}`, foreign.id)),
        /ck_deduction_rule_change_rule_in_force/,
      );
      await refuses(
        exec(proposeRetireSql(org, `DRC_${ulid()}`, `DDR_${ulid()}`)),
        /ck_deduction_rule_change_rule_in_force/,
      );
      const { id } = await ruleInForce(org);
      const change = `DRC_${ulid()}`;
      await atomically(
        proposeRetireSql(org, change, id),
        moveSql(change, 'APPROVED'),
        `UPDATE deduction_rule SET retired_at = now() WHERE id = '${id}'`,
      );
      await refuses(
        exec(proposeRetireSql(org, `DRC_${ulid()}`, id)),
        /ck_deduction_rule_change_rule_in_force/,
      );
    });
  });

  describe('the repository, on real rows', () => {
    const at = () => new Date();
    const proposeCreate = (organizationId: string, name = uniqueName(), rateBp = 500) =>
      w.prisma.transaction((tx) =>
        repository.proposeCreate(tx, {
          organizationId,
          name,
          rateBp,
          base: 'GROSS',
          proposer: RULE_PROPOSER,
          at: at(),
        }),
      );
    const proposeRetire = (organizationId: string, deductionRuleId: string) =>
      w.prisma.transaction((tx) =>
        repository.proposeRetire(tx, {
          organizationId,
          deductionRuleId,
          reason: 'no longer owed',
          proposer: RULE_PROPOSER,
          at: at(),
        }),
      );
    const act = (
      change: { organizationId: string; id: string; version: number },
      actor: ActorIdentity = RULE_APPROVER,
    ): ChangeActInput => ({
      organizationId: change.organizationId,
      changeId: change.id,
      expectedVersion: change.version,
      actor,
      at: at(),
    });
    const approve = (input: ChangeActInput) =>
      w.prisma.transaction((tx) => repository.approve(tx, input));
    const rulesNamed = (organizationId: string, name: string) =>
      w.prisma.client.$queryRawUnsafe<
        { id: string; retired_at: Date | null; approved_change_id: string }[]
      >(
        'SELECT id, retired_at, approved_change_id FROM deduction_rule WHERE organization_id = $1 AND name = $2',
        organizationId,
        name,
      );
    const statusOf = async (change: { organizationId: string; id: string }) =>
      (await repository.findChange(w.prisma.client, change.organizationId, change.id))?.status;
    const inForce = async (organizationId: string, name = uniqueName()) => {
      const change = await proposeCreate(organizationId, name);
      const { rule } = await approve(act(change));
      return rule;
    };

    it('approving a CREATE inserts exactly one rule: what the change says, naming the change', async () => {
      const org = employer();
      const name = uniqueName();
      const change = await proposeCreate(org, name, 750);
      expect(change).toMatchObject({ status: 'PENDING_APPROVAL', version: 1, kind: 'CREATE' });
      expect(change.id).toMatch(/^DRC_/);
      // Proposed is not in force.
      expect(await rulesNamed(org, name)).toEqual([]);

      const { change: decided, rule } = await approve(act(change));
      expect(decided).toMatchObject({
        status: 'APPROVED',
        version: 2,
        decidedBy: RULE_APPROVER.userId,
        decidedByIssuer: RULE_APPROVER.issuer,
        decidedBySubject: RULE_APPROVER.subject,
        decisionReason: null,
      });
      expect(rule).toMatchObject({
        organizationId: org,
        name,
        rateBp: 750,
        base: 'GROSS',
        createdBy: RULE_PROPOSER.userId,
        approvedChangeId: change.id,
        retiredAt: null,
      });
      expect(rule.createdAt).toEqual(decided.decidedAt);
      expect(await rulesNamed(org, name)).toHaveLength(1);
    });

    it('approving a RETIRE retires the rule once, at the decision, and leaves other rules in force', async () => {
      const org = employer();
      const rule = await inForce(org);
      const bystander = await inForce(org);
      const change = await proposeRetire(org, rule.id);
      expect(change).toMatchObject({
        kind: 'RETIRE',
        deductionRuleId: rule.id,
        reason: 'no longer owed',
      });
      const stillInForce = await rulesNamed(org, rule.name);
      expect(stillInForce[0]!.retired_at).toBeNull();

      const { change: decided, rule: retired } = await approve(act(change));
      expect(retired.retiredAt).toEqual(decided.decidedAt);
      expect((await rulesNamed(org, bystander.name))[0]!.retired_at).toBeNull();

      // Once: approving again, and proposing again, are both refused and move nothing.
      await expect(approve(act(decided))).rejects.toThrow(/cannot move from APPROVED to APPROVED/);
      await expect(proposeRetire(org, rule.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await rulesNamed(org, rule.name))[0]!.retired_at).toEqual(retired.retiredAt);
    });

    it('the proposer cannot approve or reject, whichever token they hold; they can withdraw', async () => {
      const org = employer();
      const change = await proposeCreate(org);
      const name = change.name!;
      const samePerson: ActorIdentity[] = [
        RULE_PROPOSER,
        { ...RULE_PROPOSER, userId: 'USR-SECOND-ID' }, // two user ids, one subject (#188)
        { ...RULE_PROPOSER, subject: 'sub-renamed' }, // one user id
      ];
      for (const actor of samePerson) {
        await expect(approve(act(change, actor))).rejects.toThrow(/Separation of duties/);
        await expect(
          w.prisma.transaction((tx) =>
            repository.reject(tx, { ...act(change, actor), reason: 'no' }),
          ),
        ).rejects.toThrow(/Separation of duties/);
      }
      // Not provably someone else: refused too (`compareActors` UNKNOWN), with nothing written.
      for (const actor of [
        { ...RULE_APPROVER, issuer: 'iss-other' },
        { ...RULE_APPROVER, issuer: null, subject: null },
      ]) {
        await expect(approve(act(change, actor))).rejects.toMatchObject({
          code: 'ACTOR_IDENTITY_UNKNOWN',
        });
      }
      expect(await statusOf(change)).toBe('PENDING_APPROVAL');
      expect(await rulesNamed(org, name)).toEqual([]);

      for (const actor of [RULE_APPROVER, { ...RULE_APPROVER, issuer: 'iss-other' }]) {
        await expect(
          w.prisma.transaction((tx) => repository.withdraw(tx, act(change, actor))),
        ).rejects.toThrow(/Only the person who proposed/);
      }
      expect(await statusOf(change)).toBe('PENDING_APPROVAL');

      const withdrawn = await w.prisma.transaction((tx) =>
        repository.withdraw(tx, act(change, RULE_PROPOSER)),
      );
      expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', decidedBy: RULE_PROPOSER.userId });
      await expect(approve(act(withdrawn))).rejects.toThrow(
        /cannot move from WITHDRAWN to APPROVED/,
      );
      expect(await rulesNamed(org, name)).toEqual([]);
    });

    it('a proposer with no identity, or a blank one, cannot propose at all', async () => {
      const org = employer();
      for (const proposer of [
        { userId: 'USR_X', issuer: null, subject: null },
        { userId: 'USR_X', issuer: 'iss-itest', subject: '\t' },
        { userId: '\u00a0', issuer: 'iss-itest', subject: 'sub-x' },
      ]) {
        await expect(
          w.prisma.transaction((tx) =>
            repository.proposeCreate(tx, {
              organizationId: org,
              name: uniqueName(),
              rateBp: 1,
              base: 'GROSS',
              proposer,
              at: at(),
            }),
          ),
        ).rejects.toMatchObject({ code: 'ACTOR_IDENTITY_UNKNOWN' });
      }
    });

    it('with no organization named it refuses, rather than read across every tenant', async () => {
      const org = employer();
      const change = await proposeCreate(org);
      for (const missing of [undefined, null, '', '  '] as unknown as string[]) {
        await expect(repository.findChange(w.prisma.client, missing, change.id)).rejects.toThrow(
          /without its organization/,
        );
        await expect(approve({ ...act(change), organizationId: missing })).rejects.toThrow(
          /without its organization/,
        );
        await expect(
          w.prisma.transaction((tx) =>
            repository.proposeRetire(tx, {
              organizationId: missing,
              deductionRuleId: `DDR_${ulid()}`,
              reason: 'no',
              proposer: RULE_PROPOSER,
              at: at(),
            }),
          ),
        ).rejects.toThrow(/without its organization/);
      }
      expect(await statusOf(change)).toBe('PENDING_APPROVAL');
    });

    it('a rejection keeps its reason, and changes no rule', async () => {
      const org = employer();
      const rule = await inForce(org);
      const change = await proposeRetire(org, rule.id);
      const rejected = await w.prisma.transaction((tx) =>
        repository.reject(tx, { ...act(change), reason: 'the rule is still owed' }),
      );
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        decisionReason: 'the rule is still owed',
        reason: 'no longer owed',
      });
      expect((await rulesNamed(org, rule.name))[0]!.retired_at).toBeNull();
    });

    it('a stale version is refused: a form issued before a change of state does not act after it', async () => {
      const org = employer();
      const change = await proposeCreate(org);
      await expect(
        approve({ ...act(change), expectedVersion: change.version + 1 }),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(await statusOf(change)).toBe('PENDING_APPROVAL');
    });

    it('another organization’s change or rule is not found, and nothing moves', async () => {
      const org = employer();
      const elsewhere = employer();
      const change = await proposeCreate(org);
      await expect(approve({ ...act(change), organizationId: elsewhere })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      for (const refused of [
        (tx: Parameters<typeof repository.withdraw>[0]) =>
          repository.withdraw(tx, { ...act(change), organizationId: elsewhere }),
        (tx: Parameters<typeof repository.withdraw>[0]) =>
          repository.reject(tx, { ...act(change), organizationId: elsewhere, reason: 'no' }),
      ]) {
        await expect(w.prisma.transaction(refused)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(await repository.findChange(w.prisma.client, elsewhere, change.id)).toBeNull();
      expect(await statusOf(change)).toBe('PENDING_APPROVAL');

      const theirs = await inForce(org);
      await expect(proposeRetire(elsewhere, theirs.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(proposeRetire(org, `DDR_${ulid()}`)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('a second pending change of the same thing is a conflict, in words that do not depend on the driver', async () => {
      const org = employer();
      const name = uniqueName();
      await proposeCreate(org, name);
      await expect(proposeCreate(org, name)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      const rule = await inForce(org);
      await proposeRetire(org, rule.id);
      await expect(proposeRetire(org, rule.id)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    });

    it('stores a name in its one form, and refuses one that has none before writing anything', async () => {
      const org = employer();
      const change = await proposeCreate(org, ' مالي\u0640ات  ك۱۰\r\n');
      expect(change.name).toBe('مالیات ک10');
      expect(change.name).toBe(canonicalDeductionRuleName(change.name!));

      for (const name of ['Tax\u034f', 'T\u200cax', 'Tax\u{e0061}', 'a\u202eb', '', '  ']) {
        await expect(proposeCreate(org, name)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      const [held] = await w.prisma.client.$queryRawUnsafe<{ n: number }[]>(
        'SELECT count(*)::int AS n FROM deduction_rule_change WHERE organization_id = $1',
        org,
      );
      expect(held!.n).toBe(1);
    });

    it('two spellings of one name are a conflict, in words that do not depend on the driver, while pending and once in force', async () => {
      const org = employer();
      const spelled = 'حق\u200cبیمه';
      const change = await proposeCreate(org, spelled);
      // The same name from another keyboard, and with the half-space left out.
      await expect(proposeCreate(org, 'حقبیمه')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await expect(proposeCreate(org, 'حق\u200cبيمه')).rejects.toMatchObject({
        code: 'ALREADY_EXISTS',
      });
      await approve(act(change));

      const other = await proposeCreate(org, 'حقبیمه');
      await expect(approve(act(other))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(await statusOf(other)).toBe('PENDING_APPROVAL');
    });

    it('a name another case of one in force is told apart by nothing: a conflict, then free once that rule is retired, and each stays as typed', async () => {
      const org = employer();
      const rule = await inForce(org, 'TAX Rate');
      expect(rule.name).toBe('TAX Rate');
      const waiting = await proposeCreate(org, 'tax rate');
      expect(waiting.name).toBe('tax rate');
      await expect(proposeCreate(org, 'Tax  Rate')).rejects.toMatchObject({
        code: 'ALREADY_EXISTS',
      });
      await expect(approve(act(waiting))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await approve(act(await proposeRetire(org, rule.id)));
      const { rule: next } = await approve(act(waiting));
      expect(next.name).toBe('tax rate');
    });

    it('a CREATE named like a rule in force may wait, but is not approved until that rule is retired, and the refusal changes nothing', async () => {
      const org = employer();
      const name = uniqueName();
      const old = await inForce(org, name);
      const replacement = await proposeCreate(org, name, 900);
      await expect(approve(act(replacement))).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(await statusOf(replacement)).toBe('PENDING_APPROVAL');
      expect(await rulesNamed(org, name)).toHaveLength(1);

      await approve(act(await proposeRetire(org, old.id)));
      const { rule } = await approve(act(replacement));
      expect(rule.rateBp).toBe(900);
      expect(await rulesNamed(org, name)).toHaveLength(2);
    });

    describe('races', () => {
      const THREADS = 6;
      const one = (results: PromiseSettledResult<unknown>[]) => {
        const passed = results.filter((r) => r.status === 'fulfilled');
        const refused = results.filter((r) => r.status === 'rejected');
        expect(passed).toHaveLength(1);
        return refused.map((r) => (r as PromiseRejectedResult).reason as { code?: string });
      };

      it('concurrent approvals of a CREATE: one effect, one rule, and the others are told', async () => {
        const org = employer();
        const change = await proposeCreate(org);
        const results = await Promise.allSettled(
          Array.from({ length: THREADS }, () => approve(act(change))),
        );
        for (const reason of one(results)) {
          expect(['OPTIMISTIC_LOCK_FAILED', 'BUSINESS_RULE_VIOLATION']).toContain(reason.code);
        }
        expect(await rulesNamed(org, change.name!)).toHaveLength(1);
      });

      it('concurrent approvals of a RETIRE: retired once, by the decision that won', async () => {
        const org = employer();
        const rule = await inForce(org);
        const change = await proposeRetire(org, rule.id);
        const results = await Promise.allSettled(
          Array.from({ length: THREADS }, (_, i) =>
            approve({ ...act(change), at: new Date(Date.now() + i * 1000) }),
          ),
        );
        one(results);
        const after = await repository.findChange(w.prisma.client, org, change.id);
        expect((await rulesNamed(org, rule.name))[0]!.retired_at).toEqual(after!.decidedAt);
      });

      it('approve, reject and withdraw at once: exactly one outcome, and a rule only if approve won', async () => {
        const org = employer();
        for (let round = 0; round < 6; round += 1) {
          const change = await proposeCreate(org);
          const results = await Promise.allSettled([
            approve(act(change)),
            w.prisma.transaction((tx) => repository.reject(tx, { ...act(change), reason: 'no' })),
            w.prisma.transaction((tx) => repository.withdraw(tx, act(change, RULE_PROPOSER))),
          ]);
          one(results);
          const rules = await rulesNamed(org, change.name!);
          const status = await statusOf(change);
          expect([status, rules.length]).toEqual([status, status === 'APPROVED' ? 1 : 0]);
          expect(status).not.toBe('PENDING_APPROVAL');
        }
      });

      it('concurrent proposals of one name: one pending change', async () => {
        const org = employer();
        const name = uniqueName();
        const results = await Promise.allSettled(
          Array.from({ length: THREADS }, () => proposeCreate(org, name)),
        );
        for (const reason of one(results)) expect(reason.code).toBe('ALREADY_EXISTS');
      });

      it('a RETIRE proposed while another is approved: the approval wins, the proposal gets a proper refusal, no deadlock, nothing pending on a retired rule', async () => {
        const org = employer();
        for (let round = 0; round < 20; round += 1) {
          const rule = await inForce(org);
          const change = await proposeRetire(org, rule.id);
          const [approval, proposal] = await Promise.allSettled([
            approve(act(change)),
            proposeRetire(org, rule.id),
          ]);
          expect(approval.status).toBe('fulfilled');
          // By the read before the insert, the pending index, or the trigger that waited for the
          // approval to commit. A deadlock would be neither of these two codes.
          expect(proposal.status).toBe('rejected');
          expect(['NOT_FOUND', 'ALREADY_EXISTS']).toContain(
            ((proposal as PromiseRejectedResult).reason as { code?: string }).code,
          );
        }
        const [left] = await w.prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM deduction_rule_change
            WHERE organization_id = $1 AND kind = 'RETIRE' AND status = 'PENDING_APPROVAL'`,
          org,
        );
        expect(left!.n).toBe(0);
      });
    });
  });
});
