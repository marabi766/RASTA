import { compareActors, type ActorComparison } from '@rasta/nest-common';
import { storedActor } from '../shared/stable-actor';

/** An evaluator of a bid as a row names them: the user id and the stable identity (#188). */
export interface EvaluatorOnRecord {
  bidId: string;
  evaluatorId: string;
  evaluatorIssuer: string | null;
  evaluatorSubject: string | null;
}

/** What completing an evaluation learns about the people behind its evaluator rows. */
export interface EvaluatorPeople {
  /**
   * DISTINCT  every contributing evaluator of each bid is provably another person, and none of
   *           them stood down from that bid under another user id
   * SAME      one person counts twice, or keeps scores they stood down from under another id
   * UNKNOWN   neither can be proven: a row names no identity (older than the record) or another
   *           issuer — never taken for another person
   */
  verdict: ActorComparison;
  /** The bids the verdict is about (ids only), in order. */
  bidIds: string[];
}

/**
 * Whether the evaluators a completed matrix counts are distinct people (#188; PM ruling on #200).
 *
 * The matrix counts evaluators by user id (`buildMatrix`), and one person can hold two. The
 * commands refuse a second claim and a claim after standing down under another id
 * (`EvaluationService.assertOnePerson`), but rows written before the stable identity was recorded
 * were never compared. So completion compares, for each bid, every pair of **contributing**
 * evaluations (complete and not stood down by the same user id) under different user ids, and every
 * contributing evaluation with every recusal of the bid under another user id. SAME wins over
 * UNKNOWN; either refuses the completion.
 */
export function evaluatorPeople(
  contributing: readonly EvaluatorOnRecord[],
  recusals: readonly EvaluatorOnRecord[],
): EvaluatorPeople {
  const person = (row: EvaluatorOnRecord) =>
    storedActor(row.evaluatorId, row.evaluatorIssuer, row.evaluatorSubject);
  const same = new Set<string>();
  const unknown = new Set<string>();
  const judge = (a: EvaluatorOnRecord, b: EvaluatorOnRecord): void => {
    if (a.evaluatorId === b.evaluatorId) return;
    const comparison = compareActors(person(a), person(b));
    if (comparison === 'SAME') same.add(a.bidId);
    else if (comparison === 'UNKNOWN') unknown.add(a.bidId);
  };
  for (const [i, evaluation] of contributing.entries()) {
    for (const other of contributing.slice(i + 1)) {
      if (other.bidId === evaluation.bidId) judge(evaluation, other);
    }
    for (const recusal of recusals) {
      if (recusal.bidId === evaluation.bidId) judge(evaluation, recusal);
    }
  }
  if (same.size > 0) return { verdict: 'SAME', bidIds: [...same].sort() };
  if (unknown.size > 0) return { verdict: 'UNKNOWN', bidIds: [...unknown].sort() };
  return { verdict: 'DISTINCT', bidIds: [] };
}
