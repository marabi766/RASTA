import { evaluatorPeople, type EvaluatorOnRecord } from './evaluator-people';

describe('evaluatorPeople (#188)', () => {
  const ISSUER = 'http://test.invalid/realms/rasta';
  const row = (
    bidId: string,
    evaluatorId: string,
    subject: string | null,
    issuer: string | null = subject === null ? null : ISSUER,
  ): EvaluatorOnRecord => ({
    bidId,
    evaluatorId,
    evaluatorIssuer: issuer,
    evaluatorSubject: subject,
  });

  it('passes distinct people, and one person on different bids', () => {
    expect(
      evaluatorPeople(
        [row('B1', 'U1', 'sub-a'), row('B1', 'U2', 'sub-b'), row('B2', 'U3', 'sub-a')],
        [row('B2', 'U4', 'sub-b')],
      ),
    ).toEqual({ verdict: 'DISTINCT', bidIds: [] });
  });

  it('finds one person counted twice on a bid (SAME)', () => {
    expect(evaluatorPeople([row('B1', 'U1', 'sub-a'), row('B1', 'U2', 'sub-a')], [])).toEqual({
      verdict: 'SAME',
      bidIds: ['B1'],
    });
    // A legacy row whose user id is the subject (a token without rasta_uid) is that person.
    expect(evaluatorPeople([row('B1', 'sub-a', null), row('B1', 'U2', 'sub-a')], [])).toEqual({
      verdict: 'SAME',
      bidIds: ['B1'],
    });
  });

  it('finds a person who stood down under another id but still counts (SAME)', () => {
    expect(evaluatorPeople([row('B1', 'U1', 'sub-a')], [row('B1', 'U2', 'sub-a')])).toEqual({
      verdict: 'SAME',
      bidIds: ['B1'],
    });
  });

  it('cannot tell legacy rows apart (UNKNOWN): two scores, or a score and a recusal', () => {
    expect(evaluatorPeople([row('B1', 'U1', null), row('B1', 'U2', null)], [])).toEqual({
      verdict: 'UNKNOWN',
      bidIds: ['B1'],
    });
    expect(evaluatorPeople([row('B1', 'U1', 'sub-a')], [row('B1', 'U2', null)])).toEqual({
      verdict: 'UNKNOWN',
      bidIds: ['B1'],
    });
    // Another issuer is not proof of another person either.
    expect(
      evaluatorPeople(
        [row('B1', 'U1', 'sub-a'), row('B1', 'U2', 'sub-b', 'http://old.invalid')],
        [],
      ),
    ).toEqual({ verdict: 'UNKNOWN', bidIds: ['B1'] });
  });

  it('ignores a recusal by the same user id (the matrix already leaves those scores out) and SAME wins over UNKNOWN', () => {
    expect(evaluatorPeople([row('B1', 'U1', null)], [row('B1', 'U1', null)])).toEqual({
      verdict: 'DISTINCT',
      bidIds: [],
    });
    expect(
      evaluatorPeople(
        [row('B1', 'U1', null), row('B2', 'U2', 'sub-a'), row('B2', 'U3', 'sub-a')],
        [row('B1', 'U9', null)],
      ),
    ).toEqual({ verdict: 'SAME', bidIds: ['B2'] });
  });
});
